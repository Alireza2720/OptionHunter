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
            const hasList = Array.isArray(body.strategies) && body.strategies.length > 0;
            if (!body.allStrategies && !body.strategyId && !hasList) {
                return res.status(400).json({ error: 'allStrategies یا strategyId یا strategies[] لازم است' });
            }
            // BUG-4 fix: validate mode
            const _VALID_MODES = ['stock', 'option', 'both'];
            if (body.mode && !_VALID_MODES.includes(body.mode)) {
                return res.status(400).json({ error: 'mode باید یکی از: ' + _VALID_MODES.join(', ') });
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
                    // BUG-3 fix: trim large arrays before saving
                    const _trimmedResult = {
                        totalStrategies: result.totalStrategies,
                        completed: result.completed,
                        paused: result.paused,
                        results: (result.results || []).map(function (x) {
                            return {
                                strategyId: x.strategyId,
                                done: x.done, paused: x.paused, cancelled: x.cancelled,
                                error: x.error, generation: x.generation,
                                best: x.best ? { params: x.best.params, fitness: x.best.fitness, stats: x.best.stats } : null,
                                bestEquityCurve: x.bestEquityCurve ? x.bestEquityCurve.slice(0, 300) : null,
                                pruner: x.pruner ? { prunedCount: x.pruner.prunedCount, historySize: x.pruner.historySize, pruned: x.pruner.pruned } : null
                            };
                        })
                    };
                    await db.collection(COLLECTIONS.BACKTEST_JOBS).updateOne(
                        { _id: r.insertedId },
                        { $set: { status: 'DONE', result: _trimmedResult, finishedAt: new Date(), updatedAt: new Date() } }
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
                    'best.fitness': 1,
                    'best.stats.totalTrades': 1,
                    'best.stats.winRate': 1,
                    'best.stats.profitFactor': 1,
                    'best.stats.sharpe': 1,
                    'best.stats.maxDrawdownPct': 1,
                    'best.stats.totalReturnPct': 1,
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
            const db = getDB();
            const _job = await db.collection(COLLECTIONS.BACKTEST_JOBS).findOne({ _id: new ObjectId(req.params.jobId) });
            await db.collection(COLLECTIONS.BACKTEST_JOBS).updateOne(
                { _id: new ObjectId(req.params.jobId) },
                { $set: { cancelRequested: true, status: 'CANCELLED', finishedAt: new Date(), updatedAt: new Date() } }
            );
            // BUG-2 fix: also cancel any paused states
            if (_job) {
                const _pl = _job.payload || {};
                if (_pl.allStrategies) {
                    await db.collection('meta').updateMany(
                        { _id: { $regex: '^ga_state_' }, status: 'paused' },
                        { $set: { status: 'cancelled', updatedAt: new Date() } }
                    );
                } else if (_pl.strategyId) {
                    await db.collection('meta').updateOne(
                        { _id: 'ga_state_' + _pl.strategyId },
                        { $set: { status: 'cancelled', updatedAt: new Date() } }
                    );
                } else if (Array.isArray(_pl.strategies)) {
                    for (const _sid of _pl.strategies) {
                        await db.collection('meta').updateOne(
                            { _id: 'ga_state_' + _sid },
                            { $set: { status: 'cancelled', updatedAt: new Date() } }
                        );
                    }
                }
            }
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
    // POST /api/ga/smart-config — analyze data & recommend settings
    // ----------------------------------------------------------
    app.post('/api/ga/smart-config', async (req, res, next) => {
        try {
            const db = getDB();
            const symbols = await db.collection(COLLECTIONS.MONITORED_SYMBOLS).find({ enabled: true }).toArray();
            const symList = symbols.map(s => s.symbol);
            const since = new Date(Date.now() - 180 * 86400 * 1000);
            let symbolsWithOption = 0;
            let totalOptRows = 0;
            for (const s of symList) {
                try {
                    const cnt = await db.collection(COLLECTIONS.OPTION_HISTORY).countDocuments({
                        underlying: s, time: { $gte: since },
                        bid: { $gt: 0 }, ask: { $gt: 0 }
                    });
                    // BUG-13 fix: relative threshold
                    if (cnt >= 30) symbolsWithOption++;
                    totalOptRows += cnt;
                } catch (_) {}
            }
            const optionRatio = symList.length > 0 ? symbolsWithOption / symList.length : 0;
            let maxGen, trials, windows, reason;
            if (optionRatio >= 0.7 && totalOptRows >= 5000) {
                maxGen = 12; trials = 2; windows = 3;
                reason = '📊 ' + symbolsWithOption + ' از ' + symList.length + ' نماد آپشن کامل دارن — ترکیبی با وزن کامل';
            } else if (optionRatio >= 0.3 || totalOptRows >= 2000) {
                maxGen = 10; trials = 2; windows = 3;
                reason = '📊 ' + symbolsWithOption + ' از ' + symList.length + ' نماد آپشن دارن — ترکیبی با وزن پویا';
            } else if (totalOptRows > 0) {
                maxGen = 8; trials = 2; windows = 2;
                reason = '📊 داده آپشن محدود — سهم کامل، آپشن فقط برای نمادهای موجود';
            } else {
                maxGen = 10; trials = 2; windows = 3;
                reason = '📊 داده آپشن هنوز موجود نیست — فعلاً روی سهم، آپشن خودکار اضافه می‌شه';
            }
            res.json({
                mode: 'both',
                symbolsLimit: 0,
                maxGenerations: maxGen,
                trialsPerGeneration: trials,
                numWindows: windows,
                patience: 5,
                reason: reason,
                stats: {
                    totalSymbols: symList.length,
                    symbolsWithOption: symbolsWithOption,
                    totalOptRows: totalOptRows,
                    optionRatio: Math.round(optionRatio * 100) / 100
                }
            });
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