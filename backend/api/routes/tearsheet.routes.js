'use strict';
// ============================================================
// tearsheet.routes.js — Tear Sheet JSON export
// ============================================================

const { ObjectId } = require('mongodb');
const { COLLECTIONS } = require('../../config/constants');

function register(app, deps) {
    const { getDB } = deps;

    // GET /api/tearsheet/:jobId
    app.get('/api/tearsheet/:jobId', async (req, res, next) => {
        try {
            const db = getDB();
            const job = await db.collection(COLLECTIONS.BACKTEST_JOBS)
                .findOne({ _id: new ObjectId(req.params.jobId) });
            if (!job) return res.status(404).json({ error: 'Job یافت نشد' });

            const r = job.result || {};
            const meta = {
                generatedAt: new Date().toISOString(),
                jobId: req.params.jobId,
                type: job.type,
                status: job.status,
                startedAt: job.startedAt,
                finishedAt: job.finishedAt,
                duration: job.finishedAt ? (new Date(job.finishedAt) - new Date(job.startedAt)) / 1000 : null
            };

            // برای backtest-compare، آمار کامل
            if (job.type === 'backtest-compare') {
                const agg = r.aggregate || {};
                const topByPF = [...(r.results || [])]
                    .filter(x => !x.error && x.option && Number.isFinite(x.option.profitFactor))
                    .sort((a, b) => b.option.profitFactor - a.option.profitFactor)
                    .slice(0, 20)
                    .map(x => ({
                        symbol: x.symbol,
                        strategyId: x.strategyId,
                        strategyName: x.strategyName,
                        timeframe: x.timeframe,
                        trades: x.option.count,
                        winRate: x.option.winRate,
                        avgPnl: x.option.avgPnl,
                        totalPnl: x.option.totalPnl,
                        pf: x.option.profitFactor,
                        realUsed: x.option.realUsed,
                        approxUsed: x.option.approxUsed
                    }));

                return res.json({
                    meta,
                    summary: {
                        totalCombos: (r.results || []).length,
                        validCount: agg.validCount || 0,
                        errorCount: agg.errorCount || 0,
                        insufficientCount: agg.insufficientCount || 0
                    },
                    aggregate: {
                        total: agg.total || null,
                        byStrategy: agg.byStrategy || [],
                        bySymbol: agg.bySymbol || []
                    },
                    top20ByPF: topByPF
                });
            }

            // برای backtest تک
            if (job.type === 'backtest') {
                return res.json({
                    meta,
                    stockStats: r.stockStats || null,
                    optionStats: r.optionStats || r.stats || null,
                    advanced: r.advanced || null,
                    trades: (r.trades || []).slice(-100)   // ۱۰۰ معامله آخر
                });
            }

            // برای pipeline
            if (job.type === 'pipeline') {
                return res.json({ meta, ...r });
            }

            res.json({ meta, raw: r });
        } catch (e) { next(e); }
    });

    // GET /api/tearsheet/:jobId/download (فقط برای مرورگر)
    app.get('/api/tearsheet/:jobId/download', async (req, res, next) => {
        try {
            const db = getDB();
            const job = await db.collection(COLLECTIONS.BACKTEST_JOBS)
                .findOne({ _id: new ObjectId(req.params.jobId) });
            if (!job) return res.status(404).json({ error: 'not found' });

            const filename = `tearsheet_${req.params.jobId}.json`;
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            res.send(JSON.stringify(job.result || job, null, 2));
        } catch (e) { next(e); }
    });
}

module.exports = { register };