'use strict';
// ============================================================
// paper-trading.routes.js — API endpoints
// Always register (route returns error if service unavailable)
// ============================================================

function register(app, deps) {
    // 🆕 diagnostic — describe what deps has
    app.get('/api/paper-trading/debug', (req, res) => {
        const keys = Object.keys(deps || {});
        const hasService = !!(deps && (deps.paperTradingService || deps.paperTrading));
        res.json({
            deps_keys: keys,
            has_paper_trading_service: hasService,
            service_type: typeof (deps && (deps.paperTradingService || deps.paperTrading))
        });
    });

    app.get('/api/paper-trading/report', async (req, res, next) => {
        try {
            const svc = deps && (deps.paperTradingService || deps.paperTrading);
            if (!svc || typeof svc.getReport !== 'function') {
                return res.status(503).json({
                    error: 'paperTradingService not wired',
                    deps_keys: Object.keys(deps || {})
                });
            }
            res.json(await svc.getReport());
        } catch (e) { next(e); }
    });

    app.post('/api/paper-trading/sync', async (req, res, next) => {
        try {
            const svc = deps && (deps.paperTradingService || deps.paperTrading);
            if (!svc || typeof svc.dailySync !== 'function') {
                return res.status(503).json({
                    error: 'paperTradingService not wired',
                    deps_keys: Object.keys(deps || {})
                });
            }
            res.json(await svc.dailySync());
        } catch (e) { next(e); }
    });

    app.get('/api/paper-trading/trades', async (req, res, next) => {
        try {
            const list = await deps.getDB().collection('option_positions')
                .find({ paper: true }).sort({ createdAt: -1 }).limit(200).toArray();
            res.json({ trades: list });
        } catch (e) { next(e); }
    });
}

module.exports = { register };