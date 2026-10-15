'use strict';
// ============================================================
// paper-trading.service.js — Paper Trading System
// ============================================================
// ثبت خودکار سیگنال‌ها و شبیه‌سازی معاملات آپشن
// ============================================================

const { COLLECTIONS } = require('../config/constants');

let deps = { getDB: null, logger: null, options: null };
function init(d) { deps = { ...deps, ...d }; }

// ─── ثبت سیگنال جدید ───
async function recordSignal(signalData) {
    const db = deps.getDB();
    const doc = {
        type: 'paper_trade',
        // [PAPER-SCHEMA-FIX] top-level fields for query consistency
        underlying: signalData.symbol,
        symbol: null,
        contractSymbol: null,
        signal: {
            symbol: signalData.symbol,
            strategyId: signalData.strategyId,
            signalType: signalData.signalType,
            price: signalData.price,
            time: signalData.time,
            reason: signalData.reason,
            indicators: signalData.indicators,
            htfTrend: signalData.htfTrend,
            regime: signalData.regime || null
        },
        contract: null,
        entry: null,
        exit: null,
        pnl: null,
        status: 'pending',      // pending | open | closed | skipped
        paper: true,
        createdAt: new Date(),
        updatedAt: new Date()
    };

    // اگه BUY بود، قرارداد آپشن رو پیدا کن
    if (signalData.signalType === 'BUY') {
        try {
            // Resolve quality level (from settings)
            const optionType = (signalData.regime && signalData.regime.macro === 'bear') ? 'put' : 'call';
            const chain = await deps.options.fetchChain(60000).catch(() => []);
            const names = deps.options.getNames ? deps.options.getNames(signalData.symbol) : [signalData.symbol];
            const s = deps.options.DEFAULT_SETTINGS || {};
            const scenario = await deps.options.buildScenario(
                { symbol: signalData.symbol, params: signalData.indicators, timeframe: signalData.timeframe || '1h' },
                signalData.price,
                signalData.price,
                signalData.indicators,
                { ...s, rewardRisk: 3 },
                null
            );
            const res = deps.options.selectCalls(chain, names, { ...scenario, optionType }, s);
            if (res.picks && res.picks.length) {
                doc.contract = {
                    symbol: res.picks[0].symbol,
                    strike: res.picks[0].strike,
                    expiry: res.picks[0].expiry,
                    ask: res.picks[0].ask,
                    bid: res.picks[0].bid,
                    delta: res.picks[0].delta,
                    iv: res.picks[0].iv,
                    oi: res.picks[0].oi,
                    daysLeft: res.picks[0].daysLeft
                };
                // [PAPER-SCHEMA-FIX]
                doc.symbol = res.picks[0].symbol;
                doc.contractSymbol = res.picks[0].symbol;
                doc.entry = {
                    time: new Date(),
                    underlyingPrice: signalData.price,
                    optionAsk: res.picks[0].ask,
                    optionBid: res.picks[0].bid,
                    positionSize: 1
                };
                doc.status = 'open';
                deps.logger && deps.logger.info(`[paper] OPEN: ${signalData.symbol} ${res.picks[0].symbol} ask=${res.picks[0].ask}`);
            } else {
                doc.status = 'skipped';
                doc.skipReason = 'no contract matched';
            }
        } catch (e) {
            doc.status = 'skipped';
            doc.skipReason = e.message;
            deps.logger && deps.logger.warn(`[paper] contract selection failed: ${e.message}`);
        }
    }

    // اگه EXIT_LONG بود، پوزیشن باز رو ببند
    if (signalData.signalType === 'EXIT_LONG') {
        // [PAPER-SCHEMA-FIX] query by underlying (new) OR signal.symbol (old schema)
        const open = await db.collection(COLLECTIONS.OPTION_POSITIONS).findOne({
            $or: [
                { underlying: signalData.symbol, status: 'open', paper: true },
                { 'signal.symbol': signalData.symbol, status: 'open', paper: true }
            ]
        });
        // Stage 11.6: skip orphan EXITs (no matching open paper BUY)
        if (!open) {
            deps.logger && deps.logger.info('[paper] skip orphan EXIT: ' + signalData.symbol + '/' + signalData.strategyId);
            return { type: 'paper_trade', status: 'skipped', skipReason: 'no open paper position',
                     signal: { symbol: signalData.symbol, signalType: 'EXIT_LONG' } };
        }
        if (open) {
            const chain = await deps.options.fetchChain(60000).catch(() => []);
            // [PAPER-SCHEMA-FIX] resolve contract symbol + entryAsk from nested schema
            const _contractSym = open.symbol || (open.contract && open.contract.symbol) || null;
            const _entryAsk = (open.entry && open.entry.optionAsk) || open.entryAsk || 0;
            const liveContract = _contractSym ? chain.find(c => c.symbol === _contractSym) : null;
            const exitBid = liveContract && liveContract.bid > 0 ? liveContract.bid : null;
            const exitCost = _entryAsk * (1 + 0.0012);
            const exitProceeds = exitBid ? exitBid * (1 - 0.0012) : null;
            const pnlPct = (exitProceeds && exitCost > 0) ? (exitProceeds / exitCost - 1) * 100 : null;

            await db.collection(COLLECTIONS.OPTION_POSITIONS).updateOne(
                { _id: open._id },
                { $set: {
                    status: 'closed',
                    exitTime: new Date(),
                    closedAt: new Date(),
                    exitBid,
                    pnlPct,
                    pnl: { pnlPct },
                    exitReason: 'سیگنال خروج'
                } }
            );
            deps.logger && deps.logger.info(`[paper] CLOSE: ${_contractSym || signalData.symbol} pnl=${pnlPct != null ? pnlPct.toFixed(1) : '?'}%`);
        }
        // [PAPER-SCHEMA-FIX] early return — avoid inserting duplicate closed record
        return {
            type: 'paper_trade',
            status: 'closed',
            signal: { symbol: signalData.symbol, signalType: 'EXIT_LONG' },
            exit: { time: new Date(), optionBid: null, pnlPct: null }
        };
    }

    await db.collection(COLLECTIONS.OPTION_POSITIONS).insertOne(doc);
    return doc;
}

// ─── گزارش ───
async function getReport() {
    const db = deps.getDB();
    const all = await db.collection(COLLECTIONS.OPTION_POSITIONS)
        .find({ paper: true }).sort({ createdAt: -1 }).limit(500).toArray();

    const open = all.filter(p => p.status === 'open');
    function _pnlOf(p) {
        if (p && p.pnl && typeof p.pnl.pnlPct === 'number') return p.pnl.pnlPct;
        if (p && typeof p.pnlPct === 'number') return p.pnlPct;
        return null;
    }
    const closed = all.filter(p => p.status === 'closed' && _pnlOf(p) !== null);
    const wins = closed.filter(p => _pnlOf(p) > 0);
    const losses = closed.filter(p => _pnlOf(p) <= 0);
    const gp = wins.reduce((s, p) => s + _pnlOf(p), 0);
    const gl = Math.abs(losses.reduce((s, p) => s + _pnlOf(p), 0));
    const pf = gl > 0 ? gp / gl : (gp > 0 ? null : 0);

    return {
        total: all.length,
        open: open.length,
        closed: closed.length,
        wins: wins.length,
        losses: losses.length,
        winRate: closed.length ? wins.length / closed.length * 100 : 0,
        totalPnl: closed.reduce((s, p) => s + (_pnlOf(p) || 0), 0),
        profitFactor: pf,
        avgWin: wins.length ? gp / wins.length : 0,
        avgLoss: losses.length ? -gl / losses.length : 0,
        trades: all.slice(0, 100)
    };
}

// ─── همگام‌سازی روزانه (بستن پوزیشن‌های منقضی) ───
async function dailySync() {
    const db = deps.getDB();
    const open = await db.collection(COLLECTIONS.OPTION_POSITIONS)
        .find({ status: 'open', paper: true }).toArray();

    if (!open.length) return { updated: 0 };

    const chain = await deps.options.fetchChain(60000).catch(() => []);
    let updated = 0;

    for (const p of open) {
        // [PAPER-SCHEMA-FIX] resolve contract symbol from nested schema
        const _contractSym = p.symbol || (p.contract && p.contract.symbol) || null;
        if (!_contractSym) continue;
        const live = chain.find(c => c.symbol === _contractSym);
        if (!live) continue;

        const exitBid = live.bid > 0 ? live.bid : null;
        const exitCost = (p.entry && p.entry.optionAsk || 0) * 1.0012;
        const exitProceeds = exitBid ? exitBid * 0.9988 : null;
        const pnlPct = (exitProceeds && exitCost > 0) ? (exitProceeds / exitCost - 1) * 100 : null;

        // بستن اگه منقضی شده یا ۲۰٪ ضرر کرده
        let reason = null;
        if (live.daysLeft <= 5) reason = `${live.daysLeft} روز تا سررسید`;
        else if (pnlPct !== null && pnlPct <= -20) reason = `حد ضرر (${pnlPct.toFixed(0)}%)`;
        else if (pnlPct !== null && pnlPct >= 100) reason = `حد سود کامل (${pnlPct.toFixed(0)}%)`;

        if (reason) {
            await db.collection(COLLECTIONS.OPTION_POSITIONS).updateOne(
                { _id: p._id },
                { $set: {
                    status: 'closed',
                    exitTime: new Date(),
                    closedAt: new Date(),
                    exitBid,
                    pnl: { pnlPct },
                    exitReason: reason
                } }
            );
            updated++;
        }
    }

    deps.logger && deps.logger.info(`[paper] daily sync: ${updated} closed`);
    return { updated };
}

module.exports = { init, recordSignal, getReport, dailySync };