'use strict';
// ============================================================
// paper-trading.routes.js — API endpoints
// Requires service directly (not via deps) — robust against wiring
// ============================================================

const paperTradingService = require('../../services/paper-trading.service');

function register(app, deps) {

    app.get('/api/paper-trading/debug', (req, res) => {
        res.json({
            has_getReport: typeof paperTradingService.getReport === 'function',
            has_dailySync: typeof paperTradingService.dailySync === 'function',
            has_recordSignal: typeof paperTradingService.recordSignal === 'function'
        });
    });

    app.get('/api/paper-trading/report', async (req, res, next) => {
        try {
            if (typeof paperTradingService.getReport !== 'function') {
                return res.status(503).json({ error: 'service not initialized' });
            }
            res.json(await paperTradingService.getReport());
        } catch (e) { next(e); }
    });

    app.post('/api/paper-trading/sync', async (req, res, next) => {
        try {
            if (typeof paperTradingService.dailySync !== 'function') {
                return res.status(503).json({ error: 'service not initialized' });
            }
            res.json(await paperTradingService.dailySync());
        } catch (e) { next(e); }
    });

    app.get('/api/paper-trading/trades', async (req, res, next) => {
        try {
            const db = deps.getDB();
            const list = await db.collection('option_positions')
                .find({ paper: true }).sort({ createdAt: -1 }).limit(200).toArray();
            res.json({ trades: list });
        } catch (e) { next(e); }
    });

    app.get('/api/paper-trading/summary', async (req, res, next) => {
        try {
            const r = await paperTradingService.getReport();
            res.json({
                total: r.total, open: r.open, closed: r.closed,
                wins: r.wins, losses: r.losses, winRate: r.winRate,
                totalPnl: r.totalPnl, profitFactor: r.profitFactor,
                avgWin: r.avgWin, avgLoss: r.avgLoss
            });
        } catch (e) { next(e); }
    });
}

module.exports = { register };