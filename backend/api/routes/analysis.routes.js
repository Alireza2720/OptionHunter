'use strict';
// ============================================================
// analysis.routes.js — endpoints فاز ۱
// ============================================================

function register(app, deps) {
    const { analysisService } = deps;

    // Analyze one candidate from a compare job
    app.get('/api/analysis/config/:jobId/:symbol/:strategyId', async (req, res, next) => {
        try {
            const iterations = Math.min(+(req.query.iterations || 10000), 50000);
            const r = await analysisService.analyzeConfig(
                req.params.jobId,
                decodeURIComponent(req.params.symbol),
                req.params.strategyId,
                { iterations }
            );
            res.json(r);
        } catch (e) {
            if (e.status) return res.status(e.status).json({ error: e.message });
            next(e);
        }
    });

    // Analyze all candidates from a job
    app.get('/api/analysis/job/:jobId', async (req, res, next) => {
        try {
            const minTrades = +(req.query.minTrades || 5);
            const iterations = Math.min(+(req.query.iterations || 10000), 50000);
            const r = await analysisService.analyzeJob(req.params.jobId, { minTrades, iterations });
            res.json(r);
        } catch (e) { next(e); }
    });
}

module.exports = { register };