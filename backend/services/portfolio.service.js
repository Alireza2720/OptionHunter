'use strict';
// ============================================================
// portfolio.service.js — orchestrate شبیه‌سازی پرتفولیو
// ============================================================

const { COLLECTIONS } = require('../config/constants');
const portfolioCore = require('../core/portfolio');
const sizing = require('../core/sizing');
const { getSectorMap } = require('../core/sectors');

let deps = {
    getDB: null,
    logger: null,
    settings: null,
    correlationService: null
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
        useCVaR: opts.useCVaR !== false,
        cvarBudgetPct: opts.cvarBudgetPct || 1.0
    };

    const result = portfolioCore.simulate(allTrades, limits, {
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
        ...result,
        advanced: {
            cvar95: cvar,
            kellyFraction: result.globalStats.halfKellyPct / 100 * 2,   // نمایش کامل kelly
            halfKelly: result.globalStats.halfKellyPct / 100
        }
    };
}

module.exports = { init, simulateFromJob };