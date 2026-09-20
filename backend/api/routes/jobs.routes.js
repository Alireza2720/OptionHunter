'use strict';
// ============================================================
// jobs.routes.js — مدیریت job ها
// ============================================================

const { COLLECTIONS } = require('../../config/constants');

function register(app, deps) {
    const { backtestService } = deps;

    // ---- Backtest job ----
    app.post('/api/jobs/backtest', async (req, res, next) => {
        try {
            const { configId, from, to, useRealOption, useOnlineData, forceRecompute } = req.body || {};
            if (!configId) return res.status(400).json({ error: 'configId الزامی' });

            const cfg = await deps.getDB().collection(COLLECTIONS.STRATEGY_CONFIGS)
                .findOne({ _id: new (require('mongodb').ObjectId)(configId) });
            if (!cfg) return res.status(404).json({ error: 'تنظیم یافت نشد' });

            if (forceRecompute) {
                await backtestService.invalidateCacheForConfig(configId).catch(() => {});
            }

            const job = await backtestService.createJob('backtest', {
                configId, from, to,
                useRealOption: !!useRealOption,
                useOnlineData: !!useOnlineData,
                forceRecompute: !!forceRecompute
            }, [{ label: 'backtest', from, to }]);

            res.json({ jobId: String(job._id), status: 'QUEUED' });
            backtestService.processQueue().catch(() => {});
        } catch (e) { next(e); }
    });

    // ---- Auto-config job ----
    app.post('/api/jobs/auto-config', async (req, res, next) => {
        try {
            const { symbol, symbols, maxConfirmers, from, to, dryRun } = req.body || {};
            const targets = symbol ? [symbol] : (Array.isArray(symbols) ? symbols : []);
            if (!targets.length) return res.status(400).json({ error: 'حداقل یک نماد' });

            const chunks = targets.map(s => ({ label: s, items: [s] }));
            const job = await backtestService.createJob('auto-config', {
                symbols: targets,
                maxConfirmers: maxConfirmers || 2,
                from, to,
                dryRun: !!dryRun
            }, chunks);

            res.json({ jobId: String(job._id), status: 'QUEUED' });
            backtestService.processQueue().catch(() => {});
        } catch (e) { next(e); }
    });

    // ---- Backtest compare job ----
    app.post('/api/jobs/backtest-compare', async (req, res, next) => {
        try {
            const { symbols, strategies, useRealOption, dateFrom, dateTo } = req.body || {};
            if (!Array.isArray(symbols) || !symbols.length) {
                return res.status(400).json({ error: 'حداقل یک نماد' });
            }
            if (!Array.isArray(strategies) || !strategies.length) {
                return res.status(400).json({ error: 'حداقل یک استراتژی' });
            }

            const chunks = symbols.map(s => ({ label: s, items: [s] }));
            const job = await backtestService.createJob('backtest-compare', {
                symbols, strategies,
                useRealOption: !!useRealOption,
                dateFrom: dateFrom ? parseInt(dateFrom) : null,
                dateTo: dateTo ? parseInt(dateTo) : null
            }, chunks);

            res.json({ jobId: String(job._id), status: 'QUEUED' });
            backtestService.processQueue().catch(() => {});
        } catch (e) { next(e); }
    });

    // ---- Get single job ----
    app.get('/api/jobs/:id', async (req, res, next) => {
        try {
            const job = await backtestService.getJob(req.params.id);
            if (!job) return res.status(404).json({ error: 'Job یافت نشد' });
            res.json({
                _id: job._id, type: job.type, status: job.status,
                cancelRequested: job.cancelRequested,
                progress: job.progress,
                result: job.result,
                error: job.error,
                resourceStats: job.resourceStats,
                createdAt: job.createdAt,
                startedAt: job.startedAt,
                finishedAt: job.finishedAt
            });
        } catch (e) { next(e); }
    });

    // ---- List jobs ----
    app.get('/api/jobs', async (req, res, next) => {
        try {
            const limit = Math.min(+req.query.limit || 30, 100);
            const onlyActive = req.query.active !== '0' && req.query.all !== '1';
            res.json({ jobs: await backtestService.listJobs(limit, onlyActive) });
        } catch (e) { next(e); }
    });

    // ---- Cancel ----
    app.post('/api/jobs/:id/cancel', async (req, res, next) => {
        try {
            await backtestService.cancelJob(req.params.id);
            res.json({ success: true });
        } catch (e) { next(e); }
    });

    // ---- Force cancel ----
    app.post('/api/jobs/:id/force-cancel', async (req, res, next) => {
        try {
            await backtestService.forceCancelJob(req.params.id);
            res.json({ success: true });
        } catch (e) { next(e); }
    });

    // ---- Delete ----
    app.delete('/api/jobs/:id', async (req, res, next) => {
        try {
            await backtestService.deleteJob(req.params.id);
            res.json({ success: true });
        } catch (e) { next(e); }
    });

    // ---- Clear old ----
    app.post('/api/jobs/clear-old', async (req, res, next) => {
        try {
            const n = await backtestService.cleanupOldJobs(1);
            res.json({ success: true, deleted: n });
        } catch (e) { next(e); }
    });

    // ---- Cache clear ----
    app.delete('/api/jobs/cache/clear', async (req, res, next) => {
        try {
            const r = await deps.backtest.clearTradeCache();
            res.json({ success: true, deleted: r.deletedCount });
        } catch (e) { next(e); }
    });

    // ---- Cache stats ----
    app.get('/api/jobs/cache/stats', async (req, res, next) => {
        try {
            const db = deps.getDB();
            const count = await db.collection(COLLECTIONS.BACKTEST_TRADE_CACHE)
                .countDocuments();
            const recent = await db.collection(COLLECTIONS.BACKTEST_TRADE_CACHE)
                .find({}, { projection: { tradeCount: 1, coveredFrom: 1, coveredTo: 1, computedAt: 1, signature: 1 } })
                .sort({ computedAt: -1 }).limit(20).toArray();
            res.json({ cacheCount: count, recent });
        } catch (e) { next(e); }
    });

    // ---- 🆕 PIT: چک همپوشانی train/backtest ----
    app.get('/api/jobs/overlap-check/:configId', async (req, res, next) => {
        try {
            const { ObjectId } = require('mongodb');
            const { checkTrainTestOverlap } = require('../../core/pit');
            const cfg = await deps.getDB().collection(COLLECTIONS.STRATEGY_CONFIGS)
                .findOne({ _id: new ObjectId(req.params.configId) });
            if (!cfg) return res.status(404).json({ error: 'config یافت نشد' });

            const from = req.query.from ? parseInt(req.query.from) : null;
            const to = req.query.to ? parseInt(req.query.to) : null;

            const result = checkTrainTestOverlap(
                [cfg.trainedFrom || null, cfg.trainedTo || null],
                [from, to]
            );

            res.json({
                configId: req.params.configId,
                training: { from: cfg.trainedFrom, to: cfg.trainedTo },
                backtest: { from, to },
                overlap: result.overlap,
                severity: result.severity,
                message: result.message,
            });
        } catch (e) { next(e); }
    });

    // ---- Auto-configure (sync preview - برای سازگاری) ----
    app.post('/api/auto-configure/preview', async (req, res, next) => {
        try {
            const { symbol, symbols, maxConfirmers = 2, dateFrom, dateTo } = req.body || {};
            let targets = symbol ? [symbol] : (Array.isArray(symbols) ? symbols : []);
            if (!targets.length) return res.status(400).json({ error: 'حداقل یک نماد' });

            const plans = [];
            for (const sym of targets) {
                const p = await backtestService.autoConfigureSingle(
                    sym, maxConfirmers,
                    dateFrom ? parseInt(dateFrom) : null,
                    dateTo ? parseInt(dateTo) : null,
                    null
                );
                plans.push(p);
            }
            res.json({ plans });
        } catch (e) { next(e); }
    });
}

module.exports = { register };