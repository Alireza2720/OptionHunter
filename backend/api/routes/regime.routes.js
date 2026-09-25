'use strict';
// ============================================================
// regime.routes.js — endpoints فاز ۶
// ============================================================

function register(app, deps) {
    const { regimeService } = deps;
    if (!regimeService) return;

    // ⚠️ ترتیب مهمه: static قبل از dynamic
    // /api/regime/all
    app.get('/api/regime/all', async (req, res, next) => {
        try {
            res.json({ symbols: await regimeService.getAllCached() });
        } catch (e) { next(e); }
    });

    // /api/regime/strategy-map
    app.get('/api/regime/strategy-map', (req, res) => {
        const { STRATEGY_REGIME_MAP } = require('../../core/regime');
        res.json(STRATEGY_REGIME_MAP);
    });

    // /api/regime/refresh
    app.post('/api/regime/refresh', async (req, res, next) => {
        try {
            const r = await regimeService.refreshAll();
            res.json({ refreshed: r.length, symbols: r });
        } catch (e) { next(e); }
    });

    // ⚠️ این باید آخر باشه چون dynamic هست
    // /api/regime/:symbol
    app.get('/api/regime/:symbol', async (req, res, next) => {
        try {
            const r = await regimeService.getForSymbol(decodeURIComponent(req.params.symbol));
            if (!r) return res.status(404).json({ error: 'رژیم محاسبه نشده' });
            res.json(r);
        } catch (e) { next(e); }
    });
}

module.exports = { register };