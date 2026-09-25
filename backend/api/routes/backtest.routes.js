'use strict';
// ============================================================
// backtest.routes.js — یکپارچه: run + results + apply
// ============================================================

function register(app, deps) {
    const { backtestOrchestrator } = deps;

    if (!backtestOrchestrator) {
        console.warn('backtest.routes: backtestOrchestrator not provided — skipping');
        return;
    }

    // POST /api/backtest/run
    app.post('/api/backtest/run', async (req, res, next) => {
        try {
            const body = req.body || {};
            const r = await backtestOrchestrator.runBacktest(body);
            res.json(r);
        } catch (e) {
            if (e.status) return res.status(e.status).json({ error: e.message });
            next(e);
        }
    });

    // GET /api/backtest/results/:jobId
    app.get('/api/backtest/results/:jobId', async (req, res, next) => {
        try {
            const r = await backtestOrchestrator.getResults(req.params.jobId);
            if (r.error && r.error === 'job not found')
                return res.status(404).json({ error: r.error });
            res.json(r);
        } catch (e) { next(e); }
    });

    // POST /api/backtest/recompute/:jobId — force recompute
    app.post('/api/backtest/recompute/:jobId', async (req, res, next) => {
        try {
            const db = deps.getDB();
            await db.collection('meta').deleteOne({ _id: 'backtest_result_' + req.params.jobId });
            const r = await backtestOrchestrator.getResults(req.params.jobId);
            res.json(r);
        } catch (e) { next(e); }
    });

    // POST /api/backtest/apply
    app.post('/api/backtest/apply', async (req, res, next) => {
        try {
            const { jobId, selections } = req.body || {};
            if (!jobId || !Array.isArray(selections)) {
                return res.status(400).json({ error: 'jobId و selections لازم است' });
            }
            const r = await backtestOrchestrator.applySelections(jobId, selections);
            res.json(r);
        } catch (e) { next(e); }
    });
}

module.exports = { register };