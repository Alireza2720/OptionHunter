'use strict';
// ============================================================
// portfolio.routes.js — endpoints فاز ۳
// ============================================================

function register(app, deps) {
    const { portfolioService, correlationService, signalFilterService, analysisService } = deps;

    // ------------------------------------------------------------
    // Simulate
    // ------------------------------------------------------------
    app.post('/api/portfolio/simulate/:jobId', async (req, res, next) => {
        try {
            const opts = req.body || {};
            const r = await portfolioService.simulateFromJob(req.params.jobId, opts);
            res.json(r);
        } catch (e) { next(e); }
    });

    // ------------------------------------------------------------
    // Whitelist
    // ------------------------------------------------------------
    app.get('/api/portfolio/whitelist', async (req, res, next) => {
        try {
            const wl = await signalFilterService.getWhitelist();
            if (!wl) return res.status(404).json({ error: 'whitelist ساخته نشده' });
            const pairsArr = wl.pairs instanceof Set ? Array.from(wl.pairs) : (Array.isArray(wl.pairs) ? wl.pairs : []);
            const strategiesArr = wl.strategies instanceof Set ? Array.from(wl.strategies) : (Array.isArray(wl.strategies) ? wl.strategies : []);
            const symbolsArr = wl.symbols instanceof Set ? Array.from(wl.symbols) : (Array.isArray(wl.symbols) ? wl.symbols : []);

            res.json({
                jobId: wl.jobId,
                computedAt: wl.computedAt,
                filterMode: wl.filterMode,
                pairsCount: pairsArr.length,
                strategies: strategiesArr,
                symbolsCount: symbolsArr.length,
                pairs: pairsArr
            });
        } catch (e) { next(e); }
    });

    app.post('/api/portfolio/whitelist/rebuild/:jobId', async (req, res, next) => {
        try {
            const r = await signalFilterService.buildAndSaveWhitelist(
                req.params.jobId, req.body || {}
            );
            res.json(r);
        } catch (e) { next(e); }
    });

    app.delete('/api/portfolio/whitelist', async (req, res, next) => {
        try {
            await signalFilterService.clear();
            res.json({ success: true });
        } catch (e) { next(e); }
    });

    // ------------------------------------------------------------
    // Filter preview
    // ------------------------------------------------------------
    app.post('/api/portfolio/filter-preview/:jobId', async (req, res, next) => {
        try {
            const analysis = await analysisService.analyzeJob(req.params.jobId, { minTrades: 5, iterations: 1000 });
            const { filterTrades } = require('../../core/signal-filter');
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

    // ------------------------------------------------------------
    // Correlation matrix
    // ------------------------------------------------------------
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

    // 🆕 تحلیل پرتفولیو — ماتریس + خوشه + صنعت
    app.get('/api/portfolio/analysis', async (req, res, next) => {
        try {
            const cached = await correlationService.getCached();
            if (!cached) {
                return res.json({ error: 'correlation_not_computed', hint: 'POST /api/portfolio/correlation/refresh' });
            }
            const { getSectorMap } = require('../../core/sectors');
            const { findClusters } = require('../../core/correlation');
            const symbols = cached.symbols || [];
            const sectorMap = getSectorMap(symbols);

            // بازسازی خوشه‌ها با threshold 0.7
            const clusters = cached.clusters && cached.clusters.length
                ? cached.clusters
                : findClusters(cached.matrix, 0.7);

            // توزیع صنعت
            const sectorDist = {};
            for (const s of symbols) {
                const sec = sectorMap[s] || 'سایر';
                sectorDist[sec] = (sectorDist[sec] || 0) + 1;
            }

            res.json({
                symbolsCount: symbols.length,
                matrix: cached.matrix,
                clusters,
                sectorMap,
                sectorDistribution: sectorDist,
                computedAt: cached.computedAt,
                days: cached.days
            });
        } catch (e) { next(e); }
    });
}

module.exports = { register };