'use strict';
// wf-retrain.service.js — FIX #9b v2: real OOS walk-forward with per-window retraining
const { COLLECTIONS } = require('../config/constants');
const wfCore = require('../core/walk-forward');

let deps = { getDB: null, logger: null, backtest: null, signalFilterService: null };
function init(d) { deps = Object.assign({}, deps, d || {}); }

function _buildParamGrid(strategyId, defaults) {
    const numeric = Object.entries(defaults || {})
        .filter(kv => Number.isFinite(kv[1]) && kv[1] > 0)
        .slice(0, 2);
    if (!numeric.length) return [{}];
    const mults = [0.7, 1.0, 1.3];
    const grid = [];
    function _recur(i, cur) {
        if (i === numeric.length) { grid.push(Object.assign({}, cur)); return; }
        const k = numeric[i][0];
        const v = numeric[i][1];
        for (const mm of mults) {
            cur[k] = Number.isInteger(v) ? Math.max(1, Math.round(v * mm)) : Math.round(v * mm * 100) / 100;
            _recur(i + 1, cur);
            delete cur[k];
        }
    }
    _recur(0, {});
    return grid;
}

async function runOnePairWithRetrain(jobId, symbol, strategyId, opts) {
    opts = opts || {};
    const db = deps.getDB();
    const STRATEGIES = require('../strategies').STRATEGIES;
    const def = STRATEGIES[strategyId];
    if (!def) return { symbol, strategyId, error: 'unknown strategy' };
    if (!deps.backtest || typeof deps.backtest.runBacktest !== 'function') {
        return { symbol, strategyId, error: 'backtest dep missing' };
    }
    const detail = await db.collection(COLLECTIONS.BACKTEST_COMPARE_DETAILS).findOne({
        jobId: String(jobId), symbol, strategyId
    });
    if (!detail || !detail.trades || detail.trades.length < 5) {
        return { symbol, strategyId, error: 'not enough trades' };
    }
    const allTrades = detail.trades;
    let minTime = Infinity, maxTime = -Infinity;
    for (const t of allTrades) {
        if (t.entryTime < minTime) minTime = t.entryTime;
        const ex = t.exitTime || t.entryTime;
        if (ex > maxTime) maxTime = ex;
    }
    const totalDays = (maxTime - minTime) / 86400;
    const numWindows = opts.numWindows || 4;
    const windows = wfCore.buildWindows(totalDays, numWindows, 0.7);
    if (!windows.length) {
        return { symbol, strategyId, error: 'range too short (' + Math.round(totalDays) + 'd)' };
    }
    const paramGrid = _buildParamGrid(strategyId, def.defaultParams);
    const windowResults = [];
    for (const w of windows) {
        const trainFrom = minTime + w.trainStart * 86400;
        const trainTo = minTime + w.trainEnd * 86400;
        const testFrom = minTime + w.testStart * 86400;
        const testTo = minTime + w.testEnd * 86400;
        let bestParams = null, bestScore = -Infinity, bestTrainStats = null;
        for (const params of paramGrid) {
            const cfg = {
                symbol, strategyId,
                timeframe: detail.timeframe,
                htfTimeframe: detail.htfTimeframe || '1d',
                candleType: 'heikin',
                params: Object.assign({}, def.defaultParams, params)
            };
            try {
                const r = await deps.backtest.runBacktest(cfg, trainFrom, trainTo, { mode: 'stock', lightMode: true });
                const s = r.stockStats || {};
                const n = s.count || 0;
                if (n < 3) continue;
                const pf = Number.isFinite(s.profitFactor) ? s.profitFactor : (s.totalPnl > 0 ? 5 : 0);
                if (pf < 1.0) continue;
                const score = Math.pow(pf, 0.75) * Math.pow(n, 0.25);
                if (score > bestScore) { bestScore = score; bestParams = params; bestTrainStats = s; }
            } catch (e) { /* skip */ }
        }
        let testStats = null;
        if (bestParams) {
            const cfg = {
                symbol, strategyId,
                timeframe: detail.timeframe,
                htfTimeframe: detail.htfTimeframe || '1d',
                candleType: 'heikin',
                params: Object.assign({}, def.defaultParams, bestParams)
            };
            try {
                const r = await deps.backtest.runBacktest(cfg, testFrom, testTo, { mode: 'stock', lightMode: true });
                testStats = r.stockStats || null;
            } catch (e) { /* skip */ }
        }
        windowResults.push({
            idx: w.idx, trainFrom, trainTo, testFrom, testTo,
            trainDays: w.trainDays, testDays: w.testDays,
            bestParams, trainStats: bestTrainStats, testStats,
            bestScore: bestScore === -Infinity ? null : bestScore
        });
    }
    const overfit = wfCore.evaluateOverfit(windowResults, opts);
    return {
        method: 'retrain-oos', isRealOos: true,
        jobId, symbol, strategyId,
        strategyName: def.name, timeframe: detail.timeframe,
        totalDays: Math.round(totalDays),
        paramGridSize: paramGrid.length,
        windows: windowResults, overfit, gate: overfit.gate
    };
}

async function runWhitelistWithRetrain(jobId, opts) {
    opts = opts || {};
    if (!deps.signalFilterService) return { error: 'signalFilterService not wired' };
    const wl = await deps.signalFilterService.getWhitelist();
    if (!wl || !wl.pairs) return { error: 'whitelist not built' };
    const pairs = wl.pairs instanceof Set ? Array.from(wl.pairs) : (Array.isArray(wl.pairs) ? wl.pairs : []);
    const results = [];
    for (const pair of pairs) {
        const parts = String(pair).split('::');
        if (parts.length !== 2) continue;
        try {
            const r = await runOnePairWithRetrain(jobId, parts[0], parts[1], opts);
            results.push(r);
        } catch (e) {
            deps.logger && deps.logger.warn('wf-retrain ' + pair + ': ' + e.message);
            results.push({ symbol: parts[0], strategyId: parts[1], error: e.message });
        }
    }
    const valid = results.filter(r => !r.error && r.gate);
    const passing = valid.filter(r => r.gate.allPassed);
    return {
        method: 'retrain-oos', isRealOos: true, jobId,
        analyzedAt: new Date(),
        totalPairs: pairs.length, validPairs: valid.length, passingPairs: passing.length,
        results
    };
}

module.exports = { init, runOnePairWithRetrain, runWhitelistWithRetrain, _buildParamGrid };
