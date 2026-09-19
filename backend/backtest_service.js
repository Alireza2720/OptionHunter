'use strict';
// ======================== backtest_service.js ========================
// Job-based با:
// - Chunked execution (چند تکّه، بدون هنگ)
// - Incremental trade cache (6 ماه → 1 سال سریع)
// - Cancel / Pause support
// - Resource tracking per job

const { ObjectId } = require('mongodb');
const crypto = require('crypto');

let deps = null;
function init(d) { deps = d; }

// ==================== Cache Keys ====================
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

// ==================== Incremental Trade Cache ====================
// ساختار doc:
// {
//   _id: sigHash,
//   signature: {configId, strategyId, timeframe, htfTimeframe, candleType, params, mode},
//   coveredFrom, coveredTo: unix seconds,
//   trades: [...], tradeCount, computedAt, dataVersion
// }

function buildBacktestSignature(config, mode) {
    return {
        configId: String(config._id),
        strategyId: config.strategyId,
        timeframe: config.timeframe,
        htfTimeframe: config.htfTimeframe || '1d',
        candleType: config.candleType || 'heikin',
        params: config.params || {},
        mode: mode || 'hybrid'
    };
}

async function loadTradeCache(sigHash) {
    return deps.getDB().collection('backtest_trade_cache').findOne({ _id: sigHash });
}

async function saveTradeCache(sigHash, signature, coveredFrom, coveredTo, trades, dataVersion) {
    await deps.getDB().collection('backtest_trade_cache').updateOne(
        { _id: sigHash },
        {
            $set: {
                signature, coveredFrom, coveredTo,
                trades, tradeCount: trades.length,
                computedAt: new Date(), dataVersion
            }
        },
        { upsert: true }
    );
}

/**
 * Get trades for [from,to] with incremental caching.
 * computeFn(config, from, to, onProgress) должен برگردونه آرایه‌ای از trades
 * که هر trade شامل entryTime (unix sec) باشه.
 */
async function getOrComputeTrades(config, from, to, mode, computeFn, onProgress) {
    const signature = buildBacktestSignature(config, mode);
    const sigHash = makeCacheKey(signature);
    const dataVersion = await getDataVersion();
    const cached = await loadTradeCache(sigHash);

    // A) هیچ cache نبود → همه رو compute کن
    if (!cached) {
        if (onProgress) onProgress({ phase: 'compute', from, to, cached: false });
        const trades = await computeFn(config, from, to);
        await saveTradeCache(sigHash, signature, from, to, trades, dataVersion);
        return { trades, cached: false, computedRanges: [[from, to]], signature: sigHash };
    }

    // B) cache کامل پوشش می‌ده
    if (cached.coveredFrom <= from && cached.coveredTo >= to) {
        const filtered = cached.trades.filter(t => t.entryTime >= from && t.entryTime <= to);
        return { trades: filtered, cached: true, computedRanges: [], signature: sigHash };
    }

    // C) بعد به آینده اضافه شده → فقط دلتا رو compute کن و append کن
    if (from >= cached.coveredFrom && to > cached.coveredTo) {
        if (onProgress) onProgress({ phase: 'extend-future', from: cached.coveredTo, to, cached: false });
        const newTrades = await computeFn(config, cached.coveredTo, to);
        const merged = [...cached.trades, ...newTrades].sort((a, b) => a.entryTime - b.entryTime);
        await saveTradeCache(sigHash, signature, cached.coveredFrom, to, merged, dataVersion);
        const filtered = merged.filter(t => t.entryTime >= from && t.entryTime <= to);
        return {
            trades: filtered,
            cached: false,
            computedRanges: [[cached.coveredTo, to]],
            signature: sigHash,
            reusedFromCache: cached.trades.length
        };
    }

    // D) قبل به عقب اضافه شده → کل بازه جدید رو compute کن (چون warm-up عوض می‌شه)
    if (from < cached.coveredFrom) {
        if (onProgress) onProgress({ phase: 'extend-past', from, to: cached.coveredTo, cached: false });
        const pastTrades = await computeFn(config, from, cached.coveredTo);
        let merged = pastTrades;
        if (to > cached.coveredTo) {
            const futureTrades = await computeFn(config, cached.coveredTo, to);
            merged = [...pastTrades, ...futureTrades].sort((a, b) => a.entryTime - b.entryTime);
        } else {
            merged = pastTrades.sort((a, b) => a.entryTime - b.entryTime);
        }
        const newCoveredFrom = from;
        const newCoveredTo = Math.max(to, cached.coveredTo);
        await saveTradeCache(sigHash, signature, newCoveredFrom, newCoveredTo, merged, dataVersion);
        const filtered = merged.filter(t => t.entryTime >= from && t.entryTime <= to);
        return {
            trades: filtered,
            cached: false,
            computedRanges: [[from, cached.coveredTo], ...(to > cached.coveredTo ? [[cached.coveredTo, to]] : [])],
            signature: sigHash
        };
    }

    // fallback
    const trades = await computeFn(config, from, to);
    await saveTradeCache(sigHash, signature, from, to, trades, dataVersion);
    return { trades, cached: false, computedRanges: [[from, to]], signature: sigHash };
}

async function clearTradeCache() {
    return deps.getDB().collection('backtest_trade_cache').deleteMany({});
}

async function invalidateCacheForConfig(configId) {
    // حذف تمام کش‌های مربوط به این configId (وقتی params تغییر کرد)
    return deps.getDB().collection('backtest_trade_cache').deleteMany({
        'signature.configId': String(configId)
    });
}

// ==================== Job Management ====================
async function createJob(type, payload, chunksPlan) {
    const db = deps.getDB();
    const chunks = (chunksPlan || []).map((c, i) => ({
        idx: i,
        label: c.label || `chunk-${i}`,
        status: 'PENDING',
        items: c.items || [],
        from: c.from || null,
        to: c.to || null,
        tradesCount: 0,
        startedAt: null,
        finishedAt: null,
        error: null
    }));
    const doc = {
        type,
        payload,
        status: 'QUEUED',
        cancelRequested: false,
        progress: {
            current: 0,
            total: chunks.length || 1,
            message: 'در صف',
            chunks
        },
        result: null,
        error: null,
        resourceStats: { peakRssMB: 0, totalCpuMs: 0, chunksDone: 0 },
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
        {
            $set: {
                'progress.current': current,
                'progress.total': total,
                'progress.message': message || '',
                updatedAt: new Date()
            }
        }
    );
}

async function updateChunk(id, idx, fields) {
    const db = deps.getDB();
    const set = {};
    for (const k of Object.keys(fields)) set[`progress.chunks.${idx}.${k}`] = fields[k];
    set.updatedAt = new Date();
    await db.collection('backtest_jobs').updateOne({ _id: new ObjectId(id) }, { $set: set });
}

async function getJob(id) {
    return deps.getDB().collection('backtest_jobs').findOne({ _id: new ObjectId(id) });
}

async function listJobs(limit = 50, onlyActive = false) {
    const q = onlyActive ? { status: { $in: ['QUEUED', 'RUNNING', 'PAUSED'] } } : {};
    return deps.getDB().collection('backtest_jobs')
        .find(q).sort({ createdAt: -1 }).limit(limit).toArray();
}

async function cancelJob(id) {
    await deps.getDB().collection('backtest_jobs').updateOne(
        { _id: new ObjectId(id), status: { $in: ['QUEUED', 'RUNNING', 'PAUSED'] } },
        { $set: { cancelRequested: true, updatedAt: new Date() } }
    );
}

async function forceCancelJob(id) {
    await deps.getDB().collection('backtest_jobs').updateOne(
        { _id: new ObjectId(id) },
        {
            $set: {
                status: 'CANCELLED',
                cancelRequested: true,
                finishedAt: new Date(),
                updatedAt: new Date()
            }
        }
    );
}

async function deleteJob(id) {
    await deps.getDB().collection('backtest_jobs').deleteOne({ _id: new ObjectId(id) });
}

async function isCancelled(id) {
    const j = await deps.getDB().collection('backtest_jobs').findOne(
        { _id: new ObjectId(id) }, { projection: { cancelRequested: 1, status: 1 } }
    );
    return !!(j && (j.cancelRequested || j.status === 'CANCELLED'));
}

async function finishJob(id, result, status, error, resourceStats) {
    const db = deps.getDB();
    const set = {
        status,
        result: result || null,
        error: error ? String(error) : null,
        finishedAt: new Date(),
        updatedAt: new Date()
    };
    if (resourceStats) set.resourceStats = resourceStats;
    await db.collection('backtest_jobs').updateOne({ _id: new ObjectId(id) }, { $set: set });
}

// ==================== Processor ====================
let processorRunning = false;

async function processQueue() {
    if (processorRunning) return;
    processorRunning = true;
    try {
        const db = deps.getDB();
        while (true) {
            // ⚠️ MongoDB driver v6 → findOneAndUpdate مستقیم document برمی‌گردونه (نه {value})
            const j = await db.collection('backtest_jobs').findOneAndUpdate(
                { status: 'QUEUED' },
                { $set: { status: 'RUNNING', startedAt: new Date(), updatedAt: new Date() } },
                { sort: { createdAt: 1 }, returnDocument: 'after' }
            );
            if (!j) break;

            const jobId = j._id;
            const startRss = process.memoryUsage().rss;
            const startCpu = process.cpuUsage();

            try {
                let result;
                if (j.type === 'backtest') result = await deps.runBacktestJob(j);
                else if (j.type === 'auto-config') result = await deps.runAutoConfigJob(j);
                else if (j.type === 'backtest-compare') result = await deps.runBacktestCompareJob(j);
                else throw new Error('نوع job نامعتبر');

                if (await isCancelled(jobId)) {
                    await finishJob(jobId, null, 'CANCELLED', null, null);
                    continue;
                }

                const cpuNow = process.cpuUsage(startCpu);
                const rssNow = process.memoryUsage().rss;
                await finishJob(jobId, result, 'DONE', null, {
                    peakRssMB: Math.round(Math.max(rssNow, startRss) / 1048576),
                    totalCpuMs: Math.round((cpuNow.user + cpuNow.system) / 1000)
                });
            } catch (e) {
                if (await isCancelled(jobId)) {
                    await finishJob(jobId, null, 'CANCELLED', null, null);
                } else {
                    await finishJob(jobId, null, 'FAILED', e.message, null);
                }
            }
        }
    } finally {
        processorRunning = false;
    }
}

// ==================== Routes ====================
function registerRoutes(app) {
    // Create backtest job
    app.post('/api/jobs/backtest', async (req, res, next) => {
        try {
            const { configId, from, to, useRealOption, useOnlineData, forceRecompute } = req.body || {};
            if (!configId) return res.status(400).json({ error: 'configId الزامی' });
            const cfg = await deps.getDB().collection('strategy_configs').findOne({ _id: new ObjectId(configId) });
            if (!cfg) return res.status(404).json({ error: 'تنظیم یافت نشد' });

            const job = await createJob('backtest', {
                configId, from, to,
                useRealOption: !!useRealOption,
                useOnlineData: !!useOnlineData,
                forceRecompute: !!forceRecompute
            }, [{ label: 'backtest', from, to }]);
            res.json({ jobId: String(job._id), status: 'QUEUED' });
            processQueue().catch(e => console.error('Queue:', e.message));
        } catch (e) { next(e); }
    });

    // Create auto-config job
    app.post('/api/jobs/auto-config', async (req, res, next) => {
        try {
            const { symbol, symbols, maxConfirmers, from, to, dryRun } = req.body || {};
            const targets = symbol ? [symbol] : (Array.isArray(symbols) ? symbols : []);
            if (!targets.length) return res.status(400).json({ error: 'حداقل یک نماد' });

            // هر نماد = یک chunk
            const chunks = targets.map(s => ({ label: s, items: [s] }));
            const job = await createJob('auto-config', {
                symbols: targets,
                maxConfirmers: maxConfirmers || 2,
                from, to,
                dryRun: !!dryRun
            }, chunks);
            res.json({ jobId: String(job._id), status: 'QUEUED' });
            processQueue().catch(e => console.error('Queue:', e.message));
        } catch (e) { next(e); }
    });

    // Get single job
    app.get('/api/jobs/:id', async (req, res, next) => {
        try {
            const job = await getJob(req.params.id);
            if (!job) return res.status(404).json({ error: 'Job یافت نشد' });
            res.json({
                _id: job._id, type: job.type, status: job.status,
                cancelRequested: job.cancelRequested,
                progress: job.progress, result: job.result, error: job.error,
                resourceStats: job.resourceStats,
                createdAt: job.createdAt, startedAt: job.startedAt, finishedAt: job.finishedAt
            });
        } catch (e) { next(e); }
    });

    // List jobs
    app.get('/api/jobs', async (req, res, next) => {
        try {
            const limit = Math.min(+req.query.limit || 30, 100);
            const onlyActive = req.query.active !== '0' && req.query.all !== '1';
            res.json({ jobs: await listJobs(limit, onlyActive) });
        } catch (e) { next(e); }
    });

    // Cancel (soft — علامت می‌ذاره، پروسه خودش می‌ایسته)
    app.post('/api/jobs/:id/cancel', async (req, res, next) => {
        try { await cancelJob(req.params.id); res.json({ success: true }); }
        catch (e) { next(e); }
    });

    // Force cancel (سخت)
    app.post('/api/jobs/:id/force-cancel', async (req, res, next) => {
        try { await forceCancelJob(req.params.id); res.json({ success: true }); }
        catch (e) { next(e); }
    });

    // Delete job
    app.delete('/api/jobs/:id', async (req, res, next) => {
        try { await deleteJob(req.params.id); res.json({ success: true }); }
        catch (e) { next(e); }
    });

    // Clear old finished jobs
    app.post('/api/jobs/clear-old', async (req, res, next) => {
        try {
            const cutoff = new Date(Date.now() - 24 * 3600 * 1000);
            const r = await deps.getDB().collection('backtest_jobs').deleteMany({
                status: { $in: ['DONE', 'FAILED', 'CANCELLED'] },
                finishedAt: { $lt: cutoff }
            });
            res.json({ success: true, deleted: r.deletedCount });
        } catch (e) { next(e); }
    });

    // Cache management
    app.delete('/api/jobs/cache/clear', async (req, res, next) => {
        try { const r = await clearTradeCache(); res.json({ success: true, deleted: r.deletedCount }); }
        catch (e) { next(e); }
    });

    app.get('/api/jobs/cache/stats', async (req, res, next) => {
        try {
            const db = deps.getDB();
            const count = await db.collection('backtest_trade_cache').countDocuments();
            const recent = await db.collection('backtest_trade_cache').find({}, {
                projection: { tradeCount: 1, coveredFrom: 1, coveredTo: 1, computedAt: 1, signature: 1 }
            }).sort({ computedAt: -1 }).limit(20).toArray();
            res.json({ cacheCount: count, recent });
        } catch (e) { next(e); }
    });
}

module.exports = {
    init, registerRoutes,
    createJob, getJob, listJobs,
    cancelJob, forceCancelJob, deleteJob,
    isCancelled, updateProgress, updateChunk,
    finishJob, processQueue,
    makeCacheKey, getDataVersion, bumpDataVersion,
    getOrComputeTrades, clearTradeCache, invalidateCacheForConfig
};