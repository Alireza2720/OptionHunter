'use strict';
// ============================================================
// dual-stage-pipeline.service.js
// مکانیزم ۲ مرحله‌ای: Stock Backtest → Option Backtest
// ============================================================
// Stage 1: Stock backtest روی TRAIN
// Stage 2: FDR filter
// Stage 3: Validation روی VALIDATION
// Stage 4: Leader/Confirmer با signal correlation
// Stage 5: Option backtest روی TEST (بازه‌ی آپشن)
// Stage 6: Verdict (GO/MAYBE/SKIP)
// Stage 7: Apply configs
// ============================================================

const { ObjectId } = require('mongodb');
const { COLLECTIONS, OPTION_DATA_CUTOFF, TIMEFRAME_MINUTES } = require('../config/constants');
const { benjaminiHochberg } = require('../core/multiple-testing');
const { buildSignalCorrelationMatrix, selectIndependentConfirmers } = require('../core/signal-correlation');
const { computeRegimeDistribution } = require('../core/regime-distribution');
const memGuard = require('../infra/memory-guard');

let deps = {
    getDB: null, logger: null,
    backtest: null, backtestService: null,
    analysisService: null,
    signalFilterService: null,
    configService: null,
    settings: null,
    notify: null
};
function init(d) { deps = { ...deps, ...d }; }

const STAGE_LABELS = {
    0: 'در صف',
    1: 'مرحله ۱: بک‌تست سهم روی Train',
    2: 'مرحله ۲: فیلتر FDR',
    3: 'مرحله ۳: اعتبارسنجی روی Validation',
    4: 'مرحله ۴: انتخاب Leader/Confirmer',
    5: 'مرحله ۵: بک‌تست آپشن روی Test',
    6: 'مرحله ۶: تصمیم نهایی',
    7: 'مرحله ۷: اعمال configs',
    99: 'تکمیل'
};

const EXCLUDED_STRATEGIES = new Set(['ensemble', 'pairs_spread', 'sector_momentum']);

const DEFAULTS = {
    // بازه‌ها — اگه null، خودکار محاسبه می‌شن
    trainFrom: null,
    trainTo: null,
    validationFrom: null,
    validationTo: null,
    testFrom: null,       // پیش‌فرض: OPTION_DATA_CUTOFF
    testTo: null,         // پیش‌فرض: امروز

    // Stage 1 gates
    minStockTrades: 30,
    minStockPF: 1.3,
    minLB: 1.0,
    fdrQ: 0.05,
    useFDR: true,

    // Stage 3
    minValidationPF: 1.0,

    // Stage 4
    maxConfirmers: 2,
    signalCorrThreshold: 0.5,
    signalCorrToleranceSec: 300,

    // Stage 5 gates
    minOptionTrades: 5,
    minRealRatio: 0.5,
    minOptionPF: 1.2,

    // Verdict
    goThreshold: 0.7,
    maybeThreshold: 0.5,
    minAvgPnl: 0,

    // Capital
    capital: 100000000,
    riskPct: 1.5,

    // Symbols/Strategies
    symbols: null,
    strategies: null,

    // Mode
    dryRun: false,
    validationsDays: 60
};

// ============================================================
// Helper: تعیین بازه‌ها
// ============================================================
async function _resolveDateRanges(opts) {
    const db = deps.getDB();

    // Test period
    let testFrom = opts.testFrom;
    let testTo = opts.testTo;
    if (!testFrom) testFrom = Math.floor(OPTION_DATA_CUTOFF.getTime() / 1000);
    else testFrom = Math.floor(new Date(testFrom).getTime() / 1000);
    if (!testTo) testTo = Math.floor(Date.now() / 1000);
    else testTo = Math.floor(new Date(testTo).getTime() / 1000);

    // Validation period
    let valFrom = opts.validationFrom;
    let valTo = opts.validationTo;
    if (!valTo) valTo = testFrom - 86400;   // ۱ روز قبل از test
    else valTo = Math.floor(new Date(valTo).getTime() / 1000);
    if (!valFrom) {
        const days = opts.validationsDays || 60;
        valFrom = valTo - days * 86400;
    } else valFrom = Math.floor(new Date(valFrom).getTime() / 1000);

    // Train period
    let trainTo = opts.trainTo;
    if (!trainTo) trainTo = valFrom - 86400;
    else trainTo = Math.floor(new Date(trainTo).getTime() / 1000);

    let trainFrom = opts.trainFrom;
    if (!trainFrom) {
        // از data-range
        try {
            const r = await deps.getDB().collection(COLLECTIONS.CANDLES_BASE)
                .findOne({}, { sort: { time: 1 }, projection: { time: 1 } });
            trainFrom = r ? Math.floor(new Date(r.time).getTime() / 1000) : (trainTo - 3 * 365 * 86400);
        } catch (_) {
            trainFrom = trainTo - 3 * 365 * 86400;
        }
    } else trainFrom = Math.floor(new Date(trainFrom).getTime() / 1000);

    return {
        train: { from: trainFrom, to: trainTo, days: Math.round((trainTo - trainFrom) / 86400) },
        validation: { from: valFrom, to: valTo, days: Math.round((valTo - valFrom) / 86400) },
        test: { from: testFrom, to: testTo, days: Math.round((testTo - testFrom) / 86400) }
    };
}

// ============================================================
// Helper: ساخت لیست configs
// ============================================================
async function _buildConfigs(opts) {
    const db = deps.getDB();
    const STRATEGIES = require('../strategies').STRATEGIES;

    // Symbols
    let symbols = opts.symbols;
    if (!symbols || !symbols.length) {
        const monitored = await db.collection(COLLECTIONS.MONITORED_SYMBOLS)
            .find({ enabled: true }).toArray();
        symbols = monitored.map(m => m.symbol);
    }

    // Strategies
    let strategyIds = opts.strategies;
    if (!strategyIds || !strategyIds.length) {
        strategyIds = Object.values(STRATEGIES)
            .filter(s => !EXCLUDED_STRATEGIES.has(s.id))
            .map(s => s.id);
    } else {
        strategyIds = strategyIds.filter(id => STRATEGIES[id] && !EXCLUDED_STRATEGIES.has(id));
    }

    const configs = [];
    for (const sym of symbols) {
        for (const sid of strategyIds) {
            const def = STRATEGIES[sid];
            if (!def) continue;
            configs.push({
                symbol: sym,
                strategyId: sid,
                strategyName: def.name,
                timeframe: def.defaultTimeframe,
                htfTimeframe: def.htfTimeframe || '1d',
                candleType: 'heikin',
                params: {
                    ...def.defaultParams,
                    ...(deps.settings.getStrategyDefaults(sid) || {})
                }
            });
        }
    }

    return { configs, symbols, strategies: strategyIds };
}

// ============================================================
// Helper: checkpoint
// ============================================================
async function _setStage(jobId, stage, patch = {}) {
    const db = deps.getDB();
    const update = {
        $set: {
            pipelineStage: stage,
            'progress.current': stage,
            'progress.total': 7,
            'progress.message': STAGE_LABELS[stage] || `stage ${stage}`,
            updatedAt: new Date()
        }
    };
    for (const [k, v] of Object.entries(patch)) {
        update.$set[`pipelineState.${k}`] = v;
    }
    await db.collection(COLLECTIONS.BACKTEST_JOBS).updateOne(
        { _id: new ObjectId(jobId) },
        update
    );
}

// ============================================================
// STAGE 1: Stock Backtest روی Train
// ============================================================
async function _stage1_stockBacktest(jobId, configs, dateRange, resumeState) {
    const results = [];
    const signalTimesBySymbolStrat = new Map();   // key: "symbol::strategyId"
    const total = configs.length;
    let done = (resumeState && resumeState.stage1 && resumeState.stage1.done) || 0;

    for (let i = done; i < total; i++) {
        const cfg = configs[i];
        memGuard.maybeGC();

        try {
            const r = await deps.backtest.runBacktest(cfg, dateRange.from, dateRange.to, {
                mode: 'stock'
            });
            const trades = r.stockStats && r.stockStats.count ? (r.advanced && r.advanced.equityCurve ? [] : []) : [];
            // trades کامل از result میاد — core/backtest.js میده stockTrades کامل
            const fullTrades = r.trades || [];
            results.push({
                symbol: cfg.symbol,
                strategyId: cfg.strategyId,
                strategyName: cfg.strategyName,
                timeframe: cfg.timeframe,
                htfTimeframe: cfg.htfTimeframe,
                stockStats: r.stockStats,
                trades: fullTrades
            });

            // ذخیره‌ی times برای correlation
            const key = `${cfg.symbol}::${cfg.strategyId}`;
            signalTimesBySymbolStrat.set(key, fullTrades.map(t => t.entryTime).filter(Number.isFinite));

        } catch (e) {
            deps.logger && deps.logger.warn(`[dual-stage] stage1 ${cfg.symbol}/${cfg.strategyId}: ${e.message}`);
            results.push({
                symbol: cfg.symbol,
                strategyId: cfg.strategyId,
                strategyName: cfg.strategyName,
                error: e.message
            });
        }

        // آپدیت progress + checkpoint هر ۱۰ تا
        if (i % 10 === 0 || i === total - 1) {
            await deps.getDB().collection(COLLECTIONS.BACKTEST_JOBS).updateOne(
                { _id: new ObjectId(jobId) },
                { $set: {
                    'progress.current': i + 1,
                    'progress.total': total,
                    'progress.message': `${STAGE_LABELS[1]} — ${i + 1}/${total} (${cfg.symbol})`,
                    updatedAt: new Date()
                } }
            );
        }

        await new Promise(res => setImmediate(res));
    }

    return { results, signalTimesBySymbolStrat, done: total };
}

// ============================================================
// STAGE 2: FDR Filter
// ============================================================
function _stage2_fdrFilter(stage1Results, opts) {
    // p-values from t-test روی trades هر pair
    const pvalues = [];
    const indexed = new Map();   // key → result

    for (const r of stage1Results) {
        if (r.error || !r.trades || r.trades.length < 2) continue;
        const key = `${r.symbol}::${r.strategyId}`;
        indexed.set(key, r);

        // t-test یک‌طرفه روی pnlPct
        const pnls = r.trades.map(t => t.pnlPct).filter(Number.isFinite);
        if (pnls.length < 3) continue;
        const p = _oneSampleTTestPValue(pnls);
        pvalues.push({ key, p: Number.isFinite(p) ? p : 1 });
    }

    let fdrResult = { pass: null, threshold: null, n: pvalues.length };
    if (opts.useFDR && pvalues.length > 0) {
        fdrResult = benjaminiHochberg(pvalues, opts.fdrQ || 0.05);
    }

    // Filter: FDR pass + PF >= minStockPF + N >= minStockTrades + LB >= minLB
    const candidates = [];
    for (const r of stage1Results) {
        if (r.error) continue;
        const key = `${r.symbol}::${r.strategyId}`;
        const st = r.stockStats || {};
        const n = st.count || 0;
        const pf = st.profitFactor;
        const safePf = Number.isFinite(pf) ? pf : (st.totalPnl > 0 ? 999 : 0);

        if (n < (opts.minStockTrades || 30)) continue;
        if (safePf < (opts.minStockPF || 1.3)) continue;

        if (opts.useFDR && fdrResult.pass && !fdrResult.pass.has(key)) continue;

        // LB از bootstrap (اگه analysisService داریم)
        // فعلاً ساده: skip LB چک اگه سرویس نبود
        candidates.push({
            symbol: r.symbol,
            strategyId: r.strategyId,
            strategyName: r.strategyName,
            timeframe: r.timeframe,
            htfTimeframe: r.htfTimeframe,
            stockPF: safePf,
            stockN: n,
            stockWinRate: st.winRate || 0,
            stockAvgPnl: st.avgPnl || 0,
            trades: r.trades,
            pValue: pvalues.find(x => x.key === key)?.p ?? null
        });
    }

    // مرتب‌سازی نزولی بر اساس PF
    candidates.sort((a, b) => b.stockPF - a.stockPF);

    return {
        candidates,
        fdrMeta: {
            applied: !!opts.useFDR,
            totalTested: pvalues.length,
            passed: fdrResult.pass ? fdrResult.pass.size : candidates.length,
            threshold: fdrResult.threshold,
            q: opts.fdrQ || 0.05
        }
    };
}

// ============================================================
// STAGE 3: Validation
// ============================================================
async function _stage3_validation(jobId, candidates, dateRange, opts) {
    const validated = [];
    const total = candidates.length;

    for (let i = 0; i < total; i++) {
        const cand = candidates[i];
        memGuard.maybeGC();

        try {
            const cfg = {
                symbol: cand.symbol,
                strategyId: cand.strategyId,
                timeframe: cand.timeframe,
                htfTimeframe: cand.htfTimeframe,
                candleType: 'heikin',
                params: {
                    ...require('../strategies').STRATEGIES[cand.strategyId].defaultParams,
                    ...(deps.settings.getStrategyDefaults(cand.strategyId) || {})
                }
            };
            const r = await deps.backtest.runBacktest(cfg, dateRange.from, dateRange.to, { mode: 'stock' });
            const st = r.stockStats || {};
            const n = st.count || 0;
            const pf = st.profitFactor;
            const safePf = Number.isFinite(pf) ? pf : (st.totalPnl > 0 ? 999 : 0);

            if (n >= 3 && safePf >= (opts.minValidationPF || 1.0)) {
                validated.push({
                    ...cand,
                    valPF: safePf,
                    valN: n,
                    valWinRate: st.winRate || 0,
                    valAvgPnl: st.avgPnl || 0,
                    valTrades: r.trades || []
                });
            } else {
                // رد شد
            }
        } catch (e) {
            deps.logger && deps.logger.warn(`[dual-stage] stage3 ${cand.symbol}/${cand.strategyId}: ${e.message}`);
        }

        if (i % 5 === 0 || i === total - 1) {
            await deps.getDB().collection(COLLECTIONS.BACKTEST_JOBS).updateOne(
                { _id: new ObjectId(jobId) },
                { $set: {
                    'progress.current': i + 1,
                    'progress.total': total,
                    'progress.message': `${STAGE_LABELS[3]} — ${i + 1}/${total} (${cand.symbol})`,
                    updatedAt: new Date()
                } }
            );
        }
        await new Promise(res => setImmediate(res));
    }

    return { validated, initialCount: total };
}

// ============================================================
// STAGE 4: Leader/Confirmer Selection
// ============================================================
async function _stage4_leaderConfirmer(validated, signalTimesBySymbolStrat, opts) {
    // Group by symbol
    const bySymbol = {};
    for (const v of validated) {
        if (!bySymbol[v.symbol]) bySymbol[v.symbol] = [];
        bySymbol[v.symbol].push(v);
    }

    const plans = [];
    const maxConfirmers = opts.maxConfirmers || 2;
    const threshold = opts.signalCorrThreshold || 0.5;
    const tolerance = opts.signalCorrToleranceSec || 300;

    for (const [sym, list] of Object.entries(bySymbol)) {
        // مرتب بر اساس PF (نزولی)
        list.sort((a, b) => b.valPF - a.valPF);
        const leader = list[0];

        // signal correlation matrix برای این نماد
        const timesByStrategy = {};
        for (const c of list) {
            const key = `${sym}::${c.strategyId}`;
            const times = signalTimesBySymbolStrat.get(key);
            if (times && times.length) timesByStrategy[c.strategyId] = times;
        }

        const corrMatrix = buildSignalCorrelationMatrix(timesByStrategy, tolerance);

        const { confirmers: confirmerIds, rejected } = selectIndependentConfirmers(
            leader.strategyId,
            list.map(x => ({ strategyId: x.strategyId, pf: x.valPF })),
            corrMatrix,
            threshold,
            maxConfirmers
        );

        const confirmerObjs = confirmerIds
            .map(sid => list.find(x => x.strategyId === sid))
            .filter(Boolean);

        // چک regime diversity روی leader's trades
        let regimeInfo = null;
        try {
            const dailyCandles = await deps.dataService
                ? await deps.dataService.getCandles(sym, '1d')
                : [];
            regimeInfo = computeRegimeDistribution(leader.trades || [], dailyCandles);
        } catch (_) {}

        const diverse = !regimeInfo || regimeInfo.diverse === true;

        plans.push({
            symbol: sym,
            leader: {
                strategyId: leader.strategyId,
                strategyName: leader.strategyName,
                timeframe: leader.timeframe,
                htfTimeframe: leader.htfTimeframe,
                stockPF: leader.stockPF,
                valPF: leader.valPF,
                stockN: leader.stockN,
                valN: leader.valN
            },
            confirmers: confirmerObjs.map(c => ({
                strategyId: c.strategyId,
                strategyName: c.strategyName,
                timeframe: c.timeframe,
                htfTimeframe: c.htfTimeframe,
                stockPF: c.stockPF,
                valPF: c.valPF
            })),
            signalCorrelation: corrMatrix,
            regime: regimeInfo,
            diverse,
            rejected,
            allCandidates: list.map(x => ({
                strategyId: x.strategyId,
                strategyName: x.strategyName,
                stockPF: x.stockPF,
                valPF: x.valPF,
                stockN: x.stockN,
                valN: x.valN
            }))
        });
    }

    return { plans };
}

// ============================================================
// STAGE 5: Option Backtest روی Test
// ============================================================
async function _stage5_optionBacktest(jobId, plans, dateRange, opts) {
    const results = [];
    const STRATEGIES = require('../strategies').STRATEGIES;

    // ساخت لیست همه‌ی pairهای leader+confirmers
    const pairsToRun = [];
    for (const p of plans) {
        pairsToRun.push({
            symbol: p.symbol,
            strategyId: p.leader.strategyId,
            strategyName: p.leader.strategyName,
            timeframe: p.leader.timeframe,
            htfTimeframe: p.leader.htfTimeframe,
            role: 'leader',
            stockPF: p.leader.stockPF,
            valPF: p.leader.valPF
        });
        for (const c of p.confirmers) {
            pairsToRun.push({
                symbol: p.symbol,
                strategyId: c.strategyId,
                strategyName: c.strategyName,
                timeframe: c.timeframe,
                htfTimeframe: c.htfTimeframe,
                role: 'confirmer',
                stockPF: c.stockPF,
                valPF: c.valPF
            });
        }
    }

    const total = pairsToRun.length;
    for (let i = 0; i < total; i++) {
        const pair = pairsToRun[i];
        memGuard.maybeGC();

        const def = STRATEGIES[pair.strategyId];
        const cfg = {
            symbol: pair.symbol,
            strategyId: pair.strategyId,
            timeframe: pair.timeframe,
            htfTimeframe: pair.htfTimeframe,
            candleType: 'heikin',
            params: {
                ...def.defaultParams,
                ...(deps.settings.getStrategyDefaults(pair.strategyId) || {})
            }
        };

        try {
            const r = await deps.backtest.runBacktest(cfg, dateRange.from, dateRange.to, {
                mode: 'option',
                useRealOption: true
            });
            const optStats = r.optionStats || r.stats || {};
            const realUsed = r.realUsed || 0;
            const approxUsed = r.approxUsed || 0;
            const realRatio = (realUsed + approxUsed) > 0 ? realUsed / (realUsed + approxUsed) : 0;
            const n = optStats.count || 0;
            const pf = optStats.profitFactor;
            const safePf = Number.isFinite(pf) ? pf : (optStats.totalPnl > 0 ? 999 : 0);

            results.push({
                symbol: pair.symbol,
                strategyId: pair.strategyId,
                strategyName: pair.strategyName,
                role: pair.role,
                stockPF: pair.stockPF,
                valPF: pair.valPF,
                optionPF: safePf,
                optionN: n,
                optionWinRate: optStats.winRate || 0,
                optionAvgPnl: optStats.avgPnl || 0,
                optionTotalPnl: optStats.totalPnl || 0,
                realUsed,
                approxUsed,
                realRatio,
                trades: r.trades || [],
                diagnostic: r.diagnostic || null
            });
        } catch (e) {
            deps.logger && deps.logger.warn(`[dual-stage] stage5 ${pair.symbol}/${pair.strategyId}: ${e.message}`);
            results.push({
                symbol: pair.symbol,
                strategyId: pair.strategyId,
                role: pair.role,
                error: e.message
            });
        }

        if (i % 5 === 0 || i === total - 1) {
            await deps.getDB().collection(COLLECTIONS.BACKTEST_JOBS).updateOne(
                { _id: new ObjectId(jobId) },
                { $set: {
                    'progress.current': i + 1,
                    'progress.total': total,
                    'progress.message': `${STAGE_LABELS[5]} — ${i + 1}/${total} (${pair.symbol})`,
                    updatedAt: new Date()
                } }
            );
        }
        await new Promise(res => setImmediate(res));
    }

    return { results };
}

// ============================================================
// STAGE 6: Verdict
// ============================================================
function _stage6_verdict(optionResults, opts) {
    const verdicts = [];
    const goThreshold = opts.goThreshold || 0.7;
    const maybeThreshold = opts.maybeThreshold || 0.5;
    const minOptN = opts.minOptionTrades || 5;
    const minRealRatio = opts.minRealRatio || 0.5;
    const minPF = opts.minOptionPF || 1.2;
    const minAvg = opts.minAvgPnl != null ? opts.minAvgPnl : 0;

    for (const r of optionResults) {
        if (r.error) {
            verdicts.push({ ...r, verdict: 'SKIP', reason: `خطا: ${r.error}` });
            continue;
        }

        const ratio = r.stockPF > 0 ? r.optionPF / r.stockPF : 0;
        const reasons = [];

        if (r.optionN < minOptN) reasons.push(`N=${r.optionN} < ${minOptN}`);
        if (r.realRatio < minRealRatio) reasons.push(`realRatio=${(r.realRatio*100).toFixed(0)}% < ${(minRealRatio*100)}%`);
        if (r.optionPF < minPF) reasons.push(`PF=${r.optionPF} < ${minPF}`);
        if (r.optionAvgPnl < minAvg) reasons.push(`AvgPnl=${r.optionAvgPnl.toFixed(1)}% < ${minAvg}%`);

        let verdict = 'SKIP';
        let verdictReason = '';

        if (!reasons.length) {
            if (ratio >= goThreshold) {
                verdict = 'GO';
                verdictReason = `ratio=${ratio.toFixed(2)} ≥ ${goThreshold}`;
            } else if (ratio >= maybeThreshold) {
                verdict = 'MAYBE';
                verdictReason = `ratio=${ratio.toFixed(2)} در بازه [${maybeThreshold}, ${goThreshold})`;
            } else {
                verdict = 'SKIP';
                verdictReason = `ratio=${ratio.toFixed(2)} < ${maybeThreshold}`;
            }
        } else {
            verdictReason = reasons.join(' + ');
        }

        verdicts.push({
            symbol: r.symbol,
            strategyId: r.strategyId,
            strategyName: r.strategyName,
            role: r.role,
            stockPF: r.stockPF,
            optionPF: r.optionPF,
            ratio: Math.round(ratio * 100) / 100,
            optionN: r.optionN,
            realRatio: Math.round(r.realRatio * 1000) / 10,
            optionAvgPnl: Math.round(r.optionAvgPnl * 100) / 100,
            optionWinRate: r.optionWinRate,
            verdict,
            verdictReason
        });
    }

    const summary = {
        go: verdicts.filter(v => v.verdict === 'GO').length,
        maybe: verdicts.filter(v => v.verdict === 'MAYBE').length,
        skip: verdicts.filter(v => v.verdict === 'SKIP').length,
        total: verdicts.length
    };

    return { verdicts, summary };
}

// ============================================================
// STAGE 7: Apply
// ============================================================
async function _stage7_apply(verdicts, plans, opts) {
    if (opts.dryRun) {
        return { applied: 0, skipped: verdicts.length, dryRun: true };
    }
    const db = deps.getDB();
    const STRATEGIES = require('../strategies').STRATEGIES;

    // برای هر نماد، لیست pairهای GO/MAYBE رو جمع کن
    const bySymbol = {};
    for (const v of verdicts) {
        if (v.verdict === 'SKIP') continue;
        if (!bySymbol[v.symbol]) bySymbol[v.symbol] = [];
        bySymbol[v.symbol].push(v);
    }

    const applied = [];
    for (const [sym, list] of Object.entries(bySymbol)) {
        // چک: leader هست؟
        const hasLeader = list.some(x => x.role === 'leader');
        if (!hasLeader) continue;

        // حذف configs قدیمی
        const old = await db.collection(COLLECTIONS.STRATEGY_CONFIGS).find({ symbol: sym }).toArray();
        const oldIds = old.map(o => o._id.toString());
        await db.collection(COLLECTIONS.STRATEGY_CONFIGS).deleteMany({ symbol: sym });
        await db.collection(COLLECTIONS.SIGNALS_STATE).deleteMany({ configId: { $in: oldIds } });

        // ساخت configs جدید
        let added = 0;
        for (const v of list) {
            const def = STRATEGIES[v.strategyId];
            if (!def) continue;

            const sizeMultiplier = v.verdict === 'GO' ? 1.0 : 0.5;

            const doc = {
                symbol: sym,
                strategyId: v.strategyId,
                timeframe: def.defaultTimeframe,
                htfTimeframe: def.htfTimeframe || '1d',
                candleType: 'heikin',
                params: {
                    ...def.defaultParams,
                    ...(deps.settings.getStrategyDefaults(v.strategyId) || {})
                },
                enabled: true,
                role: v.role,
                sizeMultiplier,
                autoConfigured: true,
                pipelineVerdict: v.verdict,
                pipelineMeta: {
                    stockPF: v.stockPF,
                    optionPF: v.optionPF,
                    ratio: v.ratio,
                    optionN: v.optionN,
                    realRatio: v.realRatio
                },
                createdAt: new Date()
            };
            await db.collection(COLLECTIONS.STRATEGY_CONFIGS).insertOne(doc);
            added++;
        }

        applied.push({
            symbol: sym,
            added,
            go: list.filter(x => x.verdict === 'GO').length,
            maybe: list.filter(x => x.verdict === 'MAYBE').length
        });
    }

    return { applied: applied.length, symbols: applied };
}

// ============================================================
// Helper: t-test p-value (یک‌طرفه، H1: mean > 0)
// ============================================================
function _oneSampleTTestPValue(pnls) {
    const n = pnls.length;
    if (n < 3) return 1;
    const mean = pnls.reduce((s, x) => s + x, 0) / n;
    const variance = pnls.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1);
    const sd = Math.sqrt(variance);
    if (sd === 0) return mean > 0 ? 0 : 1;
    const se = sd / Math.sqrt(n);
    const t = mean / se;
    return 1 - _studentTCdf(t, n - 1);
}

function _studentTCdf(t, df) {
    const x = df / (df + t * t);
    const ib = _incompleteBeta(x, df / 2, 0.5);
    return t >= 0 ? 1 - 0.5 * ib : 0.5 * ib;
}

function _incompleteBeta(x, a, b) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    const bt = Math.exp(_logGamma(a + b) - _logGamma(a) - _logGamma(b) +
        a * Math.log(x) + b * Math.log(1 - x));
    if (x < (a + 1) / (a + b + 2)) return bt * _betacf(x, a, b) / a;
    return 1 - bt * _betacf(1 - x, b, a) / b;
}

function _betacf(x, a, b) {
    const MAXIT = 200, EPS = 3e-7, FPMIN = 1e-30;
    const qab = a + b, qap = a + 1, qam = a - 1;
    let c = 1, d = 1 - qab * x / qap;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    d = 1 / d;
    let h = d;
    for (let m = 1; m <= MAXIT; m++) {
        const m2 = 2 * m;
        let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
        d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
        c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
        d = 1 / d; h *= d * c;
        aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
        d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
        c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
        d = 1 / d;
        const del = d * c;
        h *= del;
        if (Math.abs(del - 1) < EPS) break;
    }
    return h;
}

function _logGamma(x) {
    const cof = [
        76.18009172947146, -86.50532032941677, 24.01409824083091,
        -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5
    ];
    let y = x, tmp = x + 5.5;
    tmp -= (x + 0.5) * Math.log(tmp);
    let ser = 1.000000000190015;
    for (let j = 0; j < 6; j++) ser += cof[j] / ++y;
    return -tmp + Math.log(2.5066282746310005 * ser / x);
}

// ============================================================
// MAIN: runDualStage
// ============================================================
async function runDualStage(jobId, opts = {}) {
    const db = deps.getDB();
    const merged = { ...DEFAULTS, ...opts };
    const t0 = Date.now();

    // load job state (resume)
    const job = await db.collection(COLLECTIONS.BACKTEST_JOBS).findOne({ _id: new ObjectId(jobId) });
    if (!job) throw new Error('job not found');

    const savedStage = job.pipelineStage || 0;
    const savedState = job.pipelineState || {};

    deps.logger && deps.logger.info(`[dual-stage ${jobId}] start from stage ${savedStage + 1}`);

    try {
        // ---- Resolve ranges ----
        const ranges = savedState.ranges || await _resolveDateRanges(merged);
        await _setStage(jobId, 0, { ranges });

        // ---- Build configs ----
        const { configs, symbols, strategies } = savedState.configs
            ? { configs: savedState.configs, symbols: savedState.symbols, strategies: savedState.strategies }
            : await _buildConfigs(merged);
        if (!savedState.configs) {
            await _setStage(jobId, 0, {
                configs,
                symbols,
                strategies,
                totalConfigs: configs.length
            });
        }

        deps.logger && deps.logger.info(
            `[dual-stage ${jobId}] ${symbols.length} sym × ${strategies.length} strat = ${configs.length} combos`
        );

        // ============ STAGE 1 ============
        let stage1;
        if (savedStage >= 1 && savedState.stage1) {
            stage1 = savedState.stage1;
            // reconstruct signalTimes Map
            stage1.signalTimesBySymbolStrat = new Map(Object.entries(savedState.stage1.signalTimes || {}));
        } else {
            await _setStage(jobId, 1);
            stage1 = await _stage1_stockBacktest(jobId, configs, ranges.train, savedState);
            // serialize Map
            await _setStage(jobId, 1, {
                stage1: {
                    done: stage1.done,
                    resultCount: stage1.results.length,
                    signalTimes: Object.fromEntries(stage1.signalTimesBySymbolStrat)
                }
            });
            // ذخیره‌ی results سنگین رو skip می‌کنیم (فقط در memory استفاده می‌شن)
        }

        // ============ STAGE 2 ============
        await _setStage(jobId, 2);
        const stage2 = _stage2_fdrFilter(stage1.results, merged);
        await _setStage(jobId, 2, {
            stage2: {
                candidateCount: stage2.candidates.length,
                fdrMeta: stage2.fdrMeta
            }
        });
        deps.logger && deps.logger.info(
            `[dual-stage ${jobId}] stage2: ${stage2.candidates.length} candidates (FDR: ${stage2.fdrMeta.passed}/${stage2.fdrMeta.totalTested})`
        );

        // ============ STAGE 3 ============
        await _setStage(jobId, 3);
        const stage3 = await _stage3_validation(jobId, stage2.candidates, ranges.validation, merged);
        await _setStage(jobId, 3, {
            stage3: {
                initialCount: stage3.initialCount,
                validatedCount: stage3.validated.length
            }
        });
        deps.logger && deps.logger.info(
            `[dual-stage ${jobId}] stage3: ${stage3.validated.length}/${stage3.initialCount} validated`
        );

        // ============ STAGE 4 ============
        await _setStage(jobId, 4);
        const stage4 = await _stage4_leaderConfirmer(
            stage3.validated,
            stage1.signalTimesBySymbolStrat,
            merged
        );
        await _setStage(jobId, 4, {
            stage4: {
                planCount: stage4.plans.length,
                symbols: stage4.plans.map(p => p.symbol)
            }
        });
        deps.logger && deps.logger.info(`[dual-stage ${jobId}] stage4: ${stage4.plans.length} plans`);

        // ============ STAGE 5 ============
        await _setStage(jobId, 5);
        const stage5 = await _stage5_optionBacktest(jobId, stage4.plans, ranges.test, merged);
        await _setStage(jobId, 5, {
            stage5: {
                pairCount: stage5.results.length
            }
        });
        deps.logger && deps.logger.info(`[dual-stage ${jobId}] stage5: ${stage5.results.length} option results`);

        // ============ STAGE 6 ============
        await _setStage(jobId, 6);
        const stage6 = _stage6_verdict(stage5.results, merged);
        await _setStage(jobId, 6, {
            stage6: stage6.summary
        });
        deps.logger && deps.logger.info(
            `[dual-stage ${jobId}] stage6: GO=${stage6.summary.go} MAYBE=${stage6.summary.maybe} SKIP=${stage6.summary.skip}`
        );

        // ============ STAGE 7 ============
        await _setStage(jobId, 7);
        const stage7 = await _stage7_apply(stage6.verdicts, stage4.plans, merged);
        await _setStage(jobId, 7, {
            stage7
        });

        // ============ Done ============
        const elapsed = Math.round((Date.now() - t0) / 1000);
        await _setStage(jobId, 99);

        const finalResult = {
            ranges,
            stages: {
                1: { totalConfigs: configs.length },
                2: { candidates: stage2.candidates.length, fdrMeta: stage2.fdrMeta },
                3: { validated: stage3.validated.length, initial: stage3.initialCount },
                4: { plans: stage4.plans, plansCount: stage4.plans.length },
                5: { results: stage5.results },
                6: { verdicts: stage6.verdicts, summary: stage6.summary },
                7: stage7
            },
            elapsed,
            summary: {
                totalCombos: configs.length,
                candidates: stage2.candidates.length,
                validated: stage3.validated.length,
                plans: stage4.plans.length,
                go: stage6.summary.go,
                maybe: stage6.summary.maybe,
                skip: stage6.summary.skip,
                applied: stage7.applied
            }
        };

        await db.collection(COLLECTIONS.BACKTEST_JOBS).updateOne(
            { _id: new ObjectId(jobId) },
            { $set: {
                status: 'DONE',
                result: finalResult,
                finishedAt: new Date(),
                'progress.current': 7,
                'progress.message': `تکمیل — ${elapsed}s`,
                updatedAt: new Date()
            } }
        );

        // notify
        if (deps.notify) {
            try {
                const s = finalResult.summary;
                await deps.notify(
                    `🎯 Dual-Stage کامل شد (${elapsed}s)\n\n` +
                    `📊 ${s.totalCombos} ترکیب → ${s.candidates} کاندید (FDR) → ${s.validated} تایید‌شده → ${s.plans} پلن\n\n` +
                    `✅ GO: ${s.go} pair\n` +
                    `⚠️ MAYBE: ${s.maybe} pair\n` +
                    `❌ SKIP: ${s.skip} pair\n` +
                    `💾 اعمال‌شده: ${s.applied} نماد`
                );
            } catch (e) {
                deps.logger && deps.logger.warn('dual-stage notify: ' + e.message);
            }
        }

        return finalResult;

    } catch (e) {
        deps.logger && deps.logger.error(`[dual-stage ${jobId}] FATAL: ${e.message}\n${e.stack || ''}`);
        await db.collection(COLLECTIONS.BACKTEST_JOBS).updateOne(
            { _id: new ObjectId(jobId) },
            { $set: {
                status: 'FAILED',
                error: e.message,
                finishedAt: new Date(),
                updatedAt: new Date()
            } }
        );
        throw e;
    }
}

module.exports = {
    init,
    runDualStage,
    DEFAULTS,
    STAGE_LABELS,
    _resolveDateRanges,
    _buildConfigs
};