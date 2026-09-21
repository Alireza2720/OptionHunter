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

    // 🆕 Data range
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
}

module.exports = { register };