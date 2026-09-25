'use strict';
// ============================================================
// portfolio.js — شبیه‌ساز پرتفولیو (Phase 3)
// ============================================================
// حالا از execution-guard مشترک استفاده می‌کند.
// ============================================================

const guard = require('./execution-guard');
const { getSector } = require('./sectors');

function toNum(v) {
    if (v === null || v === undefined) return NaN;
    if (typeof v === 'number') return v;
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : NaN;
}

function simulate(trades, limitsInput = {}, ctxInput = {}) {
    const limits = { ...guard.DEFAULT_LIMITS, ...limitsInput };
    const capital = limits.capital;

    // Context (stats + clusters + effectiveRiskPct)
    const ctx = guard.buildContext(limits, trades, {
        corrMatrix: ctxInput.corrMatrix,
        sectorMap: ctxInput.sectorMap
    });

    // Sort
    const sorted = [...trades].sort((a, b) => {
        const ta = a.entryFillTime || a.entryTime || 0;
        const tb = b.entryFillTime || b.entryTime || 0;
        return ta - tb;
    });

    // State
    const portfolio = guard.emptyPortfolio();
    let peakExposure = 0;

    const acceptedTrades = [];
    const rejectedTrades = [];
    const rejectionReasons = {};

    let equity = 100;
    let peakEquity = 100;
    let maxDD = 0;
    const equityCurve = [{
        time: sorted.length ? (sorted[0].entryFillTime || sorted[0].entryTime) : 0,
        equity: 100
    }];

    const usedStrategies = new Set();
    const usedSectors = new Set();

    for (const t of sorted) {
        const entryTs = t.entryFillTime || t.entryTime || 0;
        const exitTs = t.exitFillTime || t.exitTime || (entryTs + 3600);

        // آزادسازی پوزیشن‌های منقضی
        guard.releaseExpired(portfolio, entryTs);

        // ساخت candidate
        const candidate = {
            symbol: t.symbol,
            strategyId: t.strategyId,
            strategyName: t.strategyName,
            optionEntry: t.optionEntry,
            size: t.size,
            entryTime: entryTs,
            pnlPct: t.pnlPct
        };

        // تصمیم
        const decision = guard.canOpen(candidate, portfolio, limits, ctx);

        if (!decision.allowed) {
            rejectedTrades.push({
                symbol: t.symbol,
                strategyId: t.strategyId,
                entryTime: t.entryTime,
                skipReason: decision.reason,
                violations: decision.violations
            });
            let key = decision.reason || 'unknown';
            if (key.includes(':')) key = key.split(':')[0].trim();
            if (key.includes('(')) key = key.split('(')[0].trim();
            rejectionReasons[key] = (rejectionReasons[key] || 0) + 1;
            continue;
        }

        // Accept
        const entryValue = decision.sizing.contractValue * decision.size;
        const posReturnPct = toNum(t.pnlPct) || 0;
        const pnlAbs = entryValue * (posReturnPct / 100);

        guard.addPosition(portfolio, t.symbol, entryValue, exitTs);
        if (portfolio.totalExposure > peakExposure) peakExposure = portfolio.totalExposure;

        // Equity
        const pnlPctOfCapital = (entryValue / capital) * (posReturnPct / 100);
        equity *= (1 + pnlPctOfCapital);
        if (equity > peakEquity) peakEquity = equity;
        const dd = ((peakEquity - equity) / peakEquity) * 100;
        if (dd > maxDD) maxDD = dd;

        const sector = ctx.sectorMap ? (ctx.sectorMap[t.symbol] || getSector(t.symbol)) : getSector(t.symbol);

        acceptedTrades.push({
            symbol: t.symbol,
            strategyId: t.strategyId,
            strategyName: t.strategyName,
            sector,
            entryTime: t.entryTime,
            exitTime: t.exitTime,
            positionSize: decision.size,
            entryValue: Math.round(entryValue),
            pnlPct: posReturnPct,
            pnlAbs: Math.round(pnlAbs),
            equityAfter: equity,
            bindingLimit: decision.sizing.limitReason,
            clusterExposure: decision.clusterExposure || 0,
            sectorExposure: decision.sectorExposure
        });

        usedStrategies.add(t.strategyId);
        usedSectors.add(sector);

        equityCurve.push({
            time: exitTs,
            equity: Math.round(equity * 100) / 100
        });
    }

    // Stats
    const accepted = acceptedTrades;
    const wins = accepted.filter(t => t.pnlPct > 0);
    const losses = accepted.filter(t => t.pnlPct <= 0);
    const gp = wins.reduce((s, t) => s + t.pnlPct, 0);
    const gl = -losses.reduce((s, t) => s + t.pnlPct, 0);
    const pf = gl > 0 ? gp / gl : (gp > 0 ? Infinity : 0);

    const meanRet = accepted.length ? accepted.reduce((s, t) => s + t.pnlPct, 0) / accepted.length : 0;
    const variance = accepted.length > 1
        ? accepted.reduce((s, t) => s + (t.pnlPct - meanRet) ** 2, 0) / (accepted.length - 1)
        : 0;
    const sd = Math.sqrt(variance);
    const sharpe = sd > 0 ? (meanRet / sd) * Math.sqrt(accepted.length) : null;

    return {
        limits,
        featuresUsed: {
            duplicateGuard: limits.useDuplicateGuard,
            correlation: limits.useCorrelation,
            sectors: limits.useSectors,
            kelly: limits.useKelly,
            signalFilter: limits.useSignalFilter
        },
        globalStats: {
            halfKellyPct: Math.round(ctx.stats.halfKelly * 10000) / 100,
            cvar95Pct: Math.round(ctx.stats.cvar95Pct * 100) / 100,
            effectiveRiskPct: Math.round(ctx.effectiveRiskPct * 100) / 100,
            clustersFound: ctx.clusters ? ctx.clusters.length : 0,
            rawWinRate: Math.round(ctx.stats.winRate * 100) / 100,
            rawAvgWin: ctx.stats.avgWin,
            rawAvgLoss: ctx.stats.avgLoss
        },
        clusterSummary: ctx.clusters ? ctx.clusters.map(c => ({
            symbols: c,
            sectors: [...new Set(c.map(s => ctx.sectorMap ? (ctx.sectorMap[s] || getSector(s)) : getSector(s)))]
        })) : [],
        totalTrades: sorted.length,
        acceptedTrades: acceptedTrades.length,
        rejectedTrades: rejectedTrades.length,
        rejectionReasons,
        trades: acceptedTrades,
        rejected: rejectedTrades.slice(0, 100),
        equityCurve,
        stats: {
            finalEquity: Math.round(equity * 100) / 100,
            totalReturnPct: Math.round((equity - 100) * 100) / 100,
            maxDD: Math.round(maxDD * 100) / 100,
            winRate: accepted.length ? Math.round((wins.length / accepted.length * 100) * 100) / 100 : 0,
            profitFactor: pf === Infinity ? null : Math.round(pf * 100) / 100,
            sharpe: sharpe !== null ? Math.round(sharpe * 100) / 100 : null,
            avgReturn: Math.round(meanRet * 100) / 100,
            peakExposure,
            uniqueStrategies: usedStrategies.size,
            uniqueSectors: usedSectors.size
        }
    };
}

module.exports = {
    simulate,
    // برای سازگاری
    calcPositionSize: guard.calcPositionSize,
    computeGlobalStats: guard.computeGlobalStats,
    computeEffectiveRiskPct: guard.computeEffectiveRiskPct,
    DEFAULT_LIMITS: guard.DEFAULT_LIMITS
};