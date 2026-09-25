'use strict';
// ============================================================
// sizing.js — Kelly + CVaR + Correlation (Phase 3)
// ============================================================
// این ماژول فعلاً پایه‌ست. استفاده‌ی اصلی در Phase 3 Step 2.
// ============================================================

// ------------------------------------------------------------
// Kelly Fraction
// ------------------------------------------------------------
// f* = (W * R - L) / R   که R = avgWin/avgLoss ratio
// W = winRate (0..1), L = 1-W
function kellyFraction(winRate, avgWin, avgLoss) {
    const W = Math.max(0, Math.min(1, winRate));
    const L = 1 - W;
    const R = avgLoss > 0 ? avgWin / avgLoss : 0;
    if (R <= 0) return 0;
    const kelly = (W * R - L) / R;
    return Math.max(0, Math.min(kelly, 0.5));   // cap 50%
}

// Half-Kelly برای کنسرواتیو بودن
function halfKelly(winRate, avgWin, avgLoss) {
    return kellyFraction(winRate, avgWin, avgLoss) * 0.5;
}

// ------------------------------------------------------------
// CVaR 95% (Conditional VaR)
// میانگین بدترین ۵٪ ضررها
// ------------------------------------------------------------
function cvar95(pnls) {
    if (!pnls || pnls.length < 5) return null;
    const sorted = [...pnls].sort((a, b) => a - b);
    const cutoff = Math.max(1, Math.floor(sorted.length * 0.05));
    const tail = sorted.slice(0, cutoff);
    const mean = tail.reduce((s, x) => s + x, 0) / tail.length;
    return {
        cvar: mean,
        worst: sorted[0],
        cutoffCount: cutoff,
        totalSamples: sorted.length
    };
}

// ------------------------------------------------------------
// Correlation-aware exposure limit
// ------------------------------------------------------------
function correlationLimit(exposureBySymbol, corrMatrix, maxCorrWeightPct, capital) {
    // ساده: مجموع exposure به نمادهای با corr > 0.7 نباید بیشتر از maxCorrWeightPct% سرمایه باشه
    const symbols = Object.keys(exposureBySymbol);
    if (symbols.length < 2) return { ok: true, correlatedClusters: [] };

    const clusters = [];
    const visited = new Set();

    for (const s of symbols) {
        if (visited.has(s)) continue;
        const cluster = [s];
        visited.add(s);
        for (const t of symbols) {
            if (visited.has(t)) continue;
            const corr = (corrMatrix[s] && corrMatrix[s][t]) || 0;
            if (Math.abs(corr) > 0.7) {
                cluster.push(t);
                visited.add(t);
            }
        }
        if (cluster.length > 1) {
            const totalExposure = cluster.reduce((sum, sym) => sum + (exposureBySymbol[sym] || 0), 0);
            const pct = (totalExposure / capital) * 100;
            clusters.push({
                symbols: cluster,
                totalExposure,
                pct: Math.round(pct * 100) / 100,
                ok: pct <= maxCorrWeightPct
            });
        }
    }

    return {
        ok: clusters.every(c => c.ok),
        correlatedClusters: clusters
    };
}

module.exports = {
    kellyFraction,
    halfKelly,
    cvar95,
    correlationLimit
};