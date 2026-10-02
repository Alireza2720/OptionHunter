'use strict';
// ============================================================
// pipeline.routes.js — Master Pipeline endpoints
// ============================================================

const { ObjectId } = require('mongodb');
const { COLLECTIONS } = require('../../config/constants');

function register(app, deps) {
    const { getDB, logger } = deps;

    // ------------------------------------------------------------
    // POST /api/pipeline/run — اجرای pipeline کامل (async)
    // ------------------------------------------------------------
    app.post('/api/pipeline/run', async (req, res, next) => {
        try {
            // 🆕 Memory guard
            const memGuard = require('../../infra/memory-guard');
            const check = memGuard.canStartHeavyJob();
            if (!check.ok) {
                return res.status(503).json({ error: check.reason, memory: check.status });
            }

            const opts = req.body || {};

            const db = getDB();
            const monitored = await db.collection(COLLECTIONS.MONITORED_SYMBOLS)
                .find({ enabled: true }).toArray();

            const symbols = opts.symbols && opts.symbols.length
                ? opts.symbols
                : monitored.map(m => m.symbol);

            // 🆕 استراتژی‌های نیازمند context خاص رو exclude کن
            const { STRATEGIES } = require('../../strategies');
            const EXCLUDED = new Set(['ensemble', 'pairs_spread', 'sector_momentum']);
            const strategies = opts.strategies && opts.strategies.length
                ? opts.strategies
                : Object.values(STRATEGIES)
                    .filter(s => !EXCLUDED.has(s.id))
                    .map(s => ({
                        id: s.id,
                        timeframe: s.defaultTimeframe,
                        htfTimeframe: s.htfTimeframe || '1d'
                    }));

            if (!symbols.length || !strategies.length) {
                return res.status(400).json({ error: 'symbols یا strategies خالی' });
            }

            // 🆕 هشدار برای سنگین
            if (symbols.length * strategies.length > 200 && check.status.systemFreeMB < 500) {
                return res.status(503).json({
                    error: `pipeline سنگین (${symbols.length}×${strategies.length}) با RAM آزاد ${check.status.systemFreeMB}MB`,
                    memory: check.status
                });
            }

            // ساخت job
            const jobDoc = {
                type: 'pipeline',
                payload: { symbols, strategies, ...opts },
                status: 'QUEUED',
                progress: { current: 0, total: 6, message: 'در صف' },
                createdAt: new Date(),
                updatedAt: new Date()
            };
            const r = await db.collection(COLLECTIONS.BACKTEST_JOBS).insertOne(jobDoc);
            const jobId = String(r.insertedId);

            // Fire and forget
            (async () => {
                try {
                    await db.collection(COLLECTIONS.BACKTEST_JOBS).updateOne(
                        { _id: r.insertedId },
                        { $set: { status: 'RUNNING', startedAt: new Date() } }
                    );
                    const result = await deps.pipelineService.runMaster(jobId, {
                        ...opts,
                        symbols,
                        strategies
                    });
                    await db.collection(COLLECTIONS.BACKTEST_JOBS).updateOne(
                        { _id: r.insertedId },
                        { $set: {
                            status: 'DONE',
                            result,
                            finishedAt: new Date(),
                            'progress.message': 'تکمیل',
                            'progress.current': 6
                        }}
                    );
                } catch (e) {
                    logger && logger.error('pipeline run: ' + e.message);
                    await db.collection(COLLECTIONS.BACKTEST_JOBS).updateOne(
                        { _id: r.insertedId },
                        { $set: {
                            status: 'FAILED',
                            error: e.message,
                            finishedAt: new Date()
                        }}
                    );
                }
            })();

            res.json({ jobId, status: 'QUEUED' });
        } catch (e) { next(e); }
    });
}

module.exports = { register };