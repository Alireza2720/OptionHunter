'use strict';
function register(app, deps) {
    const { getDB } = deps;
    const { ObjectId } = require('mongodb');

    app.get('/api/journal', async (req, res, next) => {
        try {
            const db = getDB();
            const q = {};
            if (req.query.symbol) q.symbol = req.query.symbol;
            if (req.query.strategyId) q.strategyId = req.query.strategyId;
            if (req.query.status) q.status = req.query.status;

            const limit = Math.min(+(req.query.limit || 200), 500);
            const list = await db.collection('trade_journal')
                .find(q).sort({ 'entry.time': -1 }).limit(limit).toArray();

            // آمار
            const closed = list.filter(j => j.status === 'closed' && j.exit && typeof j.exit.pnlPct === 'number');
            const wins = closed.filter(j => j.exit.pnlPct > 0);
            const losses = closed.filter(j => j.exit.pnlPct <= 0);
            const gp = wins.reduce((s, j) => s + j.exit.pnlPct, 0);
            const gl = -losses.reduce((s, j) => s + j.exit.pnlPct, 0);
            const pf = gl > 0 ? gp / gl : (gp > 0 ? 999 : 0);
            const avg = closed.length ? closed.reduce((s, j) => s + j.exit.pnlPct, 0) / closed.length : 0;

            res.json({
                trades: list,
                stats: {
                    total: list.length,
                    open: list.filter(j => j.status === 'open').length,
                    closed: closed.length,
                    wins: wins.length,
                    losses: losses.length,
                    winRate: closed.length ? Math.round(wins.length / closed.length * 1000) / 10 : 0,
                    avgPnl: Math.round(avg * 100) / 100,
                    pf: Math.round(pf * 100) / 100,
                    grossWin: Math.round(gp * 100) / 100,
                    grossLoss: Math.round(gl * 100) / 100
                }
            });
        } catch (e) { next(e); }
    });

    app.get('/api/journal/:id', async (req, res, next) => {
        try {
            const db = getDB();
            const d = await db.collection('trade_journal').findOne({ _id: new ObjectId(req.params.id) });
            if (!d) return res.status(404).json({ error: 'not found' });
            res.json(d);
        } catch (e) { next(e); }
    });

    app.post('/api/journal/sync', async (req, res, next) => {
        try {
            const r = await deps.journalService.sync();
            res.json(r);
        } catch (e) { next(e); }
    });
}
module.exports = { register };