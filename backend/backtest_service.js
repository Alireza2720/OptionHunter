'use strict';
// ======================== backtest_service.js ========================
// سیستم Job-based برای بک‌تست و تنظیم خودکار
// - اجرا در پس‌زمینه
// - Cache نتیجه‌ها
// - Progress tracking

const { ObjectId } = require('mongodb');
const crypto = require('crypto');

let deps = null;
function init(d) { deps = d; }

// ==================== Cache ====================
function makeCacheKey(parts) {
    return crypto.createHash('md5').update(JSON.stringify(parts)).digest('hex');
}

async function getDataVersion() {
    const db = deps.getDB();
    const doc = await db.collection('meta').findOne({ _id: 'data_version' });
    return (doc && doc.version) || 1;
}

async function bumpDataVersion() {
    const db = deps.getDB();
    await db.collection('meta').updateOne(
        { _id: 'data_version' },
        { $inc: { version: 1 }, $set: { updatedAt: new Date() } },
        { upsert: true }
    );
}

async function getFromCache(key) {
    const db = deps.getDB();
    const doc = await db.collection('backtest_cache').findOne({ _id: key });
    if (!doc) return null;
    if (Date.now() - new Date(doc.createdAt).getTime() > 7 * 86400 * 1000) {
        await db.collection('backtest_cache').deleteOne({ _id: key });
        return null;
    }
    return doc.result;
}

async function saveToCache(key, result, meta) {
    const db = deps.getDB();
    await db.collection('backtest_cache').updateOne(
        { _id: key },
        { $set: { result, meta, createdAt: new Date() } },
        { upsert: true }
    );
}

// ==================== Job Management ====================
async function createJob(type, payload) {
    const db = deps.getDB();
    const doc = {
        type,
        payload,
        status: 'QUEUED',
        progress: { current: 0, total: 0, message: 'در صف' },
        result: null,
        error: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        startedAt: null,
        finishedAt: null
    };
    const r = await db.collection('backtest_jobs').insertOne(doc);
    return { _id: r.insertedId, ...doc };
}

async function updateProgress(id, current, total, message) {
    const db = deps.getDB();
    await db.collection('backtest_jobs').updateOne(
        { _id: new ObjectId(id) },
        { $set: { 'progress.current': current, 'progress.total': total, 'progress.message': message || '', updatedAt: new Date() } }
    );
}

async function getJob(id) {
    const db = deps.getDB();
    return db.collection('backtest_jobs').findOne({ _id: new ObjectId(id) });
}

async function listJobs(limit = 20) {
    const db = deps.getDB();
    return db.collection('backtest_jobs').find({}).sort({ createdAt: -1 }).limit(limit).toArray();
}

async function cancelJob(id) {
    const db = deps.getDB();
    await db.collection('backtest_jobs').updateOne(
        { _id: new ObjectId(id), status: { $in: ['QUEUED', 'RUNNING'] } },
        { $set: { status: 'CANCELLED', finishedAt: new Date(), updatedAt: new Date() } }
    );
}

// ==================== Processor ====================
let processorRunning = false;

async function processQueue() {
    if (processorRunning) return;
    processorRunning = true;
    try {
        const db = deps.getDB();
        while (true) {
            const job = await db.collection('backtest_jobs').findOneAndUpdate(
                { status: 'QUEUED' },
                { $set: { status: 'RUNNING', startedAt: new Date(), updatedAt: new Date() } },
                { sort: { createdAt: 1 }, returnDocument: 'after' }
            );
            if (!job.value) break;
            const j = job.value;
            try {
                let result;
                if (j.type === 'backtest') result = await deps.runBacktestJob(j);
                else if (j.type === 'auto-config') result = await deps.runAutoConfigJob(j);
                else throw new Error('نوع job نامعتبر');
                if (j.payload && j.payload.cacheKey) {
                    await saveToCache(j.payload.cacheKey, result, { type: j.type, at: new Date() });
                }
                await db.collection('backtest_jobs').updateOne(
                    { _id: j._id },
                    { $set: { status: 'DONE', result, finishedAt: new Date(), updatedAt: new Date() } }
                );
            } catch (e) {
                await db.collection('backtest_jobs').updateOne(
                    { _id: j._id },
                    { $set: { status: 'FAILED', error: e.message, finishedAt: new Date(), updatedAt: new Date() } }
                );
            }
        }
    } finally {
        processorRunning = false;
    }
}

// ==================== Routes ====================
function registerRoutes(app) {
    app.post('/api/jobs/backtest', async (req, res, next) => {
        try {
            const { configId, from, to, useRealOption, useOnlineData } = req.body || {};
            if (!configId) return res.status(400).json({ error: 'configId الزامی' });
            const db = deps.getDB();
            const cfg = await db.collection('strategy_configs').findOne({ _id: new ObjectId(configId) });
            if (!cfg) return res.status(404).json({ error: 'تنظیم یافت نشد' });

            const dataVersion = await getDataVersion();
            const cacheKey = makeCacheKey({
                type: 'backtest',
                cfgId: configId,
                strategyId: cfg.strategyId,
                params: cfg.params,
                timeframe: cfg.timeframe,
                htfTimeframe: cfg.htfTimeframe,
                from: from || null,
                to: to || null,
                useRealOption: !!useRealOption,
                useOnlineData: !!useOnlineData,
                dataVersion
            });

            const cached = await getFromCache(cacheKey);
            if (cached) {
                return res.json({ jobId: null, status: 'DONE', fromCache: true, result: cached });
            }

            const job = await createJob('backtest', { configId, from, to, useRealOption, useOnlineData, cacheKey });
            res.json({ jobId: job._id.toString(), status: 'QUEUED', fromCache: false });
            processQueue().catch(e => console.error('Queue:', e.message));
        } catch (e) { next(e); }
    });

    app.post('/api/jobs/auto-config', async (req, res, next) => {
        try {
            const { symbol, symbols, maxConfirmers, from, to, dryRun } = req.body || {};
            const targets = symbol ? [symbol] : (Array.isArray(symbols) ? symbols : []);
            if (!targets.length) return res.status(400).json({ error: 'حداقل یک نماد' });

            const dataVersion = await getDataVersion();
            const cacheKey = makeCacheKey({
                type: 'autoconfig',
                symbols: targets,
                maxConfirmers: maxConfirmers || 2,
                from: from || null,
                to: to || null,
                dataVersion
            });

            const cached = await getFromCache(cacheKey);
            if (cached) {
                return res.json({ jobId: null, status: 'DONE', fromCache: true, result: cached });
            }

            const job = await createJob('auto-config', { symbols: targets, maxConfirmers, from, to, dryRun, cacheKey });
            res.json({ jobId: job._id.toString(), status: 'QUEUED', fromCache: false });
            processQueue().catch(e => console.error('Queue:', e.message));
        } catch (e) { next(e); }
    });

    app.get('/api/jobs/:id', async (req, res, next) => {
        try {
            const job = await getJob(req.params.id);
            if (!job) return res.status(404).json({ error: 'Job یافت نشد' });
            res.json({
                _id: job._id, type: job.type, status: job.status,
                progress: job.progress, result: job.result, error: job.error,
                createdAt: job.createdAt, startedAt: job.startedAt, finishedAt: job.finishedAt
            });
        } catch (e) { next(e); }
    });

    app.get('/api/jobs', async (req, res, next) => {
        try {
            const limit = Math.min(+req.query.limit || 20, 100);
            res.json({ jobs: await listJobs(limit) });
        } catch (e) { next(e); }
    });

    app.delete('/api/jobs/:id', async (req, res, next) => {
        try { await cancelJob(req.params.id); res.json({ success: true }); } catch (e) { next(e); }
    });

    app.delete('/api/jobs/cache/clear', async (req, res, next) => {
        try {
            const r = await deps.getDB().collection('backtest_cache').deleteMany({});
            res.json({ success: true, deleted: r.deletedCount });
        } catch (e) { next(e); }
    });
}

module.exports = {
    init, registerRoutes,
    createJob, getJob, listJobs, cancelJob,
    updateProgress, processQueue,
    getFromCache, saveToCache, makeCacheKey,
    getDataVersion, bumpDataVersion
};