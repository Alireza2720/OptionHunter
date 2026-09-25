'use strict';
// ============================================================
// portfolio.js — شبیه‌ساز پرتفولیو (Phase 3 — Step 2)
// ============================================================
// Features:
//  2.1 Duplicate guard (یک پوزیشن همزمان per symbol)
//  2.2 Correlation matrix integration
//  2.3 Cluster limits
//  2.4 Sector limits
//  2.5 Kelly sizing
//  2.6 CVaR constraint
// ============================================================

const { findClusters } = require('./correlation');
const { getSector } = require('./sectors');

const DEFAULT_LIMITS = {
    capital: 100_000_000,
    riskPct: 1.5,
    maxSymPct: 20,
    maxTotalPct: 50,
    minCashPct: 20,
    maxPositionSize: 10,
    // Step 2 additions
    useDuplicateGuard: true,
    useKelly: true,
    kellyCapPct: 3.0,
    useCorrelation: true,
    corrThreshold: 0.7,
    maxClusterPct: 30,
    useSectors: true,
    maxSectorPct: 40,
    useCVaR: true,
    cvarBudgetPct: 1.0
};

// ============================================================
// آمار پایه
// ============================================================
function computeGlobalStats(trades) {
    const pnls = trades.map(t => t.pnlPct).filter(Number.isFinite);
    const wins = pnls.filter(x => x > 0);
    const losses = pnls.filter(x => x <= 0);
    const winRate = pnls.length ? wins.length / pnls.length : 0;
    const avgWin = wins.length ? wins.reduce((s, x) => s + x, 0) / wins.length : 0;
    const avgLoss = losses.length ? Math.abs(losses.reduce((s, x) => s + x, 0) / losses.length) : 0;

    // Kelly
    let halfKelly = 0;
    if (avgLoss > 0) {
        const R = avgWin / avgLoss;
        const kelly = (winRate * R - (1 - winRate)) / R;
        halfKelly = Math.max(0, Math.min(kelly * 0.5, 0.15));
    }

    // CVaR 95%
    const sorted = [...pnls].sort((a, b) => a - b);
    const cutoff = Math.max(1, Math.floor(sorted.length * 0.05));
    const tail = sorted.slice(0, cutoff);
    const cvar = tail.length ? tail.reduce((s, x) => s + x, 0) / tail.length : 0;

    return {
        count: pnls.length,
        winRate: winRate * 100,
        avgWin, avgLoss,
        halfKelly,
        cvar95Pct: cvar
    };
}

// ============================================================
// Sizing با همه محدودیت‌ها
// ============================================================
function calcPositionSize(trade, portfolio, limits, ctx) {
    const capital = limits.capital;
    const effectiveRiskPct = ctx.effectiveRiskPct;
    const riskAmt = capital * (effectiveRiskPct / 100);
    const maxSym = capital * (limits.maxSymPct / 100);
    const maxTotal = capital * (limits.maxTotalPct / 100);

    const contractValue = (trade.optionEntry || 0) * (trade.size || 1000);
    if (!(contractValue > 0)) {
        return { size: 0, reason: 'قیمت قرارداد نامعتبر' };
    }

    // پایه: از ریسک
    let baseSize = Math.floor(riskAmt / contractValue);

    // سقف تعداد
    baseSize = Math.min(baseSize, limits.maxPositionSize);

    // سقف نماد
    const curSym = portfolio.exposureBySymbol[trade.symbol] || 0;
    const remainSym = Math.max(0, maxSym - curSym);
    const bySymbol = Math.floor(remainSym / contractValue);

    // سقف کل
    const remainTotal = Math.max(0, maxTotal - portfolio.totalExposure);
    const byTotal = Math.floor(remainTotal / contractValue);

    // سقف نقد
    const availableCash = capital - portfolio.totalExposure;
    const byCash = Math.floor(availableCash / contractValue);

    // 🆕 سقف Cluster
    let byCluster = Infinity;
    if (limits.useCorrelation && ctx.clusterExposure !== null) {
        const maxCluster = capital * (limits.maxClusterPct / 100);
        const remainCluster = Math.max(0, maxCluster - ctx.clusterExposure);
        byCluster = Math.floor(remainCluster / contractValue);
    }

    // 🆕 سقف Sector
    let bySector = Infinity;
    if (limits.useSectors) {
        const maxSector = capital * (limits.maxSectorPct / 100);
        const remainSector = Math.max(0, maxSector - ctx.sectorExposure);
        bySector = Math.floor(remainSector / contractValue);
    }

    // 🆕 سقف CVaR
    let byCVaR = Infinity;
    if (limits.useCVaR && ctx.cvar95Pct < 0) {
        const cvarFrac = Math.abs(ctx.cvar95Pct) / 100;   // e.g. 0.71
        if (cvarFrac > 0) {
            const budget = capital * (limits.cvarBudgetPct / 100);
            const maxLossPerContract = contractValue * cvarFrac;
            byCVaR = Math.max(0, Math.floor(budget / maxLossPerContract));
        }
    }

    const finalSize = Math.max(0, Math.min(
        baseSize, bySymbol, byTotal, byCash, byCluster, bySector, byCVaR
    ));

    let reason = null;
    if (finalSize === 0) {
        if (bySymbol === 0) reason = 'سقف درگیری نماد پر شده';
        else if (byTotal === 0) reason = 'سقف کل درگیری پر شده';
        else if (byCash === 0) reason = 'نقد کافی نیست';
        else if (byCluster === 0) reason = 'سقف خوشه همبسته پر شده';
        else if (bySector === 0) reason = 'سقف صنعت پر شده';
        else if (byCVaR === 0) reason = 'بودجه‌ی CVaR تمام شده';
        else if (baseSize === 0) reason = 'سرمایه برای این قرارداد کافی نیست';
        else reason = 'محدودیت';
    } else if (finalSize < baseSize) {
        // کدوم محدودیت binding شد؟
        const arr = [
            { v: bySymbol, name: 'نماد' },
            { v: byTotal, name: 'کل' },
            { v: byCash, name: 'نقد' },
            { v: byCluster, name: 'خوشه' },
            { v: bySector, name: 'صنعت' },
            { v: byCVaR, name: 'CVaR' }
        ];
        const min = Math.min(...arr.map(a => a.v));
        const bound = arr.find(a => a.v === min);
        reason = `binding: ${bound.name}`;
    }

    return {
        size: finalSize,
        baseSize,
        bySymbol, byTotal, byCash,
        byCluster: Number.isFinite(byCluster) ? byCluster : null,
        bySector: Number.isFinite(bySector) ? bySector : null,
        byCVaR: Number.isFinite(byCVaR) ? byCVaR : null,
        limitReason: reason
    };
}

// ============================================================
// Duplicate guard
// ============================================================
function hasOpenForSymbol(portfolio, symbol, entryTs) {
    return portfolio.openPositions.some(p =>
        p.symbol === symbol && p.exitTime > entryTs
    );
}

function releaseExpired(portfolio, nowTs) {
    const stillOpen = [];
    for (const p of portfolio.openPositions) {
        if (p.exitTime <= nowTs) {
            portfolio.totalExposure -= p.value;
            portfolio.exposureBySymbol[p.symbol] =
                Math.max(0, (portfolio.exposureBySymbol[p.symbol] || 0) - p.value);
        } else {
            stillOpen.push(p);
        }
    }
    portfolio.openPositions = stillOpen;
}

// ============================================================
// Cluster exposure
// ============================================================
function computeClusterExposure(symbol, portfolio, corrMatrix, limits, clusters) {
    if (!limits.useCorrelation) return null;
    if (!corrMatrix || !clusters) return null;

    // پیدا کردن cluster حاوی symbol
    const cluster = clusters.find(c => c.includes(symbol));
    if (!cluster) return null;

    let total = 0;
    for (const sym of cluster) {
        total += portfolio.exposureBySymbol[sym] || 0;
    }
    return total;
}

function computeSectorExposure(symbol, portfolio, sectorMap) {
    if (!sectorMap) return 0;
    const targetSector = sectorMap[symbol] || getSector(symbol);
    let total = 0;
    for (const [sym, exp] of Object.entries(portfolio.exposureBySymbol)) {
        const sec = sectorMap[sym] || getSector(sym);
        if (sec === targetSector) total += exp;
    }
    return total;
}

// ============================================================
// Simulation
// ============================================================
function simulate(trades, limitsInput = {}, ctx = {}) {
    const limits = { ...DEFAULT_LIMITS, ...limitsInput };
    const capital = limits.capital;
    const minCash = capital * (limits.minCashPct / 100);

    // آمار برای Kelly/CVaR
    const stats = computeGlobalStats(trades);
    const effectiveRiskPct = limits.useKelly
        ? Math.min(limits.riskPct, stats.halfKelly * 100 * (limits.kellyCapPct / 100) * 100 / 100)
        : limits.riskPct;

    // اصلاح ساده‌تر: cap = min(riskPct, halfKelly*100, kellyCapPct)
    const kellyPct = stats.halfKelly * 100;
    const finalRiskPct = limits.useKelly
        ? Math.min(limits.riskPct, kellyPct, limits.kellyCapPct)
        : limits.riskPct;

    // Clusters
    const clusters = (limits.useCorrelation && ctx.corrMatrix)
        ? findClusters(ctx.corrMatrix, limits.corrThreshold)
        : null;

    // Sort
    const sorted = [...trades].sort((a, b) => {
        const ta = a.entryFillTime || a.entryTime || 0;
        const tb = b.entryFillTime || b.entryTime || 0;
        return ta - tb;
    });

    // State
    const portfolio = {
        totalExposure: 0,
        exposureBySymbol: {},
        openPositions: []
    };
    let peakExposure = 0;

    // Outputs
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

    // Stats tracking
    const usedStrategies = new Set();
    const usedSectors = new Set();

    for (const t of sorted) {
        const entryTs = t.entryFillTime || t.entryTime || 0;
        const exitTs = t.exitFillTime || t.exitTime || (entryTs + 3600);

        // 1. آزادسازی پوزیشن‌های منقضی
        releaseExpired(portfolio, entryTs);

        // 2. Duplicate guard
        if (limits.useDuplicateGuard && hasOpenForSymbol(portfolio, t.symbol, entryTs)) {
            rejectedTrades.push({
                symbol: t.symbol,
                strategyId: t.strategyId,
                entryTime: t.entryTime,
                skipReason: 'duplicate position on symbol'
            });
            rejectionReasons['duplicate'] = (rejectionReasons['duplicate'] || 0) + 1;
            continue;
        }

        // 3. Cluster / Sector exposure
        const clusterExposure = computeClusterExposure(
            t.symbol, portfolio, ctx.corrMatrix, limits, clusters
        );
        const sectorExposure = limits.useSectors
            ? computeSectorExposure(t.symbol, portfolio, ctx.sectorMap)
            : 0;

        // 4. Sizing
        const sizing = calcPositionSize(t, portfolio, limits, {
            effectiveRiskPct: finalRiskPct,
            clusterExposure,
            sectorExposure,
            cvar95Pct: stats.cvar95Pct
        });

        if (sizing.size <= 0) {
            rejectedTrades.push({
                symbol: t.symbol,
                strategyId: t.strategyId,
                entryTime: t.entryTime,
                skipReason: sizing.limitReason || 'حجم صفر',
                baseSize: sizing.baseSize
            });
            const key = (sizing.limitReason || 'unknown').split(':')[0];
            rejectionReasons[key] = (rejectionReasons[key] || 0) + 1;
            continue;
        }

        // 5. Accept trade
        const contractValue = (t.optionEntry || 0) * (t.size || 1000);
        const entryValue = contractValue * sizing.size;
        const posReturnPct = t.pnlPct || 0;
        const pnlAbs = entryValue * (posReturnPct / 100);

        portfolio.totalExposure += entryValue;
        if (portfolio.totalExposure > peakExposure) peakExposure = portfolio.totalExposure;
        portfolio.exposureBySymbol[t.symbol] = (portfolio.exposureBySymbol[t.symbol] || 0) + entryValue;
        portfolio.openPositions.push({
            symbol: t.symbol,
            value: entryValue,
            exitTime: exitTs
        });

        // Equity
        const pnlPctOfCapital = (entryValue / capital) * (posReturnPct / 100);
        equity *= (1 + pnlPctOfCapital);
        if (equity > peakEquity) peakEquity = equity;
        const dd = ((peakEquity - equity) / peakEquity) * 100;
        if (dd > maxDD) maxDD = dd;

        acceptedTrades.push({
            symbol: t.symbol,
            strategyId: t.strategyId,
            strategyName: t.strategyName,
            sector: ctx.sectorMap ? (ctx.sectorMap[t.symbol] || getSector(t.symbol)) : getSector(t.symbol),
            entryTime: t.entryTime,
            exitTime: t.exitTime,
            positionSize: sizing.size,
            entryValue: Math.round(entryValue),
            pnlPct: posReturnPct,
            pnlAbs: Math.round(pnlAbs),
            equityAfter: equity,
            bindingLimit: sizing.limitReason,
            clusterExposure: clusterExposure || 0,
            sectorExposure: sectorExposure
        });

        usedStrategies.add(t.strategyId);
        usedSectors.add(ctx.sectorMap ? (ctx.sectorMap[t.symbol] || getSector(t.symbol)) : getSector(t.symbol));

        equityCurve.push({
            time: exitTs,
            equity: Math.round(equity * 100) / 100
        });
    }

    // آمار نهایی
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
            cvar: limits.useCVaR
        },
        globalStats: {
            halfKellyPct: Math.round(stats.halfKelly * 10000) / 100,
            cvar95Pct: Math.round(stats.cvar95Pct * 100) / 100,
            effectiveRiskPct: Math.round(finalRiskPct * 100) / 100,
            clustersFound: clusters ? clusters.length : 0
        },
        clusterSummary: clusters ? clusters.map(c => ({
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
    calcPositionSize,
    computeGlobalStats,
    DEFAULT_LIMITS
};