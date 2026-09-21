'use strict';
// ============================================================
// backtest.service.js — Job-based orchestration
// ============================================================
// - CRUD job
// - Queue processor
// - Backtest / Auto-Config / Backtest-Compare runners
// ============================================================

const { ObjectId } = require('mongodb');
const {
    COLLECTIONS,
    JOB_STATUS,
    JOB_TYPE,
    ACTIVE_JOB_STATUSES,
    FINISHED_JOB_STATUSES,
    ERROR_CODES
} = require('../config/constants');

let deps = {
    getDB: null,
    backtest: null,       // core/backtest
    options: null,        // core/options
    dataService: null,
    signals: null,        // core/signals (برای eval آنی)
    settings: null,
    logger: null,
    notify: null
};

function init(d) { deps = { ...deps, ...d }; }

// ============================================================
// Job CRUD
// ============================================================
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
        status: JOB_STATUS.QUEUED,
        cancelRequested: false,
        progress: {
            current: 0,
            total: chunks.length || 1,
            message: 'در صف',
            chunks
        },
        result: null,
        error: null,
        resourceStats: { peakRssMB: 0, totalCpuMs: 0 },
        createdAt: new Date(),
        updatedAt: new Date(),
        startedAt: null,
        finishedAt: null
    };

    const r = await db.collection(COLLECTIONS.BACKTEST_JOBS).insertOne(doc);
    return { _id: r.insertedId, ...doc };
}

async function getJob(id) {
    return deps.getDB().collection(COLLECTIONS.BACKTEST_JOBS).findOne({ _id: new ObjectId(id) });
}

async function listJobs(limit = 50, onlyActive = true) {
    const q = onlyActive ? { status: { $in: ACTIVE_JOB_STATUSES } } : {};
    return deps.getDB().collection(COLLECTIONS.BACKTEST_JOBS)
        .find(q).sort({ createdAt: -1 }).limit(limit).toArray();
}

async function updateProgress(id, current, total, message) {
    await deps.getDB().collection(COLLECTIONS.BACKTEST_JOBS).updateOne(
        { _id: new ObjectId(id) },
        { $set: {
            'progress.current': current,
            'progress.total': total,
            'progress.message': message || '',
            updatedAt: new Date()
        }}
    );
}

async function updateChunk(id, idx, fields) {
    const set = {};
    for (const k of Object.keys(fields)) set[`progress.chunks.${idx}.${k}`] = fields[k];
    set.updatedAt = new Date();
    await deps.getDB().collection(COLLECTIONS.BACKTEST_JOBS).updateOne(
        { _id: new ObjectId(id) }, { $set: set }
    );
}

async function cancelJob(id) {
    await deps.getDB().collection(COLLECTIONS.BACKTEST_JOBS).updateOne(
        { _id: new ObjectId(id), status: { $in: ACTIVE_JOB_STATUSES } },
        { $set: { cancelRequested: true, updatedAt: new Date() } }
    );
}

async function forceCancelJob(id) {
    await deps.getDB().collection(COLLECTIONS.BACKTEST_JOBS).updateOne(
        { _id: new ObjectId(id) },
        { $set: {
            status: JOB_STATUS.CANCELLED,
            cancelRequested: true,
            finishedAt: new Date(),
            updatedAt: new Date()
        }}
    );
}

async function deleteJob(id) {
    await deps.getDB().collection(COLLECTIONS.BACKTEST_JOBS).deleteOne({ _id: new ObjectId(id) });
}

async function isCancelled(id) {
    const j = await deps.getDB().collection(COLLECTIONS.BACKTEST_JOBS).findOne(
        { _id: new ObjectId(id) },
        { projection: { cancelRequested: 1, status: 1 } }
    );
    return !!(j && (j.cancelRequested || j.status === JOB_STATUS.CANCELLED));
}

async function finishJob(id, result, status, error, resourceStats) {
    const set = {
        status,
        result: result || null,
        error: error ? String(error) : null,
        finishedAt: new Date(),
        updatedAt: new Date()
    };
    if (resourceStats) set.resourceStats = resourceStats;
    await deps.getDB().collection(COLLECTIONS.BACKTEST_JOBS).updateOne(
        { _id: new ObjectId(id) }, { $set: set }
    );
}

// ============================================================
// Queue processor
// ============================================================
let processorRunning = false;

async function processQueue() {
    if (processorRunning) return;
    processorRunning = true;
    try {
        const db = deps.getDB();
        while (true) {
            const j = await db.collection(COLLECTIONS.BACKTEST_JOBS).findOneAndUpdate(
                { status: JOB_STATUS.QUEUED },
                { $set: {
                    status: JOB_STATUS.RUNNING,
                    startedAt: new Date(),
                    updatedAt: new Date()
                }},
                { sort: { createdAt: 1 }, returnDocument: 'after' }
            );
            if (!j) break;

            const jobId = j._id;
            const startRss = process.memoryUsage().rss;
            const startCpu = process.cpuUsage();

            try {
                let result;
                if (j.type === JOB_TYPE.BACKTEST) result = await runBacktestJob(j);
                else if (j.type === JOB_TYPE.AUTO_CONFIG) result = await runAutoConfigJob(j);
                else if (j.type === JOB_TYPE.BACKTEST_COMPARE) result = await runBacktestCompareJob(j);
                else throw new Error('نوع job نامعتبر: ' + j.type);

                if (await isCancelled(jobId)) {
                    await finishJob(jobId, null, JOB_STATUS.CANCELLED, null, null);
                    continue;
                }

                const cpuNow = process.cpuUsage(startCpu);
                const rssNow = process.memoryUsage().rss;
                await finishJob(jobId, result, JOB_STATUS.DONE, null, {
                    peakRssMB: Math.round(Math.max(rssNow, startRss) / 1048576),
                    totalCpuMs: Math.round((cpuNow.user + cpuNow.system) / 1000)
                });
            } catch (e) {
                if (String(e.message).includes(ERROR_CODES.CANCELED_BY_USER)) {
                    await finishJob(jobId, null, JOB_STATUS.CANCELLED, null, null);
                } else {
                    deps.logger && deps.logger.error('Job failed: ' + e.message);
                    await finishJob(jobId, null, JOB_STATUS.FAILED, e.message, null);
                }
            }
        }
    } finally {
        processorRunning = false;
    }
}

// ============================================================
// Runners
// ============================================================
async function runBacktestJob(job) {
    const { configId, from, to, useRealOption } = job.payload;
    const cfg = await deps.getDB().collection(COLLECTIONS.STRATEGY_CONFIGS)
        .findOne({ _id: new ObjectId(configId) });
    if (!cfg) throw new Error('config یافت نشد');

    const dateFrom = from ? parseInt(from) : null;
    const dateTo = to ? parseInt(to) : null;

    await updateProgress(job._id, 10, 100, 'دریافت کندل‌ها...');

    const result = await deps.backtest.runBacktest(cfg, dateFrom, dateTo, {
        useRealOption: !!useRealOption,
        onProgress: async (info) => {
            if (await isCancelled(job._id)) throw new Error(ERROR_CODES.CANCELED_BY_USER);
            await updateProgress(job._id, 30, 100, `فاز: ${info.phase}`);
        }
    });

    if (await isCancelled(job._id)) throw new Error(ERROR_CODES.CANCELED_BY_USER);

    await updateProgress(job._id, 100, 100, 'تکمیل');
    return result;
}

async function runBacktestCompareJob(job) {
    const { symbols, strategies, useRealOption, dateFrom, dateTo } = job.payload;
    const fromTs = dateFrom ? parseInt(dateFrom) : null;
    const toTs = dateTo ? parseInt(dateTo) : null;

    const allResults = [];

    for (let i = 0; i < symbols.length; i++) {
        if (await isCancelled(job._id)) throw new Error(ERROR_CODES.CANCELED_BY_USER);
        const symbol = symbols[i];

        await updateChunk(job._id, i, { status: 'RUNNING', startedAt: new Date() });
        await updateProgress(job._id, i, symbols.length, `پردازش ${symbol}`);

        for (const s of strategies) {
            if (await isCancelled(job._id)) throw new Error(ERROR_CODES.CANCELED_BY_USER);

            const STRATEGIES = deps.signals && deps.signals.STRATEGIES
                ? deps.signals.STRATEGIES
                : null;

            const def = deps.strategies.STRATEGIES[s.id];
            if (!def) continue;

            const cfg = {
                symbol,
                strategyId: s.id,
                timeframe: s.timeframe || def.defaultTimeframe,
                htfTimeframe: s.htfTimeframe || def.htfTimeframe || '1d',
                candleType: s.candleType === 'simple' ? 'simple' : 'heikin',
                params: {
                    ...def.defaultParams,
                    ...(deps.settings.getStrategyDefaults(s.id) || {}),
                    ...(s.params || {})
                }
            };

            try {
                const result = await deps.backtest.runBacktest(cfg, fromTs, toTs, {
                    useRealOption: !!useRealOption
                });
                allResults.push({
                    symbol,
                    strategyId: s.id,
                    strategyName: def.name,
                    timeframe: cfg.timeframe,
                    htfTimeframe: cfg.htfTimeframe,
                    candleType: cfg.candleType,
                    stock: result.stockStats,
                    option: result.stats,
                    optionMode: result.mode
                });
            } catch (e) {
                if (String(e.message).includes(ERROR_CODES.CANCELED_BY_USER)) throw e;
                allResults.push({
                    symbol,
                    strategyId: s.id,
                    strategyName: def.name,
                    timeframe: cfg.timeframe,
                    htfTimeframe: cfg.htfTimeframe,
                    candleType: cfg.candleType,
                    error: e.message
                });
            }
            await new Promise(r => setImmediate(r));
        }

        await updateChunk(job._id, i, {
            status: 'DONE',
            finishedAt: new Date(),
            tradesCount: allResults.filter(r => r.symbol === symbol).length
        });
        await new Promise(r => setImmediate(r));
    }

    return {
        results: allResults,
        aggregate: aggregateCompare(allResults)
    };
}

async function runAutoConfigJob(job) {
    const { symbols, maxConfirmers, from, to, dryRun } = job.payload;
    const fromTs = from ? parseInt(from) : null;
    const toTs = to ? parseInt(to) : null;

    const plans = [];

    for (let i = 0; i < symbols.length; i++) {
        if (await isCancelled(job._id)) throw new Error(ERROR_CODES.CANCELED_BY_USER);
        const sym = symbols[i];

        await updateChunk(job._id, i, { status: 'RUNNING', startedAt: new Date() });
        await updateProgress(job._id, i, symbols.length, `پردازش ${sym}`);

        try {
            const p = await autoConfigureSingle(sym, maxConfirmers || 2, fromTs, toTs, job._id);
            plans.push(p);
            await updateChunk(job._id, i, {
                status: 'DONE',
                finishedAt: new Date(),
                tradesCount: (p.leader && p.leader.stats && p.leader.stats.stock && p.leader.stats.stock.closed) || 0
            });
        } catch (e) {
            if (String(e.message).includes(ERROR_CODES.CANCELED_BY_USER)) throw e;
            plans.push({ symbol: sym, error: e.message });
            await updateChunk(job._id, i, {
                status: 'FAILED',
                finishedAt: new Date(),
                error: e.message
            });
        }
        await new Promise(r => setImmediate(r));
    }

    await updateProgress(job._id, symbols.length, symbols.length, 'اعمال');

    if (dryRun) return { plans, applied: false };

    const applied = await applyAutoConfig(plans, { from: fromTs, to: toTs });
    return { plans, applied: true, results: applied };
}

// 🆕 محاسبه عمق دیتای آپشن برای هر نماد
async function computeDataDays(db, symbol) {
    try {
        const doc = await db.collection('option_daily_algotik').findOne(
            { underlying: symbol },
            { sort: { date: 1 }, projection: { date: 1 } }
        );
        if (!doc || !doc.date) return 90;   // default
        const earliest = new Date(doc.date);
        if (isNaN(earliest.getTime())) return 90;
        const now = new Date();
        const days = Math.floor((now - earliest) / (1000 * 60 * 60 * 24));
        return Math.max(1, days);
    } catch (_) {
        return 90;
    }
}

async function applyAutoConfig(plans, trainingMeta = null) {
    const db = deps.getDB();
    const applied = [];
    const trainedFrom = trainingMeta ? trainingMeta.from : null;
    const trainedTo = trainingMeta ? trainingMeta.to : null;

    for (const p of plans) {
        if (p.error || !p.leader) {
            applied.push({
                symbol: p.symbol,
                error: p.error || 'بدون leader',
                rejectionReasons: p.rejectionReasons
            });
            continue;
        }

        const old = await db.collection(COLLECTIONS.STRATEGY_CONFIGS)
            .find({ symbol: p.symbol }).toArray();
        const oldIds = old.map(o => o._id.toString());

        await db.collection(COLLECTIONS.STRATEGY_CONFIGS).deleteMany({ symbol: p.symbol });
        await db.collection(COLLECTIONS.SIGNALS_STATE).deleteMany({ configId: { $in: oldIds } });
        await deps.backtest.invalidateCacheForConfig(oldIds).catch(() => {});

        const STRATEGIES = deps.strategies.STRATEGIES;

        // 🆕 محاسبه عمق دیتا (برای مدیریت سرمایه)
        const dataDays = await computeDataDays(db, p.symbol);

        const leaderDoc = {
            symbol: p.symbol,
            strategyId: p.leader.strategyId,
            timeframe: p.leader.timeframe,
            htfTimeframe: p.leader.htfTimeframe,
            candleType: 'heikin',
            params: {
                ...STRATEGIES[p.leader.strategyId].defaultParams,
                ...(deps.settings.getStrategyDefaults(p.leader.strategyId) || {})
            },
            enabled: true,
            role: 'leader',
            autoConfigured: true,
            dataDays,   // 🆕
            trainedFrom,
            trainedTo,
            trainedAt: new Date(),
            createdAt: new Date()
        };
        const r1 = await db.collection(COLLECTIONS.STRATEGY_CONFIGS).insertOne(leaderDoc);
        const created = [r1.insertedId.toString()];

        for (const c of p.confirmers) {
            const cDoc = {
                symbol: p.symbol,
                strategyId: c.strategyId,
                timeframe: c.timeframe,
                htfTimeframe: c.htfTimeframe,
                candleType: 'heikin',
                params: {
                    ...STRATEGIES[c.strategyId].defaultParams,
                    ...(deps.settings.getStrategyDefaults(c.strategyId) || {})
                },
                enabled: true,
                role: 'confirmer',
                autoConfigured: true,
                dataDays,   // 🆕
                trainedFrom,
                trainedTo,
                trainedAt: new Date(),
                createdAt: new Date()
            };
            const r2 = await db.collection(COLLECTIONS.STRATEGY_CONFIGS).insertOne(cDoc);
            created.push(r2.insertedId.toString());
        }

        applied.push({
            symbol: p.symbol,
            leader: p.leader.strategyId,
            leaderName: p.leader.strategyName,
            leaderScore: p.leader.score,
            confirmers: p.confirmers.map(c => ({
                id: c.strategyId, name: c.strategyName, score: c.score
            })),
            created: created.length
        });
    }

    if (deps.notify) {
        await deps.notify(`تنظیم خودکار انجام شد\n${applied.filter(a => !a.error).map(a => `- ${a.symbol}: لیدر ${a.leaderName}`).join('\n')}`).catch(() => {});
    }
    return applied;
}

// ============================================================
// Auto-configure single symbol
// ============================================================
async function autoConfigureSingle(symbol, maxConfirmers, dateFrom, dateTo, jobId) {
    const db = deps.getDB();
    const monitored = await db.collection(COLLECTIONS.MONITORED_SYMBOLS).findOne({ symbol });
    if (!monitored) return { symbol, error: 'نماد در لیست پایش نیست' };

    // 🆕 عمق دیتا برای threshold داینامیک
    const dataDays = await computeDataDays(db, symbol);
    const th = getThresholds(dataDays);

    const STRATEGIES = deps.strategies.STRATEGIES;
    const strategies = Object.values(STRATEGIES).filter(s => s.id !== 'ensemble');
    const results = [];

    for (const def of strategies) {
        if (jobId && await isCancelled(jobId)) throw new Error(ERROR_CODES.CANCELED_BY_USER);

        const cfg = {
            symbol,
            strategyId: def.id,
            timeframe: def.defaultTimeframe,
            htfTimeframe: def.htfTimeframe || '1d',
            candleType: 'heikin',
            params: {
                ...def.defaultParams,
                ...(deps.settings.getStrategyDefaults(def.id) || {})
            }
        };

        try {
            const result = await deps.backtest.runBacktest(cfg, dateFrom, dateTo, {
                useRealOption: true
            });

            const stock = result.stockStats;
            const option = result.stats;

            const r = {
                strategyId: def.id,
                strategyName: def.name,
                timeframe: cfg.timeframe,
                htfTimeframe: cfg.htfTimeframe,
                stock: {
                    total: stock.count,
                    closed: stock.count,
                    winRate: stock.winRate,
                    avgPnl: stock.avgPnl,
                    totalPnl: stock.totalPnl
                },
                option: {
                    count: option.count,
                    winRate: option.winRate,
                    avgPnl: option.avgPnl,
                    totalPnl: option.totalPnl,
                    profitFactor: option.profitFactor,
                    realUsed: result.realUsed,
                    approxUsed: result.approxUsed,
                    diagnostic: result.diagnostic
                }
            };
            r.score = scoreStrategy(r, dataDays);   // 🆕
            results.push(r);
        } catch (e) {
            if (String(e.message).includes(ERROR_CODES.CANCELED_BY_USER)) throw e;
            results.push({
                strategyId: def.id,
                strategyName: def.name,
                error: e.message,
                score: -Infinity
            });
        }
        await new Promise(r => setImmediate(r));
    }

    const valid = results
        .filter(r => Number.isFinite(r.score) && r.score > -Infinity)
        .sort((a, b) => b.score - a.score);

    if (!valid.length) {
        const rejectionReasons = results.map(r => {
            const reasons = [];
            if (r.error) reasons.push(r.error);
            else {
                const s = r.stock || {};
                const o = r.option || {};
                if ((s.closed || 0) < th.minTrades)
                    reasons.push(`معامله سهم ${s.closed || 0} < ${th.minTrades}`);
                else if ((o.count || 0) < th.minOptCount)
                    reasons.push(`معامله آپشن ${o.count || 0} < ${th.minOptCount}`);
                else if ((o.profitFactor || 0) < th.minPF)
                    reasons.push(`PF ${(o.profitFactor || 0).toFixed(2)} < ${th.minPF}`);
            }
            return { strategyId: r.strategyId, strategyName: r.strategyName, reasons };
        });
        return {
            symbol,
            error: `هیچ استراتژی معتبری پیدا نشد (${th.minTrades} معامله سهم + ${th.minOptCount} آپشن + PF > ${th.minPF}) — dataDays=${dataDays}`,
            dataDays,              // 🆕
            thresholds: th,        // 🆕
            results,
            rejectionReasons
        };
    }

    const leader = valid[0];
    const confirmers = valid.slice(1, 1 + maxConfirmers);

    return {
        symbol,
        dataDays,                  // 🆕
        thresholds: th,            // 🆕
        leader: {
            strategyId: leader.strategyId,
            strategyName: leader.strategyName,
            timeframe: leader.timeframe,
            htfTimeframe: leader.htfTimeframe,
            score: Math.round(leader.score * 100) / 100,
            stats: leader
        },
        confirmers: confirmers.map(c => ({
            strategyId: c.strategyId,
            strategyName: c.strategyName,
            timeframe: c.timeframe,
            htfTimeframe: c.htfTimeframe,
            score: Math.round(c.score * 100) / 100,
            stats: c
        })),
        allResults: valid.map(v => ({
            strategyId: v.strategyId,
            strategyName: v.strategyName,
            score: Math.round(v.score * 100) / 100,
            trades: v.stock.closed,
            winRate: v.stock.winRate,
            optTrades: v.option.count,
            optAvg: v.option.avgPnl,
            optPF: v.option.profitFactor
        }))
    };
}

// 🆕 threshold داینامیک بر اساس عمق دیتا
function getThresholds(dataDays) {
    const d = Number.isFinite(dataDays) ? dataDays : 90;
    if (d < 100) {
        // ۳ ماه اول: سختی کمتر
        return { minTrades: 4, minOptCount: 2, minPF: 1.0 };
    }
    if (d < 180) {
        return { minTrades: 5, minOptCount: 2, minPF: 1.05 };
    }
    if (d < 365) {
        return { minTrades: 6, minOptCount: 3, minPF: 1.1 };
    }
    // دیتای یک‌ساله+
    return { minTrades: 7, minOptCount: 3, minPF: 1.1 };
}

function scoreStrategy(res, dataDays) {
    if (!res || res.error) return -Infinity;
    const th = getThresholds(dataDays);
    const s = res.stock || {};
    const o = res.option || {};

    const trades = s.closed || 0;
    if (trades < th.minTrades) return -Infinity;

    const optCount = o.count || 0;
    if (optCount < th.minOptCount) return -Infinity;

    const optPF = (o.profitFactor !== null && o.profitFactor !== undefined && isFinite(o.profitFactor))
        ? o.profitFactor : 0;
    if (optPF < th.minPF) return -Infinity;

    const winRate = (s.winRate || 0) / 100;
    const optAvg = o.avgPnl || 0;
    let score = optPF * 0.4 + winRate * 0.3 +
        Math.min(trades, 20) / 20 * 0.1 +
        Math.max(-1, Math.min(2, optAvg / 50)) * 0.2;
    if (trades >= 20) score *= 1.2;
    return score;
}

// ============================================================
// Compare aggregation
// ============================================================
function aggregateCompare(allResults) {
    const valid = allResults.filter(r => !r.error);

    const agg = (arr) => {
        let stockTrades = 0, stockWins = 0, stockSum = 0;
        let optTrades = 0, optWins = 0, optSum = 0, optReal = 0, optApprox = 0;
        let optGrossWin = 0, optGrossLoss = 0;

        for (const r of arr) {
            const st = r.stock || {};
            const ot = r.option || {};
            stockTrades += st.count || 0;
            stockWins += ((st.count || 0) * (st.winRate || 0) / 100);
            stockSum += st.totalPnl || 0;
            optTrades += ot.count || 0;
            optWins += ((ot.count || 0) * (ot.winRate || 0) / 100);
            optSum += ot.totalPnl || 0;
            optReal += ot.realUsed || 0;
            optApprox += ot.approxUsed || 0;
        }
        const pf = optGrossLoss > 0 ? optGrossWin / optGrossLoss : (optGrossWin > 0 ? null : 0);

        return {
            stock: {
                trades: stockTrades,
                winRate: stockTrades ? stockWins / stockTrades * 100 : 0,
                avgPnl: stockTrades ? stockSum / stockTrades : 0,
                totalPnl: stockSum
            },
            option: {
                trades: optTrades,
                winRate: optTrades ? optWins / optTrades * 100 : 0,
                avgPnl: optTrades ? optSum / optTrades : 0,
                totalPnl: optSum,
                realUsed: optReal,
                approxUsed: optApprox,
                profitFactor: pf
            },
            combos: arr.length
        };
    };

    const total = agg(valid);

    const bySymbol = Object.entries(valid.reduce((acc, r) => {
        (acc[r.symbol] = acc[r.symbol] || []).push(r);
        return acc;
    }, {})).map(([sym, arr]) => ({ symbol: sym, ...agg(arr) }))
        .sort((a, b) => (b.option.profitFactor || -1) - (a.option.profitFactor || -1));

    const byStrategy = Object.entries(valid.reduce((acc, r) => {
        (acc[r.strategyId] = acc[r.strategyId] || []).push(r);
        return acc;
    }, {})).map(([sid, arr]) => ({
        strategyId: sid,
        strategyName: arr[0].strategyName,
        ...agg(arr)
    })).sort((a, b) => (b.option.profitFactor || -1) - (a.option.profitFactor || -1));

    return {
        total, bySymbol, byStrategy,
        count: allResults.length,
        validCount: valid.length,
        insufficientCount: allResults.filter(x => x.insufficientData).length,
        errorCount: allResults.filter(x => x.error && !x.insufficientData).length
    };
}

// ============================================================
// Startup recovery
// ============================================================
async function resumeStuckJobs() {
    const r = await deps.getDB().collection(COLLECTIONS.BACKTEST_JOBS).updateMany(
        { status: JOB_STATUS.RUNNING },
        { $set: {
            status: JOB_STATUS.QUEUED,
            updatedAt: new Date(),
            'progress.message': 'ادامه پس از ری استارت سرور'
        }}
    );
    return r.modifiedCount;
}

async function cleanupOldJobs(daysOld = 7) {
    const cutoff = new Date(Date.now() - daysOld * 86400 * 1000);
    const r = await deps.getDB().collection(COLLECTIONS.BACKTEST_JOBS).deleteMany({
        status: { $in: FINISHED_JOB_STATUSES },
        finishedAt: { $lt: cutoff }
    });
    return r.deletedCount;
}

module.exports = {
    init,
    createJob, getJob, listJobs,
    updateProgress, updateChunk,
    cancelJob, forceCancelJob, deleteJob,
    isCancelled, finishJob,
    processQueue,
    runBacktestJob, runAutoConfigJob, runBacktestCompareJob,
    applyAutoConfig, autoConfigureSingle,
    resumeStuckJobs, cleanupOldJobs
};