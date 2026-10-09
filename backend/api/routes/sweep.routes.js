'use strict';
// ============================================================
// sweep.routes.js — R23 endpoints
// ============================================================

const { ObjectId } = require('mongodb');
const { COLLECTIONS } = require('../../config/constants');

function register(app, deps) {
    const { getDB, logger, sweepService } = deps;
    if (!sweepService) {
        console.warn('sweep.routes: sweepService not wired');
        return;
    }

    // POST /api/sweep/run
    app.post('/api/sweep/run', async (req, res, next) => {
        try {
            const memGuard = require('../../infra/memory-guard');
            const check = memGuard.canStartHeavyJob();
            if (!check.ok) return res.status(503).json({ error: check.reason, memory: check.status });

            const opts = req.body || {};
            if (!Array.isArray(opts.symbols) || !opts.symbols.length) return res.status(400).json({ error: 'symbols empty' });
            if (!Array.isArray(opts.strategies) || !opts.strategies.length) return res.status(400).json({ error: 'strategies empty' });

            const db = getDB();
            const jobDoc = {
                type: 'sweep',
                payload: opts,
                status: 'QUEUED',
                progress: { current: 0, total: 0, message: 'در صف' },
                createdAt: new Date(),
                updatedAt: new Date(),
            };
            const r = await db.collection(COLLECTIONS.BACKTEST_JOBS).insertOne(jobDoc);
            const jobId = String(r.insertedId);

            (async () => {
                try {
                    await db.collection(COLLECTIONS.BACKTEST_JOBS).updateOne(
                        { _id: r.insertedId },
                        { $set: { status: 'RUNNING', startedAt: new Date(), updatedAt: new Date() } }
                    );
                    const result = await sweepService.runSweep(jobId, opts);
                    await db.collection(COLLECTIONS.BACKTEST_JOBS).updateOne(
                        { _id: r.insertedId },
                        { $set: {
                            status: 'DONE',
                            result,
                            finishedAt: new Date(),
                            updatedAt: new Date(),
                            'progress.message': 'تکمیل',
                        } }
                    );
                    // Save latest sweep to meta
                    await db.collection(COLLECTIONS.META).updateOne(
                        { _id: 'strategy_sweep_latest' },
                        { $set: { ...result, computedAt: new Date(), jobId } },
                        { upsert: true }
                    );
                } catch (e) {
                    const isCancel = String(e.message).includes('CANCELLED');
                    logger && logger.error('sweep bg: ' + e.message);
                    await db.collection(COLLECTIONS.BACKTEST_JOBS).updateOne(
                        { _id: r.insertedId },
                        { $set: {
                            status: isCancel ? 'CANCELLED' : 'FAILED',
                            error: isCancel ? null : e.message,
                            finishedAt: new Date(),
                            updatedAt: new Date(),
                        } }
                    );
                }
            })();

            res.json({ jobId, status: 'QUEUED' });
        } catch (e) { next(e); }
    });

    // GET /api/sweep/latest
    app.get('/api/sweep/latest', async (req, res, next) => {
        try {
            const doc = await getDB().collection(COLLECTIONS.META).findOne({ _id: 'strategy_sweep_latest' });
            res.json(doc || { empty: true });
        } catch (e) { next(e); }
    });

    // POST /api/sweep/apply — apply best params to strategy_defaults
    app.post('/api/sweep/apply', async (req, res, next) => {
        try {
            const { overrides } = req.body || {};
            if (!overrides || typeof overrides !== 'object') return res.status(400).json({ error: 'overrides required' });
            // overrides: { strategyId: { param: value, ... } }
            await deps.settings.saveStrategyDefaults(overrides);
            res.json({ success: true, applied: Object.keys(overrides).length });
        } catch (e) { next(e); }
    });

    // POST /api/sweep/:jobId/cancel
    app.post('/api/sweep/:jobId/cancel', async (req, res, next) => {
        try {
            if (!/^[a-f0-9]{24}$/i.test(req.params.jobId)) return res.status(400).json({ error: 'invalid id' });
            await getDB().collection(COLLECTIONS.BACKTEST_JOBS).updateOne(
                { _id: new ObjectId(req.params.jobId), status: { $in: ['QUEUED', 'RUNNING'] } },
                { $set: { status: 'CANCELLED', cancelRequested: true, finishedAt: new Date(), updatedAt: new Date() } }
            );
            res.json({ success: true });
        } catch (e) { next(e); }
    });
}

module.exports = { register };
