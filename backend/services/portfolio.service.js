'use strict';
// ============================================================
// portfolio.service.js — orchestrate شبیه‌سازی پرتفولیو
// ============================================================

const { COLLECTIONS } = require('../config/constants');
const portfolioCore = require('../core/portfolio');
const sizing = require('../core/sizing');
const { getSectorMap } = require('../core/sectors');
const { filterTrades } = require('../core/signal-filter');

let deps = {
    getDB: null,
    logger: null,
    settings: null,
    correlationService: null,
    analysisService: null   // 🆕
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
            const r = await deps.correlationService.computeAndStore(30);
            const fresh = await deps.correlationService.getCached();
            if (fresh && fresh.matrix) corrMatrix = fresh.matrix;
        }
    }

    // 🆕 Sector map
    const symbols = [...new Set(allTrades.map(t => t.symbol))];
    const sectorMap = getSectorMap(symbols);

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
    };

    const result = portfolioCore.simulate(filteredTrades, limits, {
        corrMatrix,
        sectorMap
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
        signalFilter: filterReport,   // 🆕
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