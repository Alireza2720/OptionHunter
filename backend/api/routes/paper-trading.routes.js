'use strict';
// ============================================================
// paper-trading.routes.js — API endpoints
// ============================================================

function register(app, deps) {
    const { paperTradingService } = deps;
    if (!paperTradingService) return;

    app.get('/api/paper-trading/report', async (req, res, next) => {
        try { res.json(await paperTradingService.getReport()); }
        catch (e) { next(e); }
    });

    app.post('/api/paper-trading/sync', async (req, res, next) => {
        try { res.json(await paperTradingService.dailySync()); }
        catch (e) { next(e); }
    });

    app.get('/api/paper-trading/trades', async (req, res, next) => {
        try {
            const db = deps.getDB();
            const list = await db.collection('option_positions')
                .find({ paper: true }).sort({ createdAt: -1 }).limit(200).toArray();
            res.json({ trades: list });
        } catch (e) { next(e); }
    });
}

module.exports = { register };