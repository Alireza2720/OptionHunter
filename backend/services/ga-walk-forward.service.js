'use strict';
// ============================================================
// ga-walk-forward.service.js — N-window evaluation for GA
// ============================================================
// Splits [dateFrom, dateTo] into N sequential windows.
// Weights increase toward recent windows (0.5 → 1.0 normalized).
// ============================================================

let deps = { logger: null };
function init(d) { deps = { ...deps, ...d }; }

const DEFAULT_NUM_WINDOWS = 6;

function buildWindowWeights(n) {
    if (n <= 0) return [];
    if (n === 1) return [1.0];
    const raw = [];
    for (let i = 0; i < n; i++) {
        raw.push(0.5 + (i / (n - 1)) * 0.5);
    }
    const sum = raw.reduce((s, x) => s + x, 0);
    return raw.map(x => x / sum);
}

function buildWindows(dateFrom, dateTo, numWindows) {
    numWindows = numWindows || DEFAULT_NUM_WINDOWS;
    const from = Number(dateFrom);
    const to = Number(dateTo);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return [];
    const span = to - from;
    const step = Math.floor(span / numWindows);
    if (step <= 0) return [];
    const out = [];
    for (let i = 0; i < numWindows; i++) {
        const wFrom = from + i * step;
        const wTo = i === numWindows - 1 ? to : from + (i + 1) * step - 1;
        out.push({
            idx: i,
            from: wFrom,
            to: wTo,
            days: Math.round((wTo - wFrom) / 86400)
        });
    }
    return out;
}

function _mergeStats(list) {
    let totalTrades = 0, wins = 0, totalPnl = 0, gp = 0, gl = 0;
    let profitableWindows = 0;
    for (const s of list) {
        if (!s || !s.count) continue;
        const n = s.count;
        const w = n * (s.winRate || 0) / 100;
        const l = n - w;
        totalTrades += n;
        wins += w;
        totalPnl += s.totalPnl || 0;
        gp += w * Math.abs(s.avgWin || 0);
        gl += l * Math.abs(s.avgLoss || 0);
        if ((s.totalPnl || 0) > 0) profitableWindows++;
    }
    const pf = gl > 0 ? gp / gl : (gp > 0 ? 999 : 0);
    const winRate = totalTrades > 0 ? wins / totalTrades * 100 : 0;
    const sharpeVals = list.map(s => s.sharpe).filter(Number.isFinite);
    const avgSharpe = sharpeVals.length
        ? sharpeVals.reduce((a, b) => a + b, 0) / sharpeVals.length
        : null;
    const ddVals = list.map(s => s.maxDrawdownPct).filter(Number.isFinite);
    const maxDD = ddVals.length ? Math.max(...ddVals) : 0;
    return {
        totalTrades: totalTrades,
        winRate: winRate,
        totalPnl: totalPnl,
        totalReturnPct: totalPnl,
        profitFactor: pf,
        sharpe: avgSharpe,
        maxDrawdownPct: maxDD,
        profitableWindows: profitableWindows,
        windowsTotal: list.length
    };
}

async function evaluate(cfg, opts) {
    opts = opts || {};
    const backtest = opts.backtest;
    if (!backtest) return { error: 'backtest dep missing', stats: null, windows: [] };
    const numWindows = opts.numWindows || DEFAULT_NUM_WINDOWS;
    const mode = opts.mode || 'stock';
    const lightMode = opts.lightMode !== false;

    const windows = buildWindows(opts.dateFrom, opts.dateTo, numWindows);
    if (!windows.length) return { error: 'invalid date range', stats: null, windows: [] };
    const weights = buildWindowWeights(windows.length);

    const windowResults = [];
    for (const w of windows) {
        try {
            const r = await backtest.runBacktest(cfg, w.from, w.to, {
                mode: mode,
                lightMode: lightMode,
                wantMonteCarlo: false,
                wantRobustness: false
            });
            const st = mode === 'option' ? (r.optionStats || r.stats) : r.stockStats;
            windowResults.push({ idx: w.idx, from: w.from, to: w.to, days: w.days, stats: st || null });
        } catch (e) {
            windowResults.push({ idx: w.idx, from: w.from, to: w.to, days: w.days, stats: null, error: e.message });
        }
    }

    const valid = windowResults.filter(w => w.stats && w.stats.count > 0);
    const merged = _mergeStats(valid.map(w => w.stats));
    return {
        windows: windowResults,
        weights: weights,
        stats: merged,
        numWindows: numWindows,
        validWindows: valid.length
    };
}

module.exports = { init, evaluate, buildWindows, buildWindowWeights };