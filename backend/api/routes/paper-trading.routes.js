'use strict';
// ============================================================
// paper-trading.routes.js — API endpoints
// ============================================================

const paperTradingService = require('../../services/paper-trading.service');
const paperDriftService = require('../../services/paper-drift.service');
const { COLLECTIONS } = require('../../config/constants');

function register(app, deps) {

    app.get('/api/paper-trading/debug', (req, res) => {
        res.json({
            has_getReport: typeof paperTradingService.getReport === 'function',
            has_dailySync: typeof paperTradingService.dailySync === 'function',
            has_recordSignal: typeof paperTradingService.recordSignal === 'function',
            has_drift: typeof paperDriftService.computeDrift === 'function'
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

    // ----------------------------------------------------------
    // Stage 12: Drift — Paper vs Backtest
    // ----------------------------------------------------------
    app.get('/api/paper-trading/drift', async (req, res, next) => {
        try {
            const days = Math.min(Math.max(+(req.query.days || 30), 1), 365);
            const r = await paperDriftService.computeDrift(deps.getDB, { days: days });
            res.json(r);
        } catch (e) { next(e); }
    });

    // ----------------------------------------------------------
    // Stage 12: Cleanup orphan pending EXITs (no matching BUY)
    // ----------------------------------------------------------
    app.post('/api/paper-trading/cleanup-orphans', async (req, res, next) => {
        try {
            const db = deps.getDB();
            const r = await db.collection(COLLECTIONS.OPTION_POSITIONS).deleteMany({
                paper: true,
                status: 'pending',
                'signal.signalType': 'EXIT_LONG',
                $or: [
                    { 'contract.symbol': { $exists: false } },
                    { 'contract.symbol': null },
                    { 'contract.symbol': '' }
                ]
            });
            if (deps.logger) {
                deps.logger.info('paper-cleanup: deleted ' + r.deletedCount + ' orphan pending EXITs');
            }
            res.json({ ok: true, deleted: r.deletedCount });
        } catch (e) { next(e); }
    });
}

module.exports = { register: register };