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
        // 🆕 whitelist status/management
    app.get('/api/portfolio/whitelist', async (req, res, next) => {
        try {
            const wl = await deps.signalFilterService.getWhitelist();
            if (!wl) return res.status(404).json({ error: 'whitelist ساخته نشده' });
            res.json({
                jobId: wl.jobId,
                computedAt: wl.computedAt,
                filterMode: wl.filterMode,
                pairsCount: wl.pairs.size,
                strategies: Array.from(wl.strategies),
                symbolsCount: wl.symbols.size,
                pairs: Array.from(wl.pairs)
            });
        } catch (e) { next(e); }
    });

    app.post('/api/portfolio/whitelist/rebuild/:jobId', async (req, res, next) => {
        try {
            const r = await deps.signalFilterService.buildAndSaveWhitelist(
                req.params.jobId, req.body || {}
            );
            res.json(r);
        } catch (e) { next(e); }
    });

    app.delete('/api/portfolio/whitelist', async (req, res, next) => {
        try {
            await deps.signalFilterService.clear();
            res.json({ success: true });
        } catch (e) { next(e); }
    });
    });

    // 🆕 محاسبه‌ی پیش‌نمایش فیلتر بدون sim
    app.post('/api/portfolio/filter-preview/:jobId', async (req, res, next) => {
        try {
            const analysis = await deps.analysisService.analyzeJob(req.params.jobId, { minTrades: 5, iterations: 1000 });
            const { filterTrades } = require('../../core/signal-filter');
            // استخراج tradeها
            const db = deps.getDB();
            const details = await db.collection('backtest_compare_details')
                .find({ jobId: String(req.params.jobId) }).toArray();
            const allTrades = [];
            for (const d of details) {
                if (!d.trades || d.trades.length < 5) continue;
                for (const t of d.trades) {
                    allTrades.push({ ...t, symbol: d.symbol, strategyId: d.strategyId, strategyName: d.strategyName });
                }
            }
            const r = filterTrades(allTrades, analysis, req.body || {});
            res.json({
                filter: r.filter,
                droppedSample: (r.dropped || []).slice(0, 20).map(x => ({
                    symbol: x.symbol, strategyId: x.strategyId, reason: x._dropReason
                }))
            });
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