'use strict';
// ============================================================
// portfolio.js — شبیه‌ساز پرتفولیو (Phase 3 — Step 2)
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
    useDuplicateGuard: true,
    useKelly: true,
    kellyCapPct: 3.0,
    useCorrelation: true,
    corrThreshold: 0.7,
    maxClusterPct: 30,
    useSectors: true,
    maxSectorPct: 40
    // ⚠️ CVaR از sizing حذف شد — فقط گزارش می‌شه
};

// ============================================================
// آمار پایه — robust به type
// ============================================================
function toNum(v) {
    if (v === null || v === undefined) return NaN;
    if (typeof v === 'number') return v;
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : NaN;
}

function computeGlobalStats(trades) {
    const pnls = trades.map(t => toNum(t.pnlPct)).filter(Number.isFinite);
    if (!pnls.length) {
        return { count: 0, winRate: 0, avgWin: 0, avgLoss: 0, halfKelly: 0, cvar95Pct: 0 };
    }

    const wins = pnls.filter(x => x > 0);
    const losses = pnls.filter(x => x <= 0);
    const winRate = wins.length / pnls.length;
    const avgWin = wins.length ? wins.reduce((s, x) => s + x, 0) / wins.length : 0;
    const avgLoss = losses.length ? Math.abs(losses.reduce((s, x) => s + x, 0) / losses.length) : 0;

    // Kelly — robust
    let halfKelly = 0;
    if (avgLoss > 0 && avgWin > 0 && winRate > 0 && winRate < 1) {
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
        avgWin: Math.round(avgWin * 100) / 100,
        avgLoss: Math.round(avgLoss * 100) / 100,
        halfKelly,
        cvar95Pct: cvar
    };
}

// ============================================================
// تعیین effectiveRiskPct
// ============================================================
function computeEffectiveRiskPct(limits, stats) {
    if (!limits.useKelly) return limits.riskPct;

    const kellyPct = stats.halfKelly * 100;   // e.g. 7.0

    // 🆕 اگه Kelly معنی‌دار نیست (≤ 0.5%)، fallback به riskPct کاربر
    if (!Number.isFinite(kellyPct) || kellyPct <= 0.5) {
        return limits.riskPct;
    }

    // Kelly معنی‌دار است → استفاده کن با cap
    return Math.min(limits.riskPct, kellyPct, limits.kellyCapPct);
}

// ============================================================
// Sizing
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

    // پایه از ریسک
    let baseSize = Math.floor(riskAmt / contractValue);
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

    // سقف Cluster
    let byCluster = Infinity;
    if (limits.useCorrelation && ctx.clusterExposure !== null) {
        const maxCluster = capital * (limits.maxClusterPct / 100);
        const remainCluster = Math.max(0, maxCluster - ctx.clusterExposure);
        byCluster = Math.floor(remainCluster / contractValue);
    }

    // سقف Sector
    let bySector = Infinity;
    if (limits.useSectors) {
        const maxSector = capital * (limits.maxSectorPct / 100);
        const remainSector = Math.max(0, maxSector - ctx.sectorExposure);
        bySector = Math.floor(remainSector / contractValue);
    }

    const finalSize = Math.max(0, Math.min(
        baseSize, bySymbol, byTotal, byCash, byCluster, bySector
    ));

    // 🆕 Priority: baseSize اول (چون ریشه‌ی واقعی)، بعد سقف‌ها
    let reason = null;
    if (finalSize === 0) {
        if (baseSize === 0) {
            reason = `سرمایه کافی نیست (risk=${effectiveRiskPct.toFixed(2)}%)`;
        } else if (bySymbol === 0) reason = 'سقف درگیری نماد پر شده';
        else if (byTotal === 0) reason = 'سقف کل درگیری پر شده';
        else if (byCash === 0) reason = 'نقد کافی نیست';
        else if (byCluster === 0) reason = 'سقف خوشه همبسته پر شده';
        else if (bySector === 0) reason = 'سقف صنعت پر شده';
        else reason = 'محدودیت';
    } else if (finalSize < baseSize) {
        const arr = [
            { v: bySymbol, name: 'نماد' },
            { v: byTotal, name: 'کل' },
            { v: byCash, name: 'نقد' },
            { v: byCluster, name: 'خوشه' },
            { v: bySector, name: 'صنعت' }
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
// Cluster / Sector exposure
// ============================================================
function computeClusterExposure(symbol, portfolio, corrMatrix, limits, clusters) {
    if (!limits.useCorrelation) return null;
    if (!corrMatrix || !clusters) return null;
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

    // آمار
    const stats = computeGlobalStats(trades);
    const effectiveRiskPct = computeEffectiveRiskPct(limits, stats);

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

        releaseExpired(portfolio, entryTs);

        // Duplicate guard
        if (limits.useDuplicateGuard && hasOpenForSymbol(portfolio, t.symbol, entryTs)) {
            rejectedTrades.push({
                symbol: t.symbol, strategyId: t.strategyId,
                entryTime: t.entryTime, skipReason: 'duplicate position on symbol'
            });
            const key = 'duplicate';
            rejectionReasons[key] = (rejectionReasons[key] || 0) + 1;
            continue;
        }

        const clusterExposure = computeClusterExposure(
            t.symbol, portfolio, ctx.corrMatrix, limits, clusters
        );
        const sectorExposure = limits.useSectors
            ? computeSectorExposure(t.symbol, portfolio, ctx.sectorMap)
            : 0;

        const sizing = calcPositionSize(t, portfolio, limits, {
            effectiveRiskPct,
            clusterExposure,
            sectorExposure
        });

        if (sizing.size <= 0) {
            rejectedTrades.push({
                symbol: t.symbol, strategyId: t.strategyId,
                entryTime: t.entryTime,
                skipReason: sizing.limitReason || 'حجم صفر',
                baseSize: sizing.baseSize
            });
            // کلید دقیق‌تر
            let key = sizing.limitReason || 'unknown';
            if (key.includes(':')) key = key.split(':')[0].trim();
            if (key.includes('(')) key = key.split('(')[0].trim();
            rejectionReasons[key] = (rejectionReasons[key] || 0) + 1;
            continue;
        }

        // Accept
        const contractValue = (t.optionEntry || 0) * (t.size || 1000);
        const entryValue = contractValue * sizing.size;
        const posReturnPct = toNum(t.pnlPct) || 0;
        const pnlAbs = entryValue * (posReturnPct / 100);

        portfolio.totalExposure += entryValue;
        if (portfolio.totalExposure > peakExposure) peakExposure = portfolio.totalExposure;
        portfolio.exposureBySymbol[t.symbol] = (portfolio.exposureBySymbol[t.symbol] || 0) + entryValue;
        portfolio.openPositions.push({
            symbol: t.symbol, value: entryValue, exitTime: exitTs
        });

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
            positionSize: sizing.size,
            entryValue: Math.round(entryValue),
            pnlPct: posReturnPct,
            pnlAbs: Math.round(pnlAbs),
            equityAfter: equity,
            bindingLimit: sizing.limitReason,
            clusterExposure: clusterExposure || 0,
            sectorExposure
        });

        usedStrategies.add(t.strategyId);
        usedSectors.add(sector);

        equityCurve.push({
            time: exitTs,
            equity: Math.round(equity * 100) / 100
        });
    }

    // آمار
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
            kelly: limits.useKelly
        },
        globalStats: {
            halfKellyPct: Math.round(stats.halfKelly * 10000) / 100,
            cvar95Pct: Math.round(stats.cvar95Pct * 100) / 100,
            effectiveRiskPct: Math.round(effectiveRiskPct * 100) / 100,
            clustersFound: clusters ? clusters.length : 0,
            rawWinRate: Math.round(stats.winRate * 100) / 100,
            rawAvgWin: stats.avgWin,
            rawAvgLoss: stats.avgLoss
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
    computeEffectiveRiskPct,
    DEFAULT_LIMITS
};