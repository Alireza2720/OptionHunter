'use strict';
// ============================================================
// sensitivity.routes.js — Parameter Sensitivity Panel API
// ============================================================

const { ObjectId } = require('mongodb');
const { COLLECTIONS } = require('../../config/constants');

function register(app, deps) {
    const { getDB, logger, sensitivityService, settings } = deps;
    if (!sensitivityService) {
        console.warn('sensitivity.routes: service not wired');
        return;
    }

    // GET key params for strategy
    app.get('/api/sensitivity/key-params/:strategyId', (req, res) => {
        const kp = sensitivityService.getKeyParams(req.params.strategyId);
        res.json({ strategyId: req.params.strategyId, keyParams: kp || [] });
    });

    // POST run
    app.post('/api/sensitivity/run', async (req, res, next) => {
        try {
            const opts = req.body || {};
            const db = getDB();
            const jobDoc = {
                type: 'sensitivity',
                payload: opts,
                status: 'QUEUED',
                progress: { current: 0, total: 10, message: 'در صف' },
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
                    await sensitivityService.runSensitivity(jobId, opts);
                } catch (e) {
                    logger && logger.error('sensitivity: ' + e.message);
                    await db.collection(COLLECTIONS.BACKTEST_JOBS).updateOne(
                        { _id: r.insertedId },
                        { $set: { status: 'FAILED', error: e.message, finishedAt: new Date() } }
                    );
                }
            })();

            res.json({ jobId, status: 'QUEUED' });
        } catch (e) { next(e); }
    });

    // GET job status
    app.get('/api/sensitivity/:jobId', async (req, res, next) => {
        try {
            if (!/^[a-f0-9]{24}$/i.test(req.params.jobId)) {
                return res.status(400).json({ error: 'invalid id' });
            }
            const job = await getDB().collection(COLLECTIONS.BACKTEST_JOBS)
                .findOne({ _id: new ObjectId(req.params.jobId) });
            if (!job) return res.status(404).json({ error: 'not found' });
            res.json({
                _id: String(job._id),
                type: job.type,
                status: job.status,
                progress: job.progress,
                result: job.result,
                error: job.error,
                createdAt: job.createdAt,
                startedAt: job.startedAt,
                finishedAt: job.finishedAt,
            });
        } catch (e) { next(e); }
    });

    // POST apply best params
    app.post('/api/sensitivity/apply/:jobId', async (req, res, next) => {
        try {
            const { params } = req.body || {};
            if (!params || typeof params !== 'object') {
                return res.status(400).json({ error: 'params required' });
            }
            const db = getDB();
            const job = await db.collection(COLLECTIONS.BACKTEST_JOBS)
                .findOne({ _id: new ObjectId(req.params.jobId) });
            if (!job || !job.result) return res.status(404).json({ error: 'job not found' });

            const sid = job.result.strategyId;

            // Archive current defaults
            const cur = await db.collection(COLLECTIONS.META)
                .findOne({ _id: 'strategy_defaults' });
            const archiveDoc = {
                archivedAt: new Date(),
                reason: 'sensitivity-apply',
                jobId: String(req.params.jobId),
                strategyId: sid,
                values: (cur && cur.values) || {},
            };
            const insR = await db.collection('strategy_configs_archive').insertOne(archiveDoc);

            // Merge
            const existing = (cur && cur.values) || {};
            existing[sid] = { ...(existing[sid] || {}), ...params };

            await db.collection(COLLECTIONS.META).updateOne(
                { _id: 'strategy_defaults' },
                { $set: { values: existing } },
                { upsert: true }
            );
            if (settings && settings.saveStrategyDefaults) {
                await settings.saveStrategyDefaults(existing);
            }

            // Update configs with this strategy
            const upd = await db.collection(COLLECTIONS.STRATEGY_CONFIGS).updateMany(
                { strategyId: sid },
                { $set: { params: { ...(existing[sid] || {}) } } }
            );

            res.json({
                ok: true,
                updated: upd.modifiedCount,
                params,
                archiveId: String(insR.insertedId),
            });
        } catch (e) { next(e); }
    });

    // POST rollback by archive id
    app.post('/api/sensitivity/rollback/:archiveId', async (req, res, next) => {
        try {
            if (!/^[a-f0-9]{24}$/i.test(req.params.archiveId)) {
                return res.status(400).json({ error: 'invalid archiveId' });
            }
            const db = getDB();
            const doc = await db.collection('strategy_configs_archive')
                .findOne({ _id: new ObjectId(req.params.archiveId) });
            if (!doc) return res.status(404).json({ error: 'archive not found' });

            await db.collection(COLLECTIONS.META).updateOne(
                { _id: 'strategy_defaults' },
                { $set: { values: doc.values || {} } },
                { upsert: true }
            );
            if (settings && settings.saveStrategyDefaults) {
                await settings.saveStrategyDefaults(doc.values || {});
            }
            // Update configs for that strategy
            if (doc.strategyId) {
                await db.collection(COLLECTIONS.STRATEGY_CONFIGS).updateMany(
                    { strategyId: doc.strategyId },
                    { $set: { params: { ...((doc.values || {})[doc.strategyId] || {}) } } }
                );
            }
            res.json({ ok: true, restored: doc });
        } catch (e) { next(e); }
    });
}

module.exports = { register };
