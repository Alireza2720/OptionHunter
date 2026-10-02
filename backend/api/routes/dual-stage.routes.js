'use strict';
// ============================================================
// dual-stage.routes.js — Pipeline دو مرحله‌ای
// ============================================================

const { ObjectId } = require('mongodb');
const { COLLECTIONS } = require('../../config/constants');

function register(app, deps) {
    const { getDB, logger, dualStageService } = deps;
    if (!dualStageService) {
        console.warn('dual-stage.routes: dualStageService not provided — skipping');
        return;
    }

    // ------------------------------------------------------------
    // POST /api/pipeline/dual-stage
    // ------------------------------------------------------------
    app.post('/api/pipeline/dual-stage', async (req, res, next) => {
        try {
            const memGuard = require('../../infra/memory-guard');
            const check = memGuard.canStartHeavyJob();
            if (!check.ok) {
                return res.status(503).json({ error: check.reason, memory: check.status });
            }

            const opts = req.body || {};

            // ساخت job
            const db = getDB();
            const jobDoc = {
                type: 'dual-stage',
                payload: opts,
                status: 'QUEUED',
                progress: { current: 0, total: 7, message: 'در صف' },
                pipelineStage: 0,
                pipelineState: {},
                createdAt: new Date(),
                updatedAt: new Date()
            };
            const r = await db.collection(COLLECTIONS.BACKTEST_JOBS).insertOne(jobDoc);
            const jobId = String(r.insertedId);

            // Fire & forget
            (async () => {
                try {
                    await db.collection(COLLECTIONS.BACKTEST_JOBS).updateOne(
                        { _id: r.insertedId },
                        { $set: { status: 'RUNNING', startedAt: new Date(), updatedAt: new Date() } }
                    );
                    await dualStageService.runDualStage(jobId, opts);
                } catch (e) {
                    logger && logger.error(`dual-stage bg: ${e.message}`);
                }
            })();

            res.json({ jobId, status: 'QUEUED' });
        } catch (e) { next(e); }
    });

    // ------------------------------------------------------------
    // GET /api/pipeline/dual-stage/:jobId
    // ------------------------------------------------------------
    app.get('/api/pipeline/dual-stage/:jobId', async (req, res, next) => {
        try {
            const db = getDB();
            const job = await db.collection(COLLECTIONS.BACKTEST_JOBS)
                .findOne({ _id: new ObjectId(req.params.jobId) });
            if (!job) return res.status(404).json({ error: 'job یافت نشد' });

            // خلاصه‌ی سبک — بدون trades
            const result = job.result ? {
                ...job.result,
                stages: job.result.stages ? {
                    ...job.result.stages,
                    4: job.result.stages[4] ? {
                        ...job.result.stages[4],
                        plans: (job.result.stages[4].plans || []).map(p => ({
                            ...p,
                            signalCorrelation: undefined   // حذف ماتریس سنگین
                        }))
                    } : null,
                    5: job.result.stages[5] ? {
                        ...job.result.stages[5],
                        results: (job.result.stages[5].results || []).map(r => ({
                            ...r,
                            trades: undefined
                        }))
                    } : null
                } : null
            } : null;

            res.json({
                _id: String(job._id),
                type: job.type,
                status: job.status,
                pipelineStage: job.pipelineStage,
                pipelineState: {
                    ranges: job.pipelineState?.ranges,
                    symbols: job.pipelineState?.symbols,
                    strategies: job.pipelineState?.strategies,
                    totalConfigs: job.pipelineState?.totalConfigs,
                    stage2: job.pipelineState?.stage2,
                    stage3: job.pipelineState?.stage3,
                    stage4: job.pipelineState?.stage4,
                    stage5: job.pipelineState?.stage5,
                    stage6: job.pipelineState?.stage6,
                    stage7: job.pipelineState?.stage7
                },
                progress: job.progress,
                result,
                error: job.error,
                createdAt: job.createdAt,
                startedAt: job.startedAt,
                finishedAt: job.finishedAt
            });
        } catch (e) { next(e); }
    });

    // ------------------------------------------------------------
    // POST /api/pipeline/dual-stage/:jobId/cancel
    // ------------------------------------------------------------
    app.post('/api/pipeline/dual-stage/:jobId/cancel', async (req, res, next) => {
        try {
            const db = getDB();
            await db.collection(COLLECTIONS.BACKTEST_JOBS).updateOne(
                { _id: new ObjectId(req.params.jobId), status: { $in: ['QUEUED', 'RUNNING'] } },
                { $set: { status: 'CANCELLED', cancelRequested: true, finishedAt: new Date(), updatedAt: new Date() } }
            );
            res.json({ success: true });
        } catch (e) { next(e); }
    });

    // ------------------------------------------------------------
    // GET /api/pipeline/dual-stage/preview — پیش‌بینی بازه‌ها
    // ------------------------------------------------------------
    app.get('/api/pipeline/dual-stage/preview', async (req, res, next) => {
        try {
            const ranges = await dualStageService._resolveDateRanges({});
            const { configs, symbols, strategies } = await dualStageService._buildConfigs({});
            res.json({
                ranges,
                symbols: symbols.length,
                strategies: strategies.length,
                totalConfigs: configs.length,
                estimatedMinutes: Math.round((configs.length * 8 + symbols.length * 100) / 60)
            });
        } catch (e) {
            logger && logger.error('dual-stage preview: ' + (e.stack || e.message));
            res.status(500).json({
                error: e.message,
                stack: e.stack ? e.stack.split('\n').slice(0, 6) : null
            });
        }
    });
}

module.exports = { register };