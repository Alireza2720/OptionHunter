'use strict';
// ============================================================
// portfolio.routes.js — endpoints فاز ۳
// ============================================================

function register(app, deps) {
    const { portfolioService } = deps;

    app.post('/api/portfolio/simulate/:jobId', async (req, res, next) => {
        try {
            const opts = req.body || {};
            const r = await portfolioService.simulateFromJob(req.params.jobId, opts);
            res.json(r);
        } catch (e) { next(e); }
    });
}

module.exports = { register };