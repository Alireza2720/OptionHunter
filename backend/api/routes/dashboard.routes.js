'use strict';
// ============================================================
// dashboard.routes.js — Phase 7: Live portfolio dashboard
// ============================================================

const { COLLECTIONS } = require('../../config/constants');

function register(app, deps) {
    const { getDB, settings } = deps;

    // ------------------------------------------------------------
    // GET /api/dashboard/live — وضعیت لحظه‌ای پرتفولیو
    // ------------------------------------------------------------
    app.get('/api/dashboard/live', async (req, res, next) => {
        try {
            const db = getDB();
            const capital = settings.capital();

            // پوزیشن‌های باز
            const openPositions = await db.collection(COLLECTIONS.OPTION_POSITIONS)
                .find({ status: 'open' })
                .toArray();

            // پوزیشن‌های بسته ۳۰ روز اخیر
            const since30 = new Date(Date.now() - 30 * 86400 * 1000);
            const closedPositions = await db.collection(COLLECTIONS.OPTION_POSITIONS)
                .find({ status: 'closed', exitTime: { $gte: since30 } })
                .toArray();

            // محاسبه exposure لحظه‌ای
            let totalExposure = 0;
            const bySymbol = {};
            let totalUnrealized = 0;
            const positions = [];

            for (const p of openPositions) {
                const value = (p.entryAsk || 0) * (p.positionSize || 1) * (p.size || 1000);
                totalExposure += value;
                bySymbol[p.underlying] = (bySymbol[p.underlying] || 0) + value;

                const lastPnlPct = p.lastPnlPct || 0;
                const unrealized = value * (lastPnlPct / 100);
                totalUnrealized += unrealized;

                positions.push({
                    _id: String(p._id),
                    underlying: p.underlying,
                    symbol: p.symbol,
                    strike: p.strike,
                    expiry: p.expiry,
                    entryTime: p.entryTime,
                    entryAsk: p.entryAsk,
                    positionSize: p.positionSize,
                    entryValue: value,
                    lastPnlPct,
                    unrealized: Math.round(unrealized),
                    lastBid: p.lastBid,
                    lastS: p.lastS,
                    entryS: p.entryS,
                    level: p.level,
                    lastCheck: p.lastCheck
                });
            }

            // آمار ۳۰ روز اخیر
            const wins = closedPositions.filter(p => (p.pnlPct || 0) > 0);
            const losses = closedPositions.filter(p => (p.pnlPct || 0) <= 0);
            const gp = wins.reduce((s, p) => s + (p.pnlPct || 0), 0);
            const gl = -losses.reduce((s, p) => s + (p.pnlPct || 0), 0);
            const pf30d = gl > 0 ? gp / gl : (gp > 0 ? null : 0);
            const winRate30d = closedPositions.length ? wins.length / closedPositions.length * 100 : 0;
            const totalPnl30d = closedPositions.reduce((s, p) => s + (p.pnlPct || 0), 0);

            // معاملات امروز
            const todayStart = new Date();
            todayStart.setHours(0, 0, 0, 0);
            const todayClosed = await db.collection(COLLECTIONS.OPTION_POSITIONS)
                .countDocuments({
                    status: 'closed',
                    exitTime: { $gte: todayStart }
                });
            const todayOpened = await db.collection(COLLECTIONS.OPTION_POSITIONS)
                .countDocuments({
                    entryTime: { $gte: todayStart }
                });

            // سیگنال‌های امروز
            const signalsToday = await db.collection(COLLECTIONS.SIGNAL_HISTORY)
                .countDocuments({
                    createdAt: { $gte: todayStart },
                    signalType: 'BUY'
                });
            const signalsRejectedToday = await db.collection(COLLECTIONS.SIGNAL_HISTORY)
                .countDocuments({
                    createdAt: { $gte: todayStart },
                    rejected: true
                });

            // Backtest PF برای drift comparison
            const backtestMeta = await db.collection(COLLECTIONS.META)
                .findOne({ _id: 'last_backtest_pf' });
            const backtestPF = backtestMeta ? backtestMeta.pf : null;

            // Drift check
            let drift = null;
            if (backtestPF && backtestPF > 0 && closedPositions.length >= 5) {
                const ratio = pf30d === null ? 0 : pf30d / backtestPF;
                let severity = 'ok';
                if (ratio < 0.3) severity = 'critical';
                else if (ratio < 0.5) severity = 'warn';
                drift = {
                    backtestPF: Math.round(backtestPF * 100) / 100,
                    livePF: pf30d === null ? null : Math.round(pf30d * 100) / 100,
                    ratio: Math.round(ratio * 100) / 100,
                    severity,
                    message: severity === 'critical'
                        ? `عملکرد زنده ${(ratio * 100).toFixed(0)}% بک‌تست — بررسی کن`
                        : severity === 'warn'
                        ? `عملکرد زنده ${(ratio * 100).toFixed(0)}% بک‌تست — در حال افت`
                        : null
                };
            }

            res.json({
                at: new Date(),
                capital: {
                    total: capital,
                    exposure: Math.round(totalExposure),
                    cash: Math.round(capital - totalExposure),
                    exposurePct: capital > 0 ? Math.round(totalExposure / capital * 1000) / 10 : 0,
                    peakExposurePct: 0  // از sim می‌آید
                },
                openPositions: {
                    count: openPositions.length,
                    bySymbol,
                    positions,
                    totalUnrealized: Math.round(totalUnrealized)
                },
                today: {
                    opened: todayOpened,
                    closed: todayClosed,
                    signals: signalsToday,
                    rejected: signalsRejectedToday
                },
                last30d: {
                    trades: closedPositions.length,
                    winRate: Math.round(winRate30d * 10) / 10,
                    pf: pf30d === null ? null : Math.round(pf30d * 100) / 100,
                    totalPnl: Math.round(totalPnl30d * 10) / 10,
                    avgPnl: closedPositions.length ? Math.round(totalPnl30d / closedPositions.length * 100) / 100 : 0
                },
                drift
            });
        } catch (e) { next(e); }
    });

    // ------------------------------------------------------------
    // POST /api/dashboard/record-backtest-pf — ثبت PF بک‌تست
    // ------------------------------------------------------------
    app.post('/api/dashboard/record-backtest-pf', async (req, res, next) => {
        try {
            const { pf, jobId, source } = req.body || {};
            if (!pf || !Number.isFinite(pf)) {
                return res.status(400).json({ error: 'pf معتبر نیست' });
            }
            await getDB().collection(COLLECTIONS.META).updateOne(
                { _id: 'last_backtest_pf' },
                { $set: {
                    pf,
                    jobId: jobId || null,
                    source: source || 'manual',
                    recordedAt: new Date()
                }},
                { upsert: true }
            );
            res.json({ success: true });
        } catch (e) { next(e); }
    });
}

module.exports = { register };