'use strict';
// ============================================================
// journal.service.js — دفتر معاملات کامل
// ============================================================
const { COLLECTIONS } = require('../config/constants');
let deps = { getDB: null, logger: null };
function init(d) { deps = { ...deps, ...d }; }

async function sync() {
    const db = deps.getDB();
    if (!db) return { created: 0, updated: 0 };

    const positions = await db.collection(COLLECTIONS.OPTION_POSITIONS).find({}).toArray();
    let created = 0, updated = 0;

    for (const p of positions) {
        const pid = String(p._id);
        const existing = await db.collection('trade_journal').findOne({ positionId: pid });

        // config برای گرفتن strategyId
        let cfg = null;
        try {
            const { ObjectId } = require('mongodb');
            cfg = await db.collection(COLLECTIONS.STRATEGY_CONFIGS)
                .findOne({ _id: new ObjectId(p.configId) });
        } catch (_) {}

        if (!existing) {
            const setup = await buildSetup(p, cfg);
            await db.collection('trade_journal').insertOne({
                positionId: pid,
                configId: p.configId,
                symbol: p.underlying,
                strategyId: cfg ? cfg.strategyId : null,
                role: cfg ? cfg.role : null,
                contract: {
                    symbol: p.symbol, strike: p.strike,
                    expiry: p.expiry, size: p.size
                },
                entry: {
                    time: p.entryTime,
                    optionAsk: p.entryAsk, optionBid: p.entryBid,
                    underlyingPrice: p.entryS,
                    iv: p.entryIv, delta: p.entryDelta,
                    positionSize: p.positionSize,
                    value: p.entryValue,
                    level: p.level,
                    scenario: p.scenario || null
                },
                setup,
                exit: p.status === 'closed' ? {
                    time: p.exitTime,
                    optionBid: p.exitBid,
                    underlyingPrice: p.exitS,
                    pnlPct: p.pnlPct,
                    reason: p.exitReason,
                    stagedExits: p.stagedExits || []
                } : null,
                status: p.status,
                contextAfter: null,
                createdAt: new Date()
            });
            created++;
        } else {
            // update if closed and exit missing/different
            if (p.status === 'closed' && (!existing.exit || existing.exit.time !== p.exitTime)) {
                await db.collection('trade_journal').updateOne(
                    { _id: existing._id },
                    { $set: {
                        status: 'closed',
                        exit: {
                            time: p.exitTime,
                            optionBid: p.exitBid,
                            underlyingPrice: p.exitS,
                            pnlPct: p.pnlPct,
                            reason: p.exitReason,
                            stagedExits: p.stagedExits || []
                        }
                    }}
                );
                updated++;
            }
            // context after 7 days
            if (p.status === 'closed' && !existing.contextAfter && p.exitTime) {
                const ctx = await computeContext(p);
                if (ctx) {
                    await db.collection('trade_journal').updateOne(
                        { _id: existing._id },
                        { $set: { contextAfter: ctx, contextAt: new Date() } }
                    );
                    updated++;
                }
            }
        }
    }

    deps.logger && deps.logger.info(`journal.sync: +${created} new, ${updated} updated`);
    return { created, updated };
}

async function buildSetup(p, cfg) {
    const setup = {
        strategyId: cfg ? cfg.strategyId : null,
        timeframe: cfg ? cfg.timeframe : null,
        htfTimeframe: cfg ? cfg.htfTimeframe : null,
        confluence: p.confluence || 1,
        candleType: cfg ? cfg.candleType : 'heikin',
        entryReason: null,
        htfTrend: null
    };

    // تلاش برای گرفتن signal history مرتبط
    try {
        const db = deps.getDB();
        if (p.underlying && p.entryTime) {
            const entryMs = new Date(p.entryTime).getTime();
            const sinceMs = entryMs - 60 * 60 * 1000;  // یک ساعت قبل
            const sig = await db.collection(COLLECTIONS.SIGNAL_HISTORY)
                .findOne({
                    symbol: p.underlying,
                    signalType: 'BUY',
                    createdAt: { $gte: new Date(sinceMs), $lte: new Date(entryMs + 60000) }
                });
            if (sig) {
                setup.entryReason = sig.reason || null;
                setup.htfTrend = sig.htfTrend || null;
                setup.signalScore = sig.signalScore || null;
                setup.confirmers = sig.confirmers || [];
            }
        }
    } catch (_) {}

    return setup;
}

async function computeContext(position) {
    const exitMs = new Date(position.exitTime).getTime();
    if (Date.now() < exitMs + 7 * 86400000) return null;

    const db = deps.getDB();
    const underlying = position.underlying;
    const afterTime = new Date(exitMs + 8 * 86400000);

    const candles = await db.collection(COLLECTIONS.CANDLES_DAILY)
        .find({ symbol: underlying, time: { $gte: new Date(exitMs), $lte: afterTime } })
        .sort({ time: 1 }).toArray();

    if (candles.length < 2) return null;
    const first = candles[0].close;
    const last = candles[candles.length - 1].close;
    const changePct = first > 0 ? (last / first - 1) * 100 : null;

    // option history after exit (for IV)
    let ivAfter = null;
    try {
        const optRow = await db.collection(COLLECTIONS.OPTION_HISTORY)
            .findOne({ symbol: position.symbol, time: { $gte: afterTime } }, { sort: { time: 1 } });
        if (optRow) ivAfter = optRow.ivApi || null;
    } catch (_) {}

    // regime now
    let regimeNow = null;
    try {
        const r = await db.collection(COLLECTIONS.META).findOne({ _id: `regime_${underlying}` });
        if (r) regimeNow = `${r.macro}/${r.vol}`;
    } catch (_) {}

    return {
        underlyingChangePct: changePct != null ? Math.round(changePct * 100) / 100 : null,
        daysObserved: Math.max(1, Math.round((candles[candles.length - 1].time - candles[0].time) / 86400000)),
        ivAfter: ivAfter != null ? Math.round(ivAfter * 1000) / 1000 : null,
        regimeNow,
        computedAt: new Date()
    };
}

module.exports = { init, sync };