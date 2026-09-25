'use strict';
// ============================================================
// regime.routes.js — endpoints فاز ۶
// ============================================================

function register(app, deps) {
    const { regimeService } = deps;
    if (!regimeService) return;

    // لیست رژیم همه‌ی نمادها
    app.get('/api/regime/all', async (req, res, next) => {
        try {
            res.json({ symbols: await regimeService.getAllCached() });
        } catch (e) { next(e); }
    });

    // رژیم یک نماد
    app.get('/api/regime/:symbol', async (req, res, next) => {
        try {
            const r = await regimeService.getForSymbol(decodeURIComponent(req.params.symbol));
            if (!r) return res.status(404).json({ error: 'رژیم محاسبه نشده' });
            res.json(r);
        } catch (e) { next(e); }
    });

    // رفرش دستی
    app.post('/api/regime/refresh', async (req, res, next) => {
        try {
            const r = await regimeService.refreshAll();
            res.json({ refreshed: r.length, symbols: r });
        } catch (e) { next(e); }
    });

    // نگاشت استراتژی → رژیم
    app.get('/api/regime/strategy-map', (req, res) => {
        const { STRATEGY_REGIME_MAP } = require('../../core/regime');
        res.json(STRATEGY_REGIME_MAP);
    });
}

module.exports = { register };