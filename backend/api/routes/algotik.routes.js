'use strict';
// ============================================================
// algotik.routes.js — proxy به Collector
// ============================================================

function register(app, deps) {
    const { algotik, getDB } = deps;

    // ---- Health / Status ----
    app.get('/api/algotik/health', async (req, res) => {
        try { res.json({ online: await algotik.isOnline() }); }
        catch (e) { res.json({ online: false, error: e.message }); }
    });
    app.get('/api/algotik/status', async (req, res, next) => {
        try { res.json(await algotik.getStatus()); } catch (e) { next(e); }
    });

    // ---- Symbols ----
    app.get('/api/algotik/symbols', async (req, res, next) => {
        try { res.json(await algotik.listSymbols()); } catch (e) { next(e); }
    });
    app.post('/api/algotik/symbols', async (req, res, next) => {
        try {
            const { symbol, name } = req.body || {};
            if (!symbol) return res.status(400).json({ error: 'symbol required' });
            res.json(await algotik.addSymbol(symbol, name));
        } catch (e) { res.status(400).json({ error: e.message }); }
    });
    app.delete('/api/algotik/symbols/:symbol', async (req, res, next) => {
        try { res.json(await algotik.removeSymbol(req.params.symbol)); }
        catch (e) { res.status(400).json({ error: e.message }); }
    });

    // ---- Full Backfill ----
    app.post('/api/algotik/full-backfill', async (req, res, next) => {
        try { res.json(await algotik.startFullBackfill(req.body || {})); }
        catch (e) { res.status(400).json({ error: e.message }); }
    });

    // ---- Jobs ----
    app.get('/api/algotik/jobs', async (req, res, next) => {
        try { res.json(await algotik.listJobs(+(req.query.limit || 30))); }
        catch (e) { next(e); }
    });
    app.get('/api/algotik/jobs/:id', async (req, res, next) => {
        try { res.json(await algotik.getJob(req.params.id)); }
        catch (e) { next(e); }
    });
    app.post('/api/algotik/jobs/:id/cancel', async (req, res, next) => {
        try { res.json(await algotik.cancelJob(req.params.id)); }
        catch (e) { res.status(400).json({ error: e.message }); }
    });

    // ---- Coverage ----
    app.get('/api/algotik/coverage', async (req, res, next) => {
        try { res.json(await algotik.getCoverage()); } catch (e) { next(e); }
    });

    // ---- Audit ----
    app.get('/api/algotik/audit', async (req, res, next) => {
        try {
            const days = +(req.query.days || 730);
            const r = await algotik.auditAll(days);
            res.json(r);
        } catch (e) { next(e); }
    });
    app.get('/api/algotik/audit/:symbol', async (req, res, next) => {
        try {
            const days = +(req.query.days || 730);
            const r = await algotik.auditOne(req.params.symbol, days);
            res.json(r);
        } catch (e) { next(e); }
    });

    // ---- Data range ----
    app.get('/api/algotik/data-range', async (req, res, next) => {
        try { res.json(await algotik.getDataRange()); } catch (e) { next(e); }
    });
    app.get('/api/algotik/data-range/:symbol', async (req, res, next) => {
        try {
            res.json(await algotik.getSymbolDataRange(req.params.symbol));
        } catch (e) { next(e); }
    });

    // ---- Risk-free ----
    app.get('/api/algotik/risk-free', async (req, res, next) => {
        try { res.json(await algotik.getRiskFree()); } catch (e) { next(e); }
    });

    // ---- Ticker ----
    app.post('/api/algotik/ticker', async (req, res, next) => {
        try {
            const { action, intervalSec } = req.body || {};
            res.json(await algotik.controlTicker(action || 'start', intervalSec || 10));
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    // ---- Data freshness ----
    app.get('/api/algotik/freshness', async (req, res, next) => {
        try {
            const { COLLECTIONS } = require('../../config/constants');
            const db = getDB();
            const monitored = await db.collection(COLLECTIONS.MONITORED_SYMBOLS)
                .find({ enabled: true }).toArray();

            const today = new Date();
            today.setUTCHours(0, 0, 0, 0);

            const results = [];
            for (const m of monitored) {
                const last = await db.collection(COLLECTIONS.CANDLES_DAILY)
                    .find({ symbol: m.symbol }).sort({ time: -1 }).limit(1).toArray();
                const lastTime = last[0] ? new Date(last[0].time) : null;
                const gap = lastTime ? Math.floor((today - lastTime) / 86400000) : null;
                results.push({
                    symbol: m.symbol,
                    lastDaily: lastTime ? lastTime.toISOString().slice(0, 10) : null,
                    gapDays: gap,
                    stale: gap !== null && gap > 3
                });
            }

            const stale = results.filter(r => r.stale);
            res.json({
                today: today.toISOString().slice(0, 10),
                total: results.length,
                staleCount: stale.length,
                staleSymbols: stale.map(r => r.symbol),
                symbols: results
            });
        } catch (e) { next(e); }
    });

    // ---- Ticker log ----
    app.get('/api/algotik/ticker-log', async (req, res, next) => {
        try {
            const limit = Math.min(+(req.query.limit || 10), 100);
            const { COLLECTIONS } = require('../../config/constants');
            const db = getDB();
            const docs = await db.collection(COLLECTIONS.LOGS)
                .find({ msg: { $regex: '^tick \\|' } })
                .sort({ at: -1 }).limit(limit).toArray();
            const logs = docs.map(d => {
                const m = String(d.msg || '').match(/tick \| (\d+) symbols \| ticks=(\d+) \| volDelta=(\d+)/);
                return {
                    at: d.at,
                    symbols: m ? +m[1] : 0,
                    ticksOk: m ? +m[2] : 0,
                    volumeDelta: m ? +m[3] : 0
                };
            });
            res.json({ logs });
        } catch (e) { next(e); }
    });

    // ---- Fix gaps ----
    app.post('/api/algotik/fix-gaps', async (req, res, next) => {
        try {
            const days = +(req.query.days || 7);
            const { COLLECTIONS } = require('../../config/constants');
            const db = getDB();

            const monitored = await db.collection(COLLECTIONS.MONITORED_SYMBOLS)
                .find({ enabled: true }).toArray();

            const gaps = [];
            const today = new Date(); today.setUTCHours(0, 0, 0, 0);
            const since = new Date(today.getTime() - days * 86400000);

            for (const m of monitored) {
                const pipeline = [
                    { $match: { symbol: m.symbol, source: 'algotik_intraday',
                        time: { $gte: since, $lt: today } } },
                    { $group: {
                        _id: { $dateToString: { format: '%Y-%m-%d', date: '$time', timezone: 'Asia/Tehran' } },
                        count: { $sum: 1 }
                    }},
                    { $sort: { _id: 1 } }
                ];
                const daily = await db.collection(COLLECTIONS.CANDLES_BASE)
                    .aggregate(pipeline).toArray();

                const thin = daily.filter(d => d.count < 200);
                if (thin.length) {
                    gaps.push({
                        symbol: m.symbol,
                        thinDays: thin.map(d => ({ date: d._id, count: d.count })),
                        missingCount: thin.length
                    });
                }
            }

            res.json({
                checked: monitored.length,
                withGaps: gaps.length,
                days,
                gaps: gaps.slice(0, 50)
            });
        } catch (e) { next(e); }
    });
}

module.exports = { register };