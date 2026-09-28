'use strict';
// ============================================================
// journal.routes.js — دفتر معاملات
// ============================================================
function register(app, deps) {
    const { getDB } = deps;
    const { ObjectId } = require('mongodb');

    // ----------------------------------------------------------
    // لیست ژورنال + آمار
    // ----------------------------------------------------------
    app.get('/api/journal', async (req, res, next) => {
        try {
            const db = getDB();
            const q = {};
            if (req.query.symbol) q.symbol = req.query.symbol;
            if (req.query.strategyId) q.strategyId = req.query.strategyId;
            if (req.query.status) q.status = req.query.status;

            const limit = Math.min(+(req.query.limit || 200), 500);
            const skip = Math.max(+(req.query.skip || 0), 0);

            const totalCount = await db.collection('trade_journal').countDocuments(q);

            const list = await db.collection('trade_journal')
                .find(q).sort({ 'entry.time': -1 })
                .skip(skip).limit(limit)
                .project({
                    _id: 1, positionId: 1, symbol: 1, strategyId: 1, role: 1,
                    'contract.symbol': 1, 'contract.strike': 1, 'contract.expiry': 1,
                    'entry.time': 1, 'entry.optionAsk': 1, 'entry.positionSize': 1,
                    'entry.level': 1, 'entry.iv': 1, 'entry.delta': 1,
                    'exit.pnlPct': 1, 'exit.time': 1, 'exit.reason': 1,
                    status: 1
                })
                .toArray();

            const aggStats = await db.collection('trade_journal').aggregate([
                { $match: { ...q, status: 'closed' } },
                { $project: {
                    pnl: '$exit.pnlPct',
                    win: { $gt: ['$exit.pnlPct', 0] }
                }},
                { $group: {
                    _id: null,
                    closed: { $sum: 1 },
                    wins: { $sum: { $cond: ['$win', 1, 0] } },
                    grossWin: { $sum: { $cond: ['$win', '$pnl', 0] } },
                    grossLoss: { $sum: { $cond: ['$win', 0, { $abs: { $ifNull: ['$pnl', 0] } }] } },
                    totalPnl: { $sum: '$pnl' }
                }}
            ]).toArray();

            const st = aggStats[0] || { closed: 0, wins: 0, grossWin: 0, grossLoss: 0, totalPnl: 0 };
            const profitFactor = st.grossLoss > 0
                ? st.grossWin / st.grossLoss
                : (st.grossWin > 0 ? 999 : 0);

            const openCount = await db.collection('trade_journal')
                .countDocuments({ ...q, status: 'open' });

            res.json({
                trades: list,
                pagination: { skip, limit, total: totalCount, hasMore: skip + limit < totalCount },
                stats: {
                    total: totalCount,
                    open: openCount,
                    closed: st.closed,
                    wins: st.wins,
                    losses: st.closed - st.wins,
                    winRate: st.closed ? Math.round(st.wins / st.closed * 1000) / 10 : 0,
                    avgPnl: st.closed ? Math.round(st.totalPnl / st.closed * 100) / 100 : 0,
                    pf: Math.round(profitFactor * 100) / 100,
                    grossWin: Math.round(st.grossWin * 100) / 100,
                    grossLoss: Math.round(st.grossLoss * 100) / 100
                }
            });
        } catch (e) { next(e); }
    });

    // ----------------------------------------------------------
    // جزئیات یک معامله
    // ----------------------------------------------------------
    app.get('/api/journal/:id', async (req, res, next) => {
        try {
            const db = getDB();
            const d = await db.collection('trade_journal').findOne({ _id: new ObjectId(req.params.id) });
            if (!d) return res.status(404).json({ error: 'not found' });
            res.json(d);
        } catch (e) { next(e); }
    });

    // ----------------------------------------------------------
    // Sync دستی
    // ----------------------------------------------------------
    app.post('/api/journal/sync', async (req, res, next) => {
        try {
            if (!deps.journalService) return res.status(500).json({ error: 'journalService not wired' });
            const r = await deps.journalService.sync();
            res.json(r);
        } catch (e) { next(e); }
    });
}

module.exports = { register };