'use strict';
// ============================================================
// execution-guard.js — منطق مشترک اجرای معاملات
// ============================================================
// هم بک‌تست و هم مسیر واقعی از این ماژول استفاده می‌کنند.
// تضمین: هر محدودیتی که در بک‌تست اعمال می‌شود، در واقعیت هم فعال است.
//
// Pure — بدون DB, بدون HTTP. فقط state می‌گیرد و تصمیم می‌دهد.
// ============================================================

const { findClusters } = require('./correlation');
const { getSector } = require('./sectors');
const regimeCore = require('./regime');
const scoreMod = require('./signal-score');

// ============================================================
// پیش‌فرض‌ها
// ============================================================
const DEFAULT_LIMITS = {
    capital: 100_000_000,
    riskPct: 1.5,
    maxSymPct: 20,
    maxTotalPct: 50,
    minCashPct: 20,
    maxPositionSize: 10,

    // Step 2
    useDuplicateGuard: true,
    useKelly: true,
    kellyCapPct: 3.0,
    useCorrelation: true,
    corrThreshold: 0.7,
    maxClusterPct: 30,
    useSectors: true,
    maxSectorPct: 40,

    // Phase 3.5
    useSignalFilter: true,
    signalWhitelist: null,

    // Phase 4 + 6
    useRegime: true,
    useSignalScore: true
};

// ============================================================
// آمار پایه — برای Kelly / CVaR
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

    let halfKelly = 0;
    if (avgLoss > 0 && avgWin > 0 && winRate > 0 && winRate < 1) {
        const R = avgWin / avgLoss;
        const kelly = (winRate * R - (1 - winRate)) / R;
        halfKelly = Math.max(0, Math.min(kelly * 0.5, 0.15));
    }

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

function computeEffectiveRiskPct(limits, stats) {
    if (!limits.useKelly) return limits.riskPct;
    const kellyPct = stats.halfKelly * 100;
    if (!Number.isFinite(kellyPct) || kellyPct <= 0.5) {
        return limits.riskPct;   // fallback
    }
    return Math.min(limits.riskPct, kellyPct, limits.kellyCapPct);
}

// ============================================================
// Duplicate guard
// ============================================================
function hasOpenForSymbol(portfolio, symbol, entryTs) {
    if (!portfolio.openPositions) return false;
    return portfolio.openPositions.some(p =>
        p.symbol === symbol && p.exitTime > entryTs
    );
}

function releaseExpired(portfolio, nowTs) {
    if (!portfolio.openPositions) return;
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
// Exposure helpers
// ============================================================
function computeClusterExposure(symbol, portfolio, corrMatrix, limits, clusters) {
    if (!limits.useCorrelation) return null;
    if (!corrMatrix || !clusters) return null;
    const cluster = clusters.find(c => c.includes(symbol));
    if (!cluster) return null;
    let total = 0;
    for (const sym of cluster) total += portfolio.exposureBySymbol[sym] || 0;
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
// Sizing
// ============================================================
function calcPositionSize(candidate, portfolio, limits, ctx) {
    const capital = limits.capital;
    const effectiveRiskPct = ctx.effectiveRiskPct;
    const riskAmt = capital * (effectiveRiskPct / 100);
    const maxSym = capital * (limits.maxSymPct / 100);
    const maxTotal = capital * (limits.maxTotalPct / 100);

    const contractValue = (candidate.optionEntry || 0) * (candidate.size || 1000);
    if (!(contractValue > 0)) {
        return { size: 0, reason: 'قیمت قرارداد نامعتبر' };
    }

    let baseSize = Math.floor(riskAmt / contractValue);
    baseSize = Math.min(baseSize, limits.maxPositionSize);

    // 🆕 Soft multipliers (regime + score)
    if (ctx.combinedFactor && ctx.combinedFactor !== 1.0) {
        baseSize = Math.floor(baseSize * ctx.combinedFactor);
    }

    const curSym = portfolio.exposureBySymbol[candidate.symbol] || 0;
    const remainSym = Math.max(0, maxSym - curSym);
    const bySymbol = Math.floor(remainSym / contractValue);

    const remainTotal = Math.max(0, maxTotal - portfolio.totalExposure);
    const byTotal = Math.floor(remainTotal / contractValue);

    const availableCash = capital - portfolio.totalExposure;
    const byCash = Math.floor(availableCash / contractValue);

    let byCluster = Infinity;
    if (limits.useCorrelation && ctx.clusterExposure !== null && ctx.clusterExposure !== undefined) {
        const maxCluster = capital * (limits.maxClusterPct / 100);
        const remainCluster = Math.max(0, maxCluster - ctx.clusterExposure);
        byCluster = Math.floor(remainCluster / contractValue);
    }

    let bySector = Infinity;
    if (limits.useSectors && ctx.sectorExposure !== undefined) {
        const maxSector = capital * (limits.maxSectorPct / 100);
        const remainSector = Math.max(0, maxSector - ctx.sectorExposure);
        bySector = Math.floor(remainSector / contractValue);
    }

    const finalSize = Math.max(0, Math.min(
        baseSize, bySymbol, byTotal, byCash, byCluster, bySector
    ));

    let reason = null;
    if (finalSize === 0) {
        if (baseSize === 0) reason = `سرمایه کافی نیست (risk=${effectiveRiskPct.toFixed(2)}%)`;
        else if (bySymbol === 0) reason = 'سقف درگیری نماد پر شده';
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
        limitReason: reason,
        contractValue
    };
}

// ============================================================
// 🎯 MAIN: canOpen — تصمیم نهایی
// ============================================================
/**
 * @param {Object} candidate — { symbol, strategyId, optionEntry, size }
 * @param {Object} portfolio — { totalExposure, exposureBySymbol, openPositions }
 * @param {Object} limits — settings
 * @param {Object} ctx — { corrMatrix, clusters, sectorMap, effectiveRiskPct, globalStats }
 * @returns {Object} { allowed, size, reason, violations, sizing }
 */
function canOpen(candidate, portfolio, limits, ctx) {
    const violations = [];
    const entryTs = candidate.entryTime || Math.floor(Date.now() / 1000);

    // 1) Signal filter (whitelist)
    if (limits.useSignalFilter && limits.signalWhitelist instanceof Set) {
        const key = `${candidate.symbol}::${candidate.strategyId}`;
        if (!limits.signalWhitelist.has(key)) {
            violations.push({
                rule: 'signalWhitelist',
                message: `pair ${key} در whitelist نیست`
            });
        }
    }

    // 2) Duplicate guard
    if (limits.useDuplicateGuard && hasOpenForSymbol(portfolio, candidate.symbol, entryTs)) {
        violations.push({
            rule: 'duplicate',
            message: `پوزیشن باز روی ${candidate.symbol} وجود دارد`
        });
    }

    // اگه violation اساسی داریم → reject فوری (size=0)
    if (violations.some(v => v.rule === 'signalWhitelist' || v.rule === 'duplicate')) {
        return {
            allowed: false,
            size: 0,
            reason: violations[0].message,
            violations,
            sizing: null
        };
    }

    // 🆕 Regime check (soft — فقط خیلی خطرناک رو رد می‌کنه)
    let regimeFactor = 1.0;
    let regimeReason = 'ok';
    if (limits.useRegime && ctx.regimeMap) {
        const r = ctx.regimeMap[candidate.symbol];
        if (r && r.macro && r.macro !== 'unknown') {
            const rf = regimeCore.regimeSizeFactor(candidate.strategyId, r.macro, r.vol);
            regimeFactor = rf.factor;
            regimeReason = rf.reason;
            if (regimeFactor === 0) {
                return {
                    allowed: false,
                    size: 0,
                    reason: `Regime خطرناک: ${rf.reason}`,
                    violations: [...violations, { rule: 'regime', message: rf.reason }],
                    sizing: null
                };
            }
        }
    }

    // 🆕 Signal score check (soft)
    let scoreFactor = 1.0;
    let scoreReason = 'ok';
    if (limits.useSignalScore && candidate.signalScore !== undefined && candidate.signalScore !== null) {
        scoreFactor = scoreMod.scoreToSizeFactor(candidate.signalScore);
        scoreReason = `score=${candidate.signalScore.toFixed(2)} → ${scoreFactor}×`;
    }

    // 3) محاسبه‌ی cluster/sector exposure
    const clusterExposure = computeClusterExposure(
        candidate.symbol, portfolio, ctx.corrMatrix, limits, ctx.clusters
    );
    const sectorExposure = limits.useSectors
        ? computeSectorExposure(candidate.symbol, portfolio, ctx.sectorMap)
        : 0;

    // 4) Sizing — همه‌ی سقف‌ها
    const combinedFactor = regimeFactor * scoreFactor;
    const sizing = calcPositionSize(candidate, portfolio, limits, {
        effectiveRiskPct: ctx.effectiveRiskPct,
        clusterExposure,
        sectorExposure,
        combinedFactor
    });

    if (sizing.size <= 0) {
        return {
            allowed: false,
            size: 0,
            reason: sizing.limitReason || 'حجم صفر',
            violations: [...violations, {
                rule: 'sizing',
                message: sizing.limitReason || 'حجم صفر'
            }],
            sizing,
            clusterExposure,
            sectorExposure
        };
    }

    // 5) مجاز
    return {
        allowed: true,
        size: sizing.size,
        reason: sizing.limitReason || 'ok',
        violations,
        sizing,
        clusterExposure,
        sectorExposure,
        effectiveRiskPct: ctx.effectiveRiskPct,
        regimeFactor,
        regimeReason,
        scoreFactor,
        scoreReason,
        combinedFactor
    };
}

// ============================================================
// آماده‌سازی context مشترک
// ============================================================
function buildContext(limits, allTradesOrStats, opts = {}) {
    // آمار
    const stats = opts.stats || computeGlobalStats(allTradesOrStats || []);
    const effectiveRiskPct = computeEffectiveRiskPct(limits, stats);

    // clusters از corr matrix
    let clusters = null;
    if (limits.useCorrelation && opts.corrMatrix) {
        clusters = opts.clusters || findClusters(opts.corrMatrix, limits.corrThreshold);
    }

    return {
        stats,
        effectiveRiskPct,
        clusters,
        corrMatrix: opts.corrMatrix || null,
        sectorMap: opts.sectorMap || null
    };
}

// ============================================================
// Portfolio state کمکی
// ============================================================
function emptyPortfolio() {
    return {
        totalExposure: 0,
        exposureBySymbol: {},
        openPositions: []
    };
}

function addPosition(portfolio, symbol, value, exitTime) {
    portfolio.totalExposure += value;
    portfolio.exposureBySymbol[symbol] = (portfolio.exposureBySymbol[symbol] || 0) + value;
    portfolio.openPositions.push({ symbol, value, exitTime });
}

function removePosition(portfolio, symbol, value) {
    portfolio.totalExposure -= value;
    portfolio.exposureBySymbol[symbol] = Math.max(0, (portfolio.exposureBySymbol[symbol] || 0) - value);
}

module.exports = {
    // main
    canOpen,
    buildContext,
    // sizing
    calcPositionSize,
    computeGlobalStats,
    computeEffectiveRiskPct,
    // state
    emptyPortfolio,
    addPosition,
    removePosition,
    // helpers
    hasOpenForSymbol,
    releaseExpired,
    computeClusterExposure,
    computeSectorExposure,
    // constants
    DEFAULT_LIMITS
};