'use strict';
// ============================================================
// walk-forward.js — Phase 5
// ============================================================
// - تقسیم بازه به پنجره‌های rolling
// - ارزیابی overfit (train vs test)
// - Deflated Sharpe Ratio (Bailey & López de Prado)
// ============================================================

function buildWindows(totalDays, numWindows = 4, trainPct = 0.7) {
    if (totalDays < 30) return [];
    const windows = [];
    const testSize = Math.floor(totalDays / (numWindows + 1));
    const trainSize = Math.floor(testSize * (trainPct / (1 - trainPct)));

    for (let i = 0; i < numWindows; i++) {
        const trainStart = i * testSize;
        const trainEnd = trainStart + trainSize;
        const testStart = trainEnd;
        const testEnd = testStart + testSize;
        if (testEnd > totalDays) break;

        windows.push({
            idx: i + 1,
            trainStart, trainEnd, testStart, testEnd,
            trainDays: trainSize, testDays: testSize
        });
    }
    return windows;
}
// ------------------------------------------------------------
// Aggregate evaluation — چند پنجره‌ی زمانی sequential
// ------------------------------------------------------------
function evaluateAggregate(trades, numWindows = 4, minPerWindow = 5) {
    const sorted = [...trades]
        .filter(t => Number.isFinite(t.pnlPct))
        .sort((a, b) => (a.entryTime || 0) - (b.entryTime || 0));
    const N = sorted.length;

    if (N < numWindows * minPerWindow) {
        // کاهش تعداد windows
        const possible = Math.floor(N / minPerWindow);
        if (possible < 2) {
            return {
                error: `trade کم (${N}) — حداقل ${numWindows * minPerWindow} لازم`,
                totalTrades: N,
                minPerWindow
            };
        }
        numWindows = possible;
    }

    const windowSize = Math.floor(N / numWindows);
    const windows = [];
    for (let i = 0; i < numWindows; i++) {
        const from = i * windowSize;
        const to = i === numWindows - 1 ? N : (i + 1) * windowSize;
        const seg = sorted.slice(from, to);
        const s = computeStats(seg);
        windows.push({
            idx: i + 1,
            fromIdx: from,
            toIdx: to,
            count: s.count,
            pf: s.pf,
            winRate: s.winRate,
            avgPnl: s.avgPnl,
            totalPnl: s.totalPnl
        });
    }

    const profitable = windows.filter(w => w.pf > 1);
    const consistencyPct = windows.length ? (profitable.length / windows.length * 100) : 0;
    const avgPF = windows.length
        ? windows.reduce((s, w) => s + w.pf, 0) / windows.length
        : 0;

    // Sharpe روی همه‌ی tradeها
    const pnls = sorted.map(t => t.pnlPct);
    const mean = pnls.reduce((s, x) => s + x, 0) / pnls.length;
    const variance = pnls.length > 1
        ? pnls.reduce((s, x) => s + (x - mean) ** 2, 0) / (pnls.length - 1)
        : 0;
    const sd = Math.sqrt(variance);
    const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(pnls.length) : null;

    // PF کل
    const allStats = computeStats(sorted);

    // Gate
    const gate = {
        minWindowsOk: windows.length >= 3,
        profitable75: profitable.length >= Math.ceil(windows.length * 0.75),
        avgPFOk: avgPF >= 1.2,
        sharpeOk: sharpe !== null && sharpe > 0.5
    };
    gate.allPassed = Object.values(gate).every(v => v === true);

    return {
        totalTrades: N,
        numWindows,
        windowSize,
        windows,
        allStats,
        profitableWindows: profitable.length,
        consistencyPct: Math.round(consistencyPct * 10) / 10,
        avgPF: Math.round(avgPF * 100) / 100,
        sharpe: sharpe !== null ? Math.round(sharpe * 100) / 100 : null,
        gate,
        note: N < 40 ? 'دیتای کم — infra آماده' : null
    };
}

function computeStats(trades) {
    if (!trades || !trades.length) {
        return { count: 0, winRate: 0, avgPnl: 0, totalPnl: 0, pf: 0, sharpe: null };
    }
    const pnls = trades.map(t => t.pnlPct).filter(Number.isFinite);
    if (!pnls.length) {
        return { count: 0, winRate: 0, avgPnl: 0, totalPnl: 0, pf: 0, sharpe: null };
    }
    const wins = pnls.filter(x => x > 0);
    const losses = pnls.filter(x => x <= 0);
    const gp = wins.reduce((s, x) => s + x, 0);
    const gl = -losses.reduce((s, x) => s + x, 0);
    // PF با cap هوشمند: اگه هیچ ضرری نبود → 999، اگه هیچ سودی نبود → 0
    let pf;
    if (gl > 0) pf = gp / gl;
    else if (gp > 0) pf = 999;
    else pf = 0;

    const mean = pnls.reduce((s, x) => s + x, 0) / pnls.length;
    const variance = pnls.length > 1
        ? pnls.reduce((s, x) => s + (x - mean) ** 2, 0) / (pnls.length - 1)
        : 0;
    const sd = Math.sqrt(variance);
    const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(pnls.length) : null;

    return {
        count: pnls.length,
        winRate: Math.round((wins.length / pnls.length * 100) * 100) / 100,
        avgPnl: Math.round(mean * 100) / 100,
        totalPnl: Math.round(pnls.reduce((s, x) => s + x, 0) * 100) / 100,
        pf: Math.round(pf * 100) / 100,
        sharpe: sharpe !== null ? Math.round(sharpe * 100) / 100 : null
    };
}

function inverseNormCdf(p) {
    if (p <= 0) return -Infinity;
    if (p >= 1) return Infinity;
    const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
               1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
    const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
               6.680131188771972e+01, -1.328068155288572e+01];
    const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
               -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
    const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
               3.754408661907416e+00];
    const plow = 0.02425, phigh = 1 - plow;
    let q, r;
    if (p < plow) {
        q = Math.sqrt(-2 * Math.log(p));
        return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
               ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
    } else if (p <= phigh) {
        q = p - 0.5; r = q * q;
        return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q /
               (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
    } else {
        q = Math.sqrt(-2 * Math.log(1 - p));
        return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
                ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
    }
}

function deflatedSharpe(observedSharpe, numTrials, sampleSize) {
    if (!Number.isFinite(observedSharpe) || !sampleSize || sampleSize < 3) return null;
    const EULER = 0.5772156649;
    const expectedMax = (1 - EULER) * inverseNormCdf(1 - 1 / numTrials)
                       + EULER * inverseNormCdf(1 - 1 / (numTrials * Math.E));
    const stdErrSharpe = Math.sqrt((1 + 0.5 * observedSharpe * observedSharpe) / (sampleSize - 1));
    const deflated = (observedSharpe - expectedMax * stdErrSharpe) / stdErrSharpe;
    return {
        observed: Math.round(observedSharpe * 1000) / 1000,
        expectedMax: Math.round(expectedMax * 1000) / 1000,
        deflated: Math.round(deflated * 1000) / 1000,
        numTrials, sampleSize
    };
}

function evaluateOverfit(windows, opts = {}) {
    const passingThreshold = opts.passingThreshold || 0.6;
    const valid = windows.filter(w => w.testStats && w.testStats.count >= 2);
    const passing = valid.filter(w =>
        w.testStats.pf >= (w.trainStats.pf * passingThreshold) &&
        w.testStats.pf >= 1.0
    );
    const profitable = valid.filter(w => w.testStats.pf > 1.0);

    const avgTestPF = valid.length ? valid.reduce((s, w) => s + w.testStats.pf, 0) / valid.length : 0;
    const avgTrainPF = valid.length ? valid.reduce((s, w) => s + w.trainStats.pf, 0) / valid.length : 0;
    const dropPct = avgTrainPF > 0 ? ((avgTrainPF - avgTestPF) / avgTrainPF) * 100 : 0;

    const testSharpes = valid.map(w => w.testStats.sharpe).filter(Number.isFinite);
    const avgTestSharpe = testSharpes.length ? testSharpes.reduce((s, x) => s + x, 0) / testSharpes.length : null;

    const minWindowsOk = valid.length >= 2;
    const profitableOk = valid.length > 0 && profitable.length >= Math.ceil(valid.length * 0.5);

    const gate = {
        minWindowsOk,
        minProfitableOk: profitableOk,
        avgTestPFOk: avgTestPF >= 1.2,
        dropOk: dropPct < 60
    };
    gate.allPassed = Object.values(gate).every(v => v === true);

    return {
        validWindows: valid.length,
        profitableWindows: profitable.length,
        passingWindows: passing.length,
        avgTrainPF: Math.round(avgTrainPF * 100) / 100,
        avgTestPF: Math.round(avgTestPF * 100) / 100,
        dropPct: Math.round(dropPct * 10) / 10,
        avgTestSharpe: avgTestSharpe !== null ? Math.round(avgTestSharpe * 100) / 100 : null,
        gate,
        note: valid.length < 3 ? 'دیتای کم — نتیجه فقط برای زیرساخت' : null
    };
}

module.exports = {
    buildWindows,
    computeStats,
    deflatedSharpe,
    evaluateOverfit,
    evaluateAggregate
};