'use strict';
// ============================================================
// ga.routes.js — endpoints for GA / parameter tuning
// ============================================================
// Requires singletons directly (they're init'd in bootstrap.js).
// ============================================================

const { ObjectId } = require('mongodb');
const { COLLECTIONS } = require('../../config/constants');
const gaOrch = require('../../services/ga-orchestrator.service');
const gaStopResume = require('../../services/ga-stop-resume.service');
const gaRedundancy = require('../../services/ga-redundancy.service');

function register(app, deps) {
    const { getDB, logger, settings } = deps;

    // ----------------------------------------------------------
    // POST /api/ga/start
    // body: { allStrategies?: bool, strategyId?: string, mode?, symbolsLimit?, ... }
    // ----------------------------------------------------------
    app.post('/api/ga/start', async (req, res, next) => {
        try {
            const body = req.body || {};
            if (!body.allStrategies && !body.strategyId) {
                return res.status(400).json({ error: 'allStrategies یا strategyId لازم است' });
            }

            // Memory guard
            try {
                const memGuard = require('../../infra/memory-guard');
                const chk = memGuard.canStartHeavyJob();
                if (!chk.ok) return res.status(503).json({ error: chk.reason, memory: chk.status });
            } catch (_) {}

            const db = getDB();
            const jobDoc = {
                type: 'ga',
                payload: body,
                status: 'QUEUED',
                progress: { current: 0, total: 1, message: 'در صف' },
                createdAt: new Date(),
                updatedAt: new Date()
            };
            const r = await db.collection(COLLECTIONS.BACKTEST_JOBS).insertOne(jobDoc);
            const jobId = String(r.insertedId);

            (async () => {
                try {
                    await db.collection(COLLECTIONS.BACKTEST_JOBS).updateOne(
                        { _id: r.insertedId },
                        { $set: { status: 'RUNNING', startedAt: new Date() } }
                    );
                    const result = await gaOrch.runGA(jobId, body);
                    await db.collection(COLLECTIONS.BACKTEST_JOBS).updateOne(
                        { _id: r.insertedId },
                        { $set: { status: 'DONE', result, finishedAt: new Date(), updatedAt: new Date() } }
                    );
                    if (deps.notify) {
                        const doneCount = (result && result.completed) || 0;
                        const pausedCount = (result && result.paused) || 0;
                        await deps.notify('✅ GA تمام شد — ' + doneCount + ' کامل، ' + pausedCount + ' pause').catch(() => {});
                    }
                } catch (e) {
                    logger && logger.error('ga bg: ' + e.message);
                    await db.collection(COLLECTIONS.BACKTEST_JOBS).updateOne(
                        { _id: r.insertedId },
                        { $set: { status: 'FAILED', error: e.message, finishedAt: new Date() } }
                    );
                }
            })();

            res.json({ jobId, status: 'QUEUED' });
        } catch (e) { next(e); }
    });

    // ----------------------------------------------------------
    // GET /api/ga/jobs/list?limit=20
    // ----------------------------------------------------------
    app.get('/api/ga/jobs/list', async (req, res, next) => {
        try {
            const limit = Math.min(+(req.query.limit || 20), 100);
            const jobs = await getDB().collection(COLLECTIONS.BACKTEST_JOBS)
                .find({ type: 'ga' })
                .sort({ createdAt: -1 })
                .limit(limit)
                .project({
                    _id: 1, status: 1, createdAt: 1, startedAt: 1, finishedAt: 1,
                    'payload.strategyId': 1, 'payload.allStrategies': 1,
                    'progress.current': 1, 'progress.total': 1, 'progress.message': 1,
                    'result.completed': 1, 'result.paused': 1, 'result.totalStrategies': 1
                })
                .toArray();
            res.json({ jobs });
        } catch (e) { next(e); }
    });

    // ----------------------------------------------------------
    // GET /api/ga/jobs/:jobId
    // ----------------------------------------------------------
    app.get('/api/ga/jobs/:jobId', async (req, res, next) => {
        try {
            if (!/^[a-f0-9]{24}$/i.test(req.params.jobId)) {
                return res.status(400).json({ error: 'jobId نامعتبر' });
            }
            const j = await getDB().collection(COLLECTIONS.BACKTEST_JOBS)
                .findOne({ _id: new ObjectId(req.params.jobId) });
            if (!j) return res.status(404).json({ error: 'not found' });
            res.json({
                _id: String(j._id),
                status: j.status,
                payload: j.payload,
                progress: j.progress,
                result: j.result,
                error: j.error,
                createdAt: j.createdAt,
                startedAt: j.startedAt,
                finishedAt: j.finishedAt
            });
        } catch (e) { next(e); }
    });

    // ----------------------------------------------------------
    // GET /api/ga/state/:strategyId
    // ----------------------------------------------------------
    app.get('/api/ga/state/:strategyId', async (req, res, next) => {
        try {
            const st = await gaStopResume.loadState(getDB, req.params.strategyId);
            if (!st) return res.status(404).json({ error: 'state not found' });
            res.json(st);
        } catch (e) { next(e); }
    });

    // ----------------------------------------------------------
    // GET /api/ga/states
    // ----------------------------------------------------------
    app.get('/api/ga/states', async (req, res, next) => {
        try {
            const list = await getDB().collection('meta')
                .find({ _id: { $regex: '^ga_state_' } })
                .project({
                    strategyId: 1, status: 1,
                    generation: 1,
                    'best.fitness': 1, 'best.params': 1, 'best.stats': 1,
                    startedAt: 1, stoppedAt: 1, updatedAt: 1, resumeAfter: 1
                })
                .toArray();
            res.json({ count: list.length, states: list });
        } catch (e) { next(e); }
    });

    // ----------------------------------------------------------
    // POST /api/ga/cancel/:jobId
    // ----------------------------------------------------------
    app.post('/api/ga/cancel/:jobId', async (req, res, next) => {
        try {
            if (!/^[a-f0-9]{24}$/i.test(req.params.jobId)) {
                return res.status(400).json({ error: 'jobId نامعتبر' });
            }
            await getDB().collection(COLLECTIONS.BACKTEST_JOBS).updateOne(
                { _id: new ObjectId(req.params.jobId) },
                { $set: { cancelRequested: true, updatedAt: new Date() } }
            );
            res.json({ ok: true });
        } catch (e) { next(e); }
    });

    // ----------------------------------------------------------
    // POST /api/ga/resume/:strategyId
    // ----------------------------------------------------------
    app.post('/api/ga/resume/:strategyId', async (req, res, next) => {
        try {
            const sid = req.params.strategyId;
            const st = await gaStopResume.loadState(getDB, sid);
            if (!st) return res.status(404).json({ error: 'state not found' });
            // Clear resumeAfter so next cron picks it up immediately
            await getDB().collection('meta').updateOne(
                { _id: 'ga_state_' + sid },
                { $set: { status: 'paused', resumeAfter: new Date(0), updatedAt: new Date() } }
            );
            res.json({ ok: true, note: 'الان روی صف resume قرار گرفت — تا ۵ دقیقه اجرا می‌شود' });
        } catch (e) { next(e); }
    });

    // ----------------------------------------------------------
    // POST /api/ga/apply/:strategyId
    // body: { params: {...} }
    // ----------------------------------------------------------
    app.post('/api/ga/apply/:strategyId', async (req, res, next) => {
        try {
            const sid = req.params.strategyId;
            const { params } = req.body || {};
            if (!params || typeof params !== 'object') {
                return res.status(400).json({ error: 'params لازم است' });
            }
            const db = getDB();

            // Archive current strategy_defaults
            const cur = await db.collection(COLLECTIONS.META).findOne({ _id: 'strategy_defaults' });
            const archiveDoc = {
                archivedAt: new Date(),
                reason: 'ga-apply',
                strategyId: sid,
                values: (cur && cur.values) || {}
            };
            const insR = await db.collection('strategy_configs_archive').insertOne(archiveDoc);

            // Merge & save
            const existing = (cur && cur.values) || {};
            existing[sid] = Object.assign({}, existing[sid] || {}, params);

            await db.collection(COLLECTIONS.META).updateOne(
                { _id: 'strategy_defaults' },
                { $set: { values: existing } },
                { upsert: true }
            );
            if (settings && settings.saveStrategyDefaults) {
                await settings.saveStrategyDefaults(existing);
            }

            // Update all configs with this strategy
            const upd = await db.collection(COLLECTIONS.STRATEGY_CONFIGS).updateMany(
                { strategyId: sid },
                { $set: { params: Object.assign({}, existing[sid] || {}) } }
            );

            res.json({ ok: true, updated: upd.modifiedCount, params, archiveId: String(insR.insertedId) });
        } catch (e) { next(e); }
    });

    // ----------------------------------------------------------
    // POST /api/ga/rollback/:archiveId
    // ----------------------------------------------------------
    app.post('/api/ga/rollback/:archiveId', async (req, res, next) => {
        try {
            const aid = req.params.archiveId;
            if (!/^[a-f0-9]{24}$/i.test(aid)) return res.status(400).json({ error: 'invalid id' });
            const db = getDB();
            const doc = await db.collection('strategy_configs_archive').findOne({ _id: new ObjectId(aid) });
            if (!doc) return res.status(404).json({ error: 'archive not found' });

            await db.collection(COLLECTIONS.META).updateOne(
                { _id: 'strategy_defaults' },
                { $set: { values: doc.values || {} } },
                { upsert: true }
            );
            if (settings && settings.saveStrategyDefaults) {
                await settings.saveStrategyDefaults(doc.values || {});
            }
            if (doc.strategyId) {
                await db.collection(COLLECTIONS.STRATEGY_CONFIGS).updateMany(
                    { strategyId: doc.strategyId },
                    { $set: { params: Object.assign({}, (doc.values || {})[doc.strategyId] || {}) } }
                );
            }
            res.json({ ok: true, restored: doc });
        } catch (e) { next(e); }
    });

    // ----------------------------------------------------------
    // POST /api/ga/redundancy
    // body: { threshold? } — default 0.95
    // ----------------------------------------------------------
    app.post('/api/ga/redundancy', async (req, res, next) => {
        try {
            const threshold = +(req.body && req.body.threshold) || 0.95;
            const db = getDB();
            // Collect equity curves from all done states
            const states = await db.collection('meta')
                .find({ _id: { $regex: '^ga_state_' } })
                .toArray();
            const items = [];
            for (const st of states) {
                if (!st.best || !st.bestEquityCurve) continue;
                items.push({
                    strategyId: st.strategyId,
                    fitness: (st.best && st.best.fitness) || 0,
                    equityCurve: st.bestEquityCurve
                });
            }
            if (items.length < 2) {
                return res.json({ pairs: [], toDrop: [], note: 'کمتر از ۲ استراتژی با equity curve' });
            }
            const r = gaRedundancy.findRedundant(items, threshold);
            await db.collection('meta').updateOne(
                { _id: 'ga_redundancy' },
                { $set: Object.assign({}, r, { computedAt: new Date() }) },
                { upsert: true }
            );
            res.json(r);
        } catch (e) { next(e); }
    });

    logger && logger.info('[ga] routes registered');
}

module.exports = { register };