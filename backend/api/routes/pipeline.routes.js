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
            const opts = req.body || {};

            // نیاز به symbols و strategies
            const db = getDB();
            const monitored = await db.collection(COLLECTIONS.MONITORED_SYMBOLS)
                .find({ enabled: true }).toArray();

            // اگه symbols نداد، همه‌ی active
            const symbols = opts.symbols && opts.symbols.length
                ? opts.symbols
                : monitored.map(m => m.symbol);

            // اگه strategies نداد، همه‌ی whitelisted قبلی یا همه
            const { STRATEGIES } = require('../../strategies');
            const strategies = opts.strategies && opts.strategies.length
                ? opts.strategies
                : Object.values(STRATEGIES)
                    .filter(s => s.id !== 'ensemble')   // Ensemble سنگین
                    .map(s => ({
                        id: s.id,
                        timeframe: s.defaultTimeframe,
                        htfTimeframe: s.htfTimeframe || '1d'
                    }));

            if (!symbols.length || !strategies.length) {
                return res.status(400).json({ error: 'symbols یا strategies خالی' });
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