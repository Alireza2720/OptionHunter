'use strict';
// ============================================================
// portfolio.service.js — orchestrate شبیه‌سازی پرتفولیو
// ============================================================

const { COLLECTIONS } = require('../config/constants');
const portfolioCore = require('../core/portfolio');
const sizing = require('../core/sizing');
const { getSectorMap } = require('../core/sectors');
const { filterTrades } = require('../core/signal-filter');
const scoreMod = require('../core/signal-score');
const regimeCore = require('../core/regime');

let deps = {
    getDB: null,
    logger: null,
    settings: null,
    correlationService: null,
    analysisService: null,
    signalFilterService: null,
    regimeService: null   // 🆕 Phase 6
};
function init(d) { deps = { ...deps, ...d }; }

async function simulateFromJob(jobId, opts = {}) {
    const db = deps.getDB();
    const minTrades = opts.minTrades || 5;

    const details = await db.collection(COLLECTIONS.BACKTEST_COMPARE_DETAILS)
        .find({ jobId: String(jobId) })
        .toArray();

    const allTrades = [];
    for (const d of details) {
        if (!d.trades || d.trades.length < minTrades) continue;
        for (const t of d.trades) {
            allTrades.push({
                ...t,
                symbol: d.symbol,
                strategyId: d.strategyId,
                strategyName: d.strategyName
            });
        }
    }

    if (!allTrades.length) {
        return { error: 'هیچ معامله‌ی معتبری برای شبیه‌سازی نیست', jobId };
    }

    // 🆕 Phase 3.5: Signal Quality Filter
    let filterReport = { applied: false };
    let filteredTrades = allTrades;
    if (opts.useSignalFilter !== false && deps.analysisService) {
        try {
            const analysis = await deps.analysisService.analyzeJob(jobId, { minTrades, iterations: 2000 });
            const fr = filterTrades(allTrades, analysis, {
                mode: opts.filterMode || 'pair',
                minPairPF: opts.minPairPF || 2.0,
                minPairTrades: opts.minPairTrades || 5,
                minPairLB: opts.minPairLB || 1.0,
                minStrategyPF: opts.minStrategyPF || 1.3,
                minStrategyTrades: opts.minStrategyTrades || 5
            });
            filteredTrades = fr.trades;
            filterReport = fr.filter;
            if (fr.filter.applied) {
                deps.logger && deps.logger.info(
                    `signal filter: ${fr.filter.keptCount} / ${fr.filter.originalCount} kept`
                );

                // 🆕 whitelist رو برای مسیر زنده ذخیره کن
                if (deps.signalFilterService && fr.filter.allowedPairs) {
                    try {
                        const db2 = deps.getDB();
                        await db2.collection('meta').updateOne(
                            { _id: 'signal_whitelist' },
                            { $set: {
                                jobId: String(jobId),
                                pairs: fr.filter.allowedPairs,
                                strategies: fr.filter.allowedStrategies,
                                symbols: fr.filter.allowedSymbols,
                                filterMode: opts.filterMode || 'pair',
                                computedAt: new Date(),
                                stats: {
                                    totalPairs: fr.filter.originalCount,
                                    allowedPairs: fr.filter.allowedPairs.length
                                }
                            }},
                            { upsert: true }
                        );
                        deps.logger.info(`signal whitelist saved: ${fr.filter.allowedPairs.length} pairs`);
                    } catch (e) {
                        deps.logger.warn('save whitelist: ' + e.message);
                    }
                }
            }
        } catch (e) {
            deps.logger && deps.logger.warn('signal filter: ' + e.message);
        }
    }

    // 🆕 Correlation matrix
    let corrMatrix = null;
    if (opts.useCorrelation !== false) {
        const cached = await deps.correlationService.getCached();
        if (cached && cached.matrix) {
            corrMatrix = cached.matrix;
        } else {
            deps.logger && deps.logger.info('no correlation cache — computing now...');
            await deps.correlationService.computeAndStore(30);
            const fresh = await deps.correlationService.getCached();
            if (fresh && fresh.matrix) corrMatrix = fresh.matrix;
        }
    }

    // 🆕 Sector map
    const symbols = [...new Set(allTrades.map(t => t.symbol))];
    const sectorMap = getSectorMap(symbols);

    // 🆕 Regime map (Phase 6)
    const regimeMap = {};
    if (opts.useRegime !== false && deps.regimeService) {
        try {
            const regimes = await deps.regimeService.getAllCached();
            for (const r of regimes) {
                regimeMap[r.symbol] = { macro: r.macro, vol: r.vol };
            }
            deps.logger && deps.logger.info(`regime map: ${Object.keys(regimeMap).length} symbols`);
        } catch (e) {
            deps.logger && deps.logger.warn('regime map: ' + e.message);
        }
    }

    // 🆕 Compute signal score per trade (Phase 4)
    let scoreStats = { computed: 0, failed: 0, avg: 0 };
    if (opts.useSignalScore !== false) {
        let sumScore = 0;
        for (const t of filteredTrades) {
            try {
                const sc = scoreMod.computeHistoricalScore(t, regimeMap[t.symbol]);
                t.signalScore = sc.score;
                sumScore += sc.score;
                scoreStats.computed++;
            } catch (e) {
                t.signalScore = 0.5;   // fallback: neutrال
                scoreStats.failed++;
            }
        }
        scoreStats.avg = filteredTrades.length ? Math.round(sumScore / filteredTrades.length * 1000) / 1000 : 0;
        deps.logger && deps.logger.info(
            `signal scores: ${scoreStats.computed} computed, ${scoreStats.failed} failed, avg=${scoreStats.avg}`
        );
    }

    // Limits
    const limits = {
        capital: opts.capital || 100_000_000,
        riskPct: opts.riskPct || 1.5,
        maxSymPct: opts.maxSymPct || 20,
        maxTotalPct: opts.maxTotalPct || 50,
        minCashPct: opts.minCashPct || 20,
        maxPositionSize: opts.maxPositionSize || 10,
        // Step 2
        useDuplicateGuard: opts.useDuplicateGuard !== false,
        useKelly: opts.useKelly !== false,
        kellyCapPct: opts.kellyCapPct || 3.0,
        useCorrelation: opts.useCorrelation !== false,
        corrThreshold: opts.corrThreshold || 0.7,
        maxClusterPct: opts.maxClusterPct || 30,
        useSectors: opts.useSectors !== false,
        maxSectorPct: opts.maxSectorPct || 40,
        // 🆕 Phase 4 + 6
        useRegime: opts.useRegime !== false,
        useSignalScore: opts.useSignalScore !== false,
        useSignalFilter: opts.useSignalFilter !== false,
        // Filter
        minTrades: minTrades
    };

    const result = portfolioCore.simulate(filteredTrades, limits, {
        corrMatrix,
        sectorMap,
        regimeMap   // 🆕 Phase 6
    });

    // Advanced
    const pnls = result.trades.map(t => t.pnlPct);
    const cvar = sizing.cvar95(pnls);

    return {
        jobId,
        at: new Date(),
        limits,
        corrMatrixMeta: corrMatrix
            ? { symbols: Object.keys(corrMatrix).length }
            : null,
        sectorMap,
        regimeMapSize: Object.keys(regimeMap).length,
        signalFilter: filterReport,
        scoreStats,   // 🆕
        ...result,
        advanced: {
            cvar95: cvar,
            kellyFraction: result.globalStats.halfKellyPct / 100 * 2,
            halfKelly: result.globalStats.halfKellyPct / 100,
            effectiveRiskPct: result.globalStats.effectiveRiskPct
        }
    };
}

module.exports = { init, simulateFromJob };