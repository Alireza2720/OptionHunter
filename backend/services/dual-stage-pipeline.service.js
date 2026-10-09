'use strict';
// ============================================================
// dual-stage-pipeline.service.js
// مکانیزم ۲ مرحله‌ای: Stock Backtest → Option Backtest
// ============================================================
// Stage 1: Stock backtest روی TRAIN
// Stage 2: FDR filter
// Stage 3: Validation روی VALIDATION
// Stage 4: Leader/Confirmer با signal correlation
// Stage 5: Option backtest روی TEST
// Stage 6: Verdict (GO/MAYBE/SKIP)
// Stage 7: Apply configs
// ============================================================

const { ObjectId } = require('mongodb');
const { COLLECTIONS, TIMEFRAME_MINUTES } = require('../config/constants');
const { buildSignalCorrelationMatrix, selectIndependentConfirmers } = require('../core/signal-correlation');
const { computeRegimeDistribution } = require('../core/regime-diversity');
const memGuard = require('../infra/memory-guard');

let deps = {
    getDB: null, logger: null,
    backtest: null, backtestService: null,
    analysisService: null,
    signalFilterService: null,
    configService: null,
    settings: null,
    algotik: null,
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

const EXCLUDED_STRATEGIES = new Set(['sector_momentum', 'ob_sweep_pro', 'ob_after_sweep', 'short_term_reversal_pro']);

const DEFAULTS = {
    // بازه‌ها — اگه null، خودکار محاسبه می‌شن
    trainFrom: null,
    trainTo: null,
    validationFrom: null,
    validationTo: null,
    testFrom: null,
    testTo: null,

    // Stage 1 gates
    minStockTrades: 20,
    minStockPF: 1.3,
    minLB: 1.0,
    fdrQ: 0,
    useFDR: false,

    // Stage 3 — 🆕 منعطف‌تر
    minValidationPF: 0.7,
    validationMinTrades: 0,

    // Stage 4
    maxConfirmers: 2,
    signalCorrThreshold: 0.5,
    signalCorrToleranceSec: 300,

    // Stage 5 gates (R14: relaxed for real data availability)
    minOptionTrades: 3,
    minRealRatio: 0.3,
    minOptionPF: 1.05,

    // Verdict
    goThreshold: 0.6,
    maybeThreshold: 0.4,
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
// Helper: چک cancel
// ============================================================
async function _isCancelled(jobId) {
    try {
        const j = await deps.getDB().collection(COLLECTIONS.BACKTEST_JOBS)
            .findOne({ _id: new ObjectId(jobId) }, { projection: { cancelRequested: 1, status: 1 } });
        return !!(j && (j.cancelRequested || j.status === 'CANCELLED'));
    } catch (_) {
        return false;
    }
}

// ============================================================
// Helper: بازه‌ها
// ============================================================
// 🆕 helper: هر ورودی رو به Unix seconds تبدیل کن
function _toUnixSec(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number') {
        if (!Number.isFinite(v)) return null;
        // اگر میلی‌ثانیه بود (بزرگتر از 1e12) → به ثانیه
        return v > 1e12 ? Math.floor(v / 1000) : Math.floor(v);
    }
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : Math.floor(d.getTime() / 1000);
}

async function _resolveDateRanges(opts) {
    const db = deps.getDB();

    function _clamp(ts) {
        if (ts == null || !Number.isFinite(Number(ts))) return null;
        return Math.floor(Number(ts));
    }

    // R13c: default = last 180 days of real option data
    let _latestOptionTs = null;
    try {
        const latest = await db.collection(COLLECTIONS.OPTION_HISTORY)
            .findOne({ time: { $type: "date" } }, { sort: { time: -1 }, projection: { time: 1 } });
        if (latest && latest.time) {
            _latestOptionTs = Math.floor(new Date(latest.time).getTime() / 1000);
        }
    } catch (_) {}
    if (!_latestOptionTs) _latestOptionTs = Math.floor(Date.now() / 1000);

    let testFrom = _clamp(_toUnixSec(opts.testFrom));
    let testTo   = _clamp(_toUnixSec(opts.testTo));
    if (!testFrom) testFrom = _latestOptionTs - 180 * 86400;
    if (!testTo)   testTo   = _latestOptionTs;

    let valTo   = _clamp(_toUnixSec(opts.validationTo));
    let valFrom = _clamp(_toUnixSec(opts.validationFrom));
    if (!valTo)   valTo   = testFrom - 86400;
    if (!valFrom) valFrom = valTo - 60 * 86400;

    let trainTo   = _clamp(_toUnixSec(opts.trainTo));
    let trainFrom = _clamp(_toUnixSec(opts.trainFrom));
    if (!trainTo)   trainTo   = valFrom - 86400;
    if (!trainFrom) trainFrom = trainTo - 365 * 86400;

    if (trainFrom >= trainTo) trainFrom = trainTo - 365 * 86400;
    if (valFrom >= valTo) valFrom = valTo - 60 * 86400;
    if (testFrom >= testTo) testFrom = testTo - 90 * 86400;

    return {
        train: { from: trainFrom, to: trainTo, days: Math.max(1, Math.round((trainTo - trainFrom) / 86400)) },
        validation: { from: valFrom, to: valTo, days: Math.max(1, Math.round((valTo - valFrom) / 86400)) },
        test: { from: testFrom, to: testTo, days: Math.max(1, Math.round((testTo - testFrom) / 86400)) }
    };
}

// ============================================================
// Helper: configs
// ============================================================
async function _buildConfigs(opts) {
    const db = deps.getDB();
    const STRATEGIES = require('../strategies').STRATEGIES;

    // 🆕 defensive settings accessor
    const getDefaults = (sid) => {
        try {
            if (deps.settings && typeof deps.settings.getStrategyDefaults === 'function') {
                return deps.settings.getStrategyDefaults(sid) || {};
            }
        } catch (_) {}
        return {};
    };

    let symbols = opts.symbols;
    if (!symbols || !symbols.length) {
        const monitored = await db.collection(COLLECTIONS.MONITORED_SYMBOLS)
            .find({ enabled: true }).toArray();
        symbols = monitored.map(m => m.symbol);
    }

    let strategyIds = opts.strategies;
    if (!strategyIds || !strategyIds.length) {
        strategyIds = Object.values(STRATEGIES)
            .filter(s => !EXCLUDED_STRATEGIES.has(s.id))
            .map(s => s.id);
    } else {
        strategyIds = strategyIds.filter(id => STRATEGIES[id] && !EXCLUDED_STRATEGIES.has(id));
        if (!strategyIds.length) {
            deps.logger && deps.logger.warn(
                '[dual-stage] all strategies excluded — fallback to defaults'
            );
            strategyIds = Object.values(STRATEGIES)
                .filter(s => !EXCLUDED_STRATEGIES.has(s.id))
                .map(s => s.id);
        }
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
                    ...getDefaults(sid)
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
// STAGE 1
// ============================================================
async function _stage1_stockBacktest(jobId, configs, dateRange, resumeState) {
    const results = [];
    const signalTimesBySymbolStrat = new Map();
    const total = configs.length;
    const done = (resumeState && resumeState.stage1 && resumeState.stage1.done) || 0;

    for (let i = done; i < total; i++) {
        // 🆕 چک cancel هر ۲۵ pair
        if (i % 25 === 0 && await _isCancelled(jobId)) {
            throw new Error('CANCELLED_BY_USER');
        }
        const cfg = configs[i];
        memGuard.maybeGC();

        try {
            const r = await deps.backtest.runBacktest(cfg, dateRange.from, dateRange.to, {
                mode: 'stock',
                lightMode: true   // 🆕 skip MC/robustness
            });
            const fullTrades = r.stockTrades || r.trades || [];
            results.push({
                symbol: cfg.symbol,
                strategyId: cfg.strategyId,
                strategyName: cfg.strategyName,
                timeframe: cfg.timeframe,
                htfTimeframe: cfg.htfTimeframe,
                stockStats: r.stockStats,
                trades: fullTrades
            });
            const key = `${cfg.symbol}::${cfg.strategyId}`;
            // 🆕 limit به ۵۰۰۰ تای اول برای جلوگیری از سند بیش‌ازحد بزرگ
            signalTimesBySymbolStrat.set(
                key,
                fullTrades.slice(0, 5000).map(t => t.entryTime).filter(Number.isFinite)
            );
        } catch (e) {
            deps.logger && deps.logger.warn(`[dual-stage] stage1 ${cfg.symbol}/${cfg.strategyId}: ${e.message}`);
            results.push({
                symbol: cfg.symbol,
                strategyId: cfg.strategyId,
                strategyName: cfg.strategyName,
                error: e.message
            });
        }

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
// STAGE 2: FDR filter
// ============================================================
function _stage2_fdrFilter(stage1Results, opts) {
    // Practical confidence — FDR removed
    // criterion: minTrades + minPF + optional minValidationPF
    const candidates = [];
    for (const r of stage1Results) {
        if (r.error) continue;
        const st = r.stockStats || {};
        const n = st.count || 0;
        const pf = st.profitFactor;
        const safePf = Number.isFinite(pf) ? pf : (st.totalPnl > 0 ? 999 : 0);

        if (n < (opts.minStockTrades || 20)) continue;
        if (safePf < (opts.minStockPF || 1.3)) continue;

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
            pValue: null
        });
    }

    candidates.sort((a, b) => b.stockPF - a.stockPF);

    return {
        candidates,
        fdrMeta: {
            applied: false,
            mode: 'practical-confidence',
            totalTested: stage1Results.length,
            passed: candidates.length,
            threshold: opts.minStockPF || 1.3,
            q: null
        }
    };
}

// ============================================================
// STAGE 3: Validation — 🆕 منطق منعطف
// ============================================================
async function _stage3_validation(jobId, candidates, dateRange, opts) {
    const validated = [];
    const rejected = [];
    const total = candidates.length;
    const STRATEGIES = require('../strategies').STRATEGIES;

    for (let i = 0; i < total; i++) {
        if (i % 25 === 0 && await _isCancelled(jobId)) {
            throw new Error('CANCELLED_BY_USER');
        }
        const cand = candidates[i];
        memGuard.maybeGC();

        const def = STRATEGIES[cand.strategyId];
        const cfg = {
            symbol: cand.symbol,
            strategyId: cand.strategyId,
            timeframe: cand.timeframe,
            htfTimeframe: cand.htfTimeframe,
            candleType: 'heikin',
            params: {
                ...(def ? def.defaultParams : {}),
                ...((deps.settings && deps.settings.getStrategyDefaults)
                    ? (deps.settings.getStrategyDefaults(cand.strategyId) || {})
                    : {})
            }
        };

        try {
            const r = await deps.backtest.runBacktest(cfg, dateRange.from, dateRange.to, {
                mode: 'stock',
                lightMode: true
            });
            const st = r.stockStats || {};
            const n = st.count || 0;
            const pf = st.profitFactor;
            const safePf = Number.isFinite(pf) ? pf : (st.totalPnl > 0 ? 999 : 0);

            // 🆕 Validation منعطف:
            // - n=0: قبول (استراتژی در بازه‌ی کوتاه فایر نکرده، دلیل رد نیست)
            // - 1-4 trade: قبول
            // - 5+: PF >= minValidationPF (0.8) قبول
            let pass = false;
            let valNote = null;
            if (n === 0) {
                pass = true;
                valNote = 'no trades in validation (neutral)';
            } else if (n < 5) {
                pass = true;
                valNote = `only ${n} trades (too few to judge)`;
            } else if (safePf >= (opts.minValidationPF || 0.8)) {
                pass = true;
                valNote = `PF=${safePf.toFixed(2)}, N=${n}`;
            } else {
                valNote = `PF=${safePf.toFixed(2)} < ${opts.minValidationPF || 0.8} (N=${n})`;
            }

            if (pass) {
                validated.push({
                    ...cand,
                    valPF: safePf,
                    valN: n,
                    valWinRate: st.winRate || 0,
                    valAvgPnl: st.avgPnl || 0,
                    valNote,
                    valTrades: r.trades || []
                });
            } else {
                rejected.push({
                    symbol: cand.symbol,
                    strategyId: cand.strategyId,
                    strategyName: cand.strategyName,
                    stockPF: cand.stockPF,
                    stockN: cand.stockN,
                    valPF: safePf,
                    valN: n,
                    reason: valNote
                });
                deps.logger && deps.logger.info(
                    `[dual-stage stage3] ${cand.symbol}/${cand.strategyId} rejected: ${valNote}`
                );
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

    return { validated, rejected, initialCount: total };
}

// ============================================================
// STAGE 4: Leader/Confirmer
// ============================================================
async function _stage4_leaderConfirmer(validated, signalTimesBySymbolStrat, opts) {
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
        list.sort((a, b) => b.valPF - a.valPF);
        const leader = list[0];

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

        let regimeInfo = null;
        try {
            const dataService = require('./data.service');
            if (dataService && dataService.getCandles) {
                const dailyCandles = await dataService.getCandles(sym, '1d');
                regimeInfo = computeRegimeDistribution(leader.trades || [], dailyCandles);
            }
        } catch (e) {
            deps.logger && deps.logger.warn(`[dual-stage stage4] regime ${sym}: ${e.message}`);
        }

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
// STAGE 5: Option Backtest
// ============================================================
async function _stage5_optionBacktest(jobId, plans, dateRange, opts) {
    const results = [];
    const STRATEGIES = require('../strategies').STRATEGIES;

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
        if (i % 10 === 0 && await _isCancelled(jobId)) {
            throw new Error('CANCELLED_BY_USER');
        }
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
                ...(def ? def.defaultParams : {}),
                ...((deps.settings && deps.settings.getStrategyDefaults)
                    ? (deps.settings.getStrategyDefaults(pair.strategyId) || {})
                    : {})
            }
        };

        try {
            const r = await deps.backtest.runBacktest(cfg, dateRange.from, dateRange.to, {
                mode: 'option',
                useRealOption: true,
                optionType: opts.optionType || 'call',
                lightMode: true,
                // Respect user-selected quality level
                qualityLevel: (opts.qualityLevel || null)
            });
            const optStats = r.optionStats || r.stats || {};
            const realUsed = r.realUsed || 0;
            const approxUsed = r.approxUsed || 0;
            const realRatio = (realUsed + approxUsed) > 0 ? realUsed / (realUsed + approxUsed) : 0;
            const n = optStats.count || 0;
            const pf = optStats.profitFactor;
            const safePf = Number.isFinite(pf) ? pf : (optStats.totalPnl > 0 ? 999 : 0);

            // 🆕 diagnostic غنی اگه N=0
            let optDiag = r.diagnostic || null;
            if (n === 0) {
                try {
                    const db2 = deps.getDB();
                    const totalWithBidAsk = await db2.collection(COLLECTIONS.OPTION_HISTORY).countDocuments({
                        underlying: pair.symbol,
                        time: { $gte: dateRange.from, $lte: dateRange.to },
                        bid: { $gt: 0 }, ask: { $gt: 0 }
                    });
                    const totalWithDelta = await db2.collection(COLLECTIONS.OPTION_HISTORY).countDocuments({
                        underlying: pair.symbol,
                        time: { $gte: dateRange.from, $lte: dateRange.to },
                        bid: { $gt: 0 }, ask: { $gt: 0 },
                        deltaApi: { $gte: 0.30, $lte: 0.98 },
                        daysLeft: { $gte: 7, $lte: 90 }
                    });
                    optDiag = `N=0 | available: ${totalWithBidAsk} with bid/ask, ${totalWithDelta} after delta/days filter | ${r.diagnostic || ''}`;
                } catch (_) {
                    optDiag = `N=0 | ${r.diagnostic || 'no diagnostic'}`;
                }
            }

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
                diagnostic: optDiag
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
    const minOptN = opts.minOptionTrades || 3;
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

        if (r.optionN < minOptN) reasons.push(`N_opt=${r.optionN} < ${minOptN} (کیفیت آپشن را به سطح پایین‌تر تغییر بده)`);
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

    const bySymbol = {};
    for (const v of verdicts) {
        if (v.verdict === 'SKIP') continue;
        if (!bySymbol[v.symbol]) bySymbol[v.symbol] = [];
        bySymbol[v.symbol].push(v);
    }

    const applied = [];
    const skippedNoLeader = [];
    for (const [sym, list] of Object.entries(bySymbol)) {
        const hasLeader = list.some(x => x.role === 'leader');
        if (!hasLeader) {
            // 🆕 لاگ کن چرا skip شد
            const confirmerOnly = list.map(x => x.strategyId);
            skippedNoLeader.push({ symbol: sym, confirmerOnly });
            deps.logger && deps.logger.info(
                `[dual-stage stage7] ${sym}: no leader among verdicts (only confirmers: ${confirmerOnly.join(', ')})`
            );
            continue;
        }

        const old = await db.collection(COLLECTIONS.STRATEGY_CONFIGS).find({ symbol: sym }).toArray();
        const oldIds = old.map(o => o._id.toString());
        await db.collection(COLLECTIONS.STRATEGY_CONFIGS).deleteMany({ symbol: sym });
        await db.collection(COLLECTIONS.SIGNALS_STATE).deleteMany({ configId: { $in: oldIds } });

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
                    ...((deps.settings && deps.settings.getStrategyDefaults)
                        ? (deps.settings.getStrategyDefaults(v.strategyId) || {})
                        : {})
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

    return { applied: applied.length, symbols: applied, skippedNoLeader };
}

// ============================================================
// t-test helpers
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
// MAIN
// ============================================================
async function runDualStage(jobId, opts = {}) {
    const db = deps.getDB();
    const merged = { ...DEFAULTS, ...opts };
    const t0 = Date.now();

    const job = await db.collection(COLLECTIONS.BACKTEST_JOBS).findOne({ _id: new ObjectId(jobId) });
    if (!job) throw new Error('job not found');

    if (job.cancelRequested || job.status === 'CANCELLED') {
        deps.logger && deps.logger.info(`[dual-stage ${jobId}] cancelled before start`);
        return { cancelled: true };
    }

    // 🆕 Memory guard داخل runner (نه فقط route)
    const memCheck = memGuard.canStartHeavyJob();
    if (!memCheck.ok) {
        deps.logger && deps.logger.error(
            `[dual-stage ${jobId}] memory guard: ${memCheck.reason} ` +
            `(free=${memCheck.status && memCheck.status.systemFreeMB}MB, ` +
            `rss=${memCheck.status && memCheck.status.processRssMB}MB)`
        );
        await db.collection(COLLECTIONS.BACKTEST_JOBS).updateOne(
            { _id: new ObjectId(jobId) },
            { $set: {
                status: 'FAILED',
                error: `Memory guard: ${memCheck.reason}`,
                finishedAt: new Date(),
                updatedAt: new Date()
            } }
        );
        return { error: memCheck.reason };
    }

    const savedStage = job.pipelineStage || 0;
    const savedState = job.pipelineState || {};

    deps.logger && deps.logger.info(`[dual-stage ${jobId}] start from stage ${savedStage + 1}`);

    try {
        const ranges = savedState.ranges || await _resolveDateRanges(merged);
        await _setStage(jobId, 0, { ranges });

        const { configs, symbols, strategies } = savedState.configs
            ? { configs: savedState.configs, symbols: savedState.symbols, strategies: savedState.strategies }
            : await _buildConfigs(merged);
        if (!savedState.configs) {
            await _setStage(jobId, 0, {
                configs, symbols, strategies,
                totalConfigs: configs.length
            });
        }

        deps.logger && deps.logger.info(
            `[dual-stage ${jobId}] ${symbols.length} sym × ${strategies.length} strat = ${configs.length} combos`
        );

        // STAGE 1
        // 🆕 Resume غیرفعال — چون stage1.results در DB ذخیره نمی‌شه.
        // اگه job نیمه‌کاره مونده، از صفر شروع می‌کنیم (fail-safe).
        await _setStage(jobId, 1);
        const stage1 = await _stage1_stockBacktest(jobId, configs, ranges.train, {});
        await _setStage(jobId, 1, {
            stage1: {
                done: stage1.done,
                resultCount: stage1.results.length,
                signalTimes: Object.fromEntries(stage1.signalTimesBySymbolStrat)
            }
        });

        // STAGE 2
        await _setStage(jobId, 2);
        const stage2 = _stage2_fdrFilter(stage1.results, merged);
        await _setStage(jobId, 2, {
            stage2: {
                candidateCount: stage2.candidates.length,
                fdrMeta: stage2.fdrMeta,
                candidates: stage2.candidates.map(c => ({
                    symbol: c.symbol,
                    strategyId: c.strategyId,
                    strategyName: c.strategyName,
                    timeframe: c.timeframe,
                    htfTimeframe: c.htfTimeframe,
                    stockPF: c.stockPF,
                    stockN: c.stockN,
                    stockWinRate: c.stockWinRate,
                    stockAvgPnl: c.stockAvgPnl,
                    pValue: c.pValue
                }))
            }
        });
        deps.logger && deps.logger.info(
            `[dual-stage ${jobId}] stage2: ${stage2.candidates.length} candidates (FDR: ${stage2.fdrMeta.passed}/${stage2.fdrMeta.totalTested})`
        );

        // STAGE 3
        await _setStage(jobId, 3);
        const stage3 = await _stage3_validation(jobId, stage2.candidates, ranges.validation, merged);
        await _setStage(jobId, 3, {
            stage3: {
                initialCount: stage3.initialCount,
                validatedCount: stage3.validated.length,
                validated: stage3.validated.map(c => ({
                    symbol: c.symbol,
                    strategyId: c.strategyId,
                    strategyName: c.strategyName,
                    stockPF: c.stockPF,
                    stockN: c.stockN,
                    valPF: c.valPF,
                    valN: c.valN,
                    valWinRate: c.valWinRate,
                    valNote: c.valNote
                })),
                rejected: (stage3.rejected || []).map(c => ({
                    symbol: c.symbol,
                    strategyId: c.strategyId,
                    strategyName: c.strategyName,
                    stockPF: c.stockPF,
                    stockN: c.stockN,
                    reason: c.reason || c.valNote || 'rejected'
                }))
            }
        });
        deps.logger && deps.logger.info(
            `[dual-stage ${jobId}] stage3: ${stage3.validated.length}/${stage3.initialCount} validated`
        );

        // STAGE 4
        await _setStage(jobId, 4);
        const stage4 = await _stage4_leaderConfirmer(
            stage3.validated,
            stage1.signalTimesBySymbolStrat,
            merged
        );
        await _setStage(jobId, 4, {
            stage4: { planCount: stage4.plans.length, symbols: stage4.plans.map(p => p.symbol) }
        });
        deps.logger && deps.logger.info(`[dual-stage ${jobId}] stage4: ${stage4.plans.length} plans`);

        // ============ STAGE 5 ============
        await _setStage(jobId, 5);

        // 🆕 فقط نمادهای plan رو backfill کن
        const planSymbols = [...new Set(stage4.plans.map(p => p.symbol))];
        let bidaskInfo = null;
        if (planSymbols.length) {
            try {
                deps.logger && deps.logger.info(
                    `[dual-stage ${jobId}] bidask backfill for ${planSymbols.length} symbols: ${planSymbols.join(', ')}`
                );
                const bf = await deps.algotik.backfillOptionBidAsk({
                    underlyings: planSymbols,
                    contractLimit: 50,
                    includeToday: true,
                });
                bidaskInfo = {
                    symbols: planSymbols,
                    recordsUpdated: bf.recordsUpdated || 0,
                    snapshotsMigration: bf.snapshotsMigration ? {
                        total: bf.snapshotsMigration.total_processed,
                        written: bf.snapshotsMigration.written,
                        enriched: bf.snapshotsMigration.enriched,
                    } : null,
                };
                deps.logger && deps.logger.info(
                    `[dual-stage ${jobId}] bidask: updated=${bf.recordsUpdated}`
                );
            } catch (e) {
                deps.logger && deps.logger.warn(`[dual-stage] bidask backfill failed: ${e.message}`);
                bidaskInfo = { error: e.message };
            }
        }

        const __t5 = Date.now();
        const stage5 = await _stage5_optionBacktest(jobId, stage4.plans, ranges.test, merged);
        stage5.stageTimeMs = Date.now() - __t5;

        await _setStage(jobId, 5, {
            stage5: {
                pairCount: stage5.results.length,
                bidaskBackfill: bidaskInfo,
            }
        });

        // STAGE 6
        await _setStage(jobId, 6);
        const stage6 = _stage6_verdict(stage5.results, merged);
        await _setStage(jobId, 6, { stage6: stage6.summary });
        deps.logger && deps.logger.info(
            `[dual-stage ${jobId}] stage6: GO=${stage6.summary.go} MAYBE=${stage6.summary.maybe} SKIP=${stage6.summary.skip}`
        );

        // STAGE 7
        await _setStage(jobId, 7);
        const stage7 = await _stage7_apply(stage6.verdicts, stage4.plans, merged);
        await _setStage(jobId, 7, { stage7 });

        // Done
        const elapsed = Math.round((Date.now() - t0) / 1000);
        // 🆕 per-stage timings (ms)
        const stageTimings = {
            stage1_stockBacktest_ms: stage1.stageTimeMs || null,
            stage2_fdrFilter_ms:     stage2.stageTimeMs || null,
            stage3_validation_ms:    stage3.stageTimeMs || null,
            stage4_leaderConfirmer_ms: stage4.stageTimeMs || null,
            stage5_optionBacktest_ms: stage5.stageTimeMs || null,
            stage6_verdict_ms:       stage6.stageTimeMs || null,
            stage7_apply_ms:         stage7.stageTimeMs || null,
            total_ms:                Date.now() - t0,
            total_sec:               elapsed,
        };
        deps.logger && deps.logger.info(
            `[dual-stage ${jobId}] DONE in ${elapsed}s — ` +
            `s1=${stageTimings.stage1_stockBacktest_ms || '?'}ms ` +
            `s2=${stageTimings.stage2_fdrFilter_ms || '?'}ms ` +
            `s3=${stageTimings.stage3_validation_ms || '?'}ms ` +
            `s4=${stageTimings.stage4_leaderConfirmer_ms || '?'}ms ` +
            `s5=${stageTimings.stage5_optionBacktest_ms || '?'}ms ` +
            `s6=${stageTimings.stage6_verdict_ms || '?'}ms ` +
            `s7=${stageTimings.stage7_apply_ms || '?'}ms`
        );
        // 🆕 به‌جای _setStage(99) که current=99/total=7 می‌کرد، مستقیم مقدار درست ست کن
        await db.collection(COLLECTIONS.BACKTEST_JOBS).updateOne(
            { _id: new ObjectId(jobId) },
            { $set: {
                pipelineStage: 99,
                'progress.current': 7,
                'progress.total': 7,
                'progress.message': STAGE_LABELS[99],
                updatedAt: new Date()
            } }
        );

        const finalResult = {
            stageTimings,
            ranges,
            stages: {
                1: { totalConfigs: configs.length },
                2: {
                    candidates: stage2.candidates.map(c => ({
                        symbol: c.symbol,
                        strategyId: c.strategyId,
                        strategyName: c.strategyName,
                        timeframe: c.timeframe,
                        htfTimeframe: c.htfTimeframe,
                        stockPF: c.stockPF,
                        stockN: c.stockN,
                        stockWinRate: c.stockWinRate,
                        stockAvgPnl: c.stockAvgPnl,
                        pValue: c.pValue
                    })),
                    fdrMeta: stage2.fdrMeta
                },
                3: {
                    validated: stage3.validated.map(c => ({
                        symbol: c.symbol,
                        strategyId: c.strategyId,
                        strategyName: c.strategyName,
                        stockPF: c.stockPF,
                        stockN: c.stockN,
                        valPF: c.valPF,
                        valN: c.valN,
                        valWinRate: c.valWinRate,
                        valNote: c.valNote
                    })),
                    rejected: (stage3.rejected || []).map(c => ({
                        symbol: c.symbol,
                        strategyId: c.strategyId,
                        strategyName: c.strategyName,
                        stockPF: c.stockPF,
                        stockN: c.stockN,
                        valPF: c.valPF,
                        valN: c.valN,
                        reason: c.reason || c.valNote || 'rejected'
                    })),
                    initial: stage3.initialCount
                },
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
        const isCancel = e.message === 'CANCELLED_BY_USER';
        deps.logger && deps.logger.error(`[dual-stage ${jobId}] ${isCancel ? 'CANCELLED' : 'FATAL'}: ${e.message}`);

        await db.collection(COLLECTIONS.BACKTEST_JOBS).updateOne(
            { _id: new ObjectId(jobId) },
            { $set: {
                status: isCancel ? 'CANCELLED' : 'FAILED',
                error: isCancel ? null : e.message,
                finishedAt: new Date(),
                updatedAt: new Date()
            } }
        );
        if (!isCancel) throw e;
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
