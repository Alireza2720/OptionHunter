'use strict';
// ============================================================
// portfolio.routes.js — endpoints فاز ۳
// ============================================================

function register(app, deps) {
    const { portfolioService, correlationService } = deps;

    app.post('/api/portfolio/simulate/:jobId', async (req, res, next) => {
        try {
            const opts = req.body || {};
            const r = await portfolioService.simulateFromJob(req.params.jobId, opts);
            res.json(r);
        } catch (e) { next(e); }
    });

    // 🆕 Correlation matrix endpoints
    app.get('/api/portfolio/correlation', async (req, res, next) => {
        try {
            const cached = await correlationService.getCached();
            if (!cached) return res.status(404).json({ error: 'هنوز محاسبه نشده' });
            res.json(cached);
        } catch (e) { next(e); }
    });

    app.post('/api/portfolio/correlation/refresh', async (req, res, next) => {
        try {
            const days = +(req.query.days || 30);
            const r = await correlationService.computeAndStore(days);
            res.json(r);
        } catch (e) { next(e); }
    });
}

module.exports = { register };