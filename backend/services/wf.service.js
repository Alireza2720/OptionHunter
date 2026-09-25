'use strict';
// ============================================================
// wf.service.js — orchestrate Walk-Forward (Phase 5)
// ============================================================

const { COLLECTIONS } = require('../config/constants');
const wfCore = require('../core/walk-forward');

let deps = {
    getDB: null,
    logger: null,
    signalFilterService: null
};

// ------------------------------------------------------------
// ذخیره‌ی WF strategy whitelist برای مسیر زنده
// ------------------------------------------------------------
async function saveWfStrategyWhitelist(jobId, aggregateResult) {
    const db = deps.getDB();
    const passingStrategies = [];
    const perStrategy = aggregateResult.perStrategy || {};

    for (const [sid, r] of Object.entries(perStrategy)) {
        if (r.error) continue;
        if (r.gate && r.gate.allPassed) {
            passingStrategies.push({
                strategyId: sid,
                totalTrades: r.totalTrades,
                avgPF: r.avgPF,
                sharpe: r.sharpe,
                consistencyPct: r.consistencyPct
            });
        }
    }

    // اگه هیچ استراتژی‌ای پاس نشد، همه‌ی whitelist رو حفظ کن
    const hasPassing = passingStrategies.length > 0;

    await db.collection('meta').updateOne(
        { _id: 'wf_strategy_whitelist' },
        { $set: {
            jobId: String(jobId),
            strategies: passingStrategies.map(s => s.strategyId),
            details: passingStrategies,
            hasPassing,
            computedAt: new Date(),
            // آمار کل
            overallGate: aggregateResult.gate,
            totalTrades: aggregateResult.totalTrades
        }},
        { upsert: true }
    );

    deps.logger && deps.logger.info(
        `WF whitelist saved: ${passingStrategies.length} strategies passed`
    );

    return {
        passingStrategies: passingStrategies.map(s => s.strategyId),
        details: passingStrategies,
        hasPassing
    };
}

async function getWfStrategyWhitelist() {
    const db = deps.getDB();
    const doc = await db.collection('meta').findOne({ _id: 'wf_strategy_whitelist' });
    return doc;
}
function init(d) { deps = { ...deps, ...d }; }

// ------------------------------------------------------------
// Walk-forward یک pair
// ------------------------------------------------------------
async function runOnePair(jobId, symbol, strategyId, opts = {}) {
    const db = deps.getDB();
    const minTrades = opts.minTrades || 5;

    const detail = await db.collection(COLLECTIONS.BACKTEST_COMPARE_DETAILS).findOne({
        jobId: String(jobId),
        symbol,
        strategyId
    });

    if (!detail || !detail.trades || detail.trades.length < minTrades) {
        return {
            symbol, strategyId,
            error: `trade کم (${detail?.trades?.length || 0} < ${minTrades})`
        };
    }

    const allTrades = detail.trades;
    const minTime = Math.min(...allTrades.map(t => t.entryTime));
    const maxTime = Math.max(...allTrades.map(t => t.exitTime || t.entryTime));
    const totalDays = (maxTime - minTime) / 86400;

    const windows = wfCore.buildWindows(totalDays, opts.numWindows || 4, 0.7);
    if (!windows.length) {
        return {
            symbol, strategyId,
            error: `بازه کوتاه (${totalDays.toFixed(0)} روز)`
        };
    }

    const windowResults = [];
    for (const w of windows) {
        const trainFrom = minTime + w.trainStart * 86400;
        const trainTo = minTime + w.trainEnd * 86400;
        const testFrom = minTime + w.testStart * 86400;
        const testTo = minTime + w.testEnd * 86400;

        const trainTrades = allTrades.filter(t =>
            t.entryTime >= trainFrom && t.entryTime < trainTo
        );
        const testTrades = allTrades.filter(t =>
            t.entryTime >= testFrom && t.entryTime < testTo
        );

        windowResults.push({
            idx: w.idx,
            trainDays: w.trainDays,
            testDays: w.testDays,
            trainFrom, trainTo, testFrom, testTo,
            trainStats: wfCore.computeStats(trainTrades),
            testStats: wfCore.computeStats(testTrades)
        });
    }

    const overfit = wfCore.evaluateOverfit(windowResults, opts);

    // Sharpe کل
    const rawPnls = allTrades.map(t => t.pnlPct).filter(Number.isFinite);
    let rawSharpe = null;
    if (rawPnls.length > 2) {
        const mean = rawPnls.reduce((s, x) => s + x, 0) / rawPnls.length;
        const variance = rawPnls.reduce((s, x) => s + (x - mean) ** 2, 0) / (rawPnls.length - 1);
        const sd = Math.sqrt(variance);
        rawSharpe = sd > 0 ? (mean / sd) * Math.sqrt(rawPnls.length) : null;
    }

    const deflated = wfCore.deflatedSharpe(
        rawSharpe,
        opts.numTrials || 234,
        rawPnls.length
    );

    const allPassed = overfit.gate.allPassed
        && deflated !== null
        && deflated.deflated > 0.5;

    return {
        jobId, symbol, strategyId,
        strategyName: detail.strategyName,
        timeframe: detail.timeframe,
        totalTrades: allTrades.length,
        totalDays: Math.round(totalDays),
        windows: windowResults,
        overfit,
        deflated,
        gate: {
            ...overfit.gate,
            deflatedSharpeOk: deflated !== null && deflated.deflated > 0.5,
            allPassed
        }
    };
}

// ------------------------------------------------------------
// Walk-forward کل whitelist
// ------------------------------------------------------------
async function runWhitelist(jobId, opts = {}) {
    const wl = await deps.signalFilterService.getWhitelist();
    if (!wl) {
        return { error: 'whitelist ساخته نشده — ابتدا یک sim بزن' };
    }

    const results = [];
    for (const pair of wl.pairs) {
        const [symbol, strategyId] = pair.split('::');
        try {
            const r = await runOnePair(jobId, symbol, strategyId, opts);
            results.push(r);
        } catch (e) {
            deps.logger && deps.logger.warn(`wf ${pair}: ${e.message}`);
            results.push({ symbol, strategyId, error: e.message });
        }
    }

    const valid = results.filter(r => !r.error && r.gate);
    const passing = valid.filter(r => r.gate.allPassed);

    const avgTestPF = valid.length
        ? valid.reduce((s, r) => s + r.overfit.avgTestPF, 0) / valid.length
        : 0;
    const avgDrop = valid.length
        ? valid.reduce((s, r) => s + r.overfit.dropPct, 0) / valid.length
        : 0;

    results.sort((a, b) => {
        const pa = a.gate?.allPassed ? 1 : 0;
        const pb = b.gate?.allPassed ? 1 : 0;
        if (pa !== pb) return pb - pa;
        return (b.overfit?.avgTestPF || 0) - (a.overfit?.avgTestPF || 0);
    });

    return {
        jobId,
        analyzedAt: new Date(),
        totalPairs: wl.pairs.size,
        validPairs: valid.length,
        passingPairs: passing.length,
        avgTestPF: Math.round(avgTestPF * 100) / 100,
        avgDropPct: Math.round(avgDrop * 10) / 10,
        note: valid.length < 5
            ? 'دیتای کم — infrastructure آماده، ولی نتایج برای monitoring هستند'
            : null,
        results
    };
}

// ------------------------------------------------------------
// 🆕 Aggregate: همه‌ی tradeهای whitelist در پنجره‌های زمانی
// ------------------------------------------------------------
async function runAggregate(jobId, opts = {}) {
    const db = deps.getDB();
    const minTrades = opts.minTrades || 5;
    const wl = await deps.signalFilterService.getWhitelist();
    if (!wl) return { error: 'whitelist ساخته نشده' };

    // ۱) همه‌ی tradeها
    const allTrades = [];
    for (const pair of wl.pairs) {
        const [symbol, strategyId] = pair.split('::');
        const detail = await db.collection(COLLECTIONS.BACKTEST_COMPARE_DETAILS).findOne({
            jobId: String(jobId),
            symbol,
            strategyId
        });
        if (!detail || !detail.trades) continue;
        if (detail.trades.length < minTrades) continue;
        for (const t of detail.trades) {
            allTrades.push({
                ...t,
                symbol,
                strategyId,
                strategyName: detail.strategyName
            });
        }
    }

    // ۲) Aggregate کل
    const overall = wfCore.evaluateAggregate(allTrades, opts.numWindows || 4, 5);

    // ۳) Aggregate به تفکیک استراتژی
    const byStrategy = {};
    for (const t of allTrades) {
        if (!byStrategy[t.strategyId]) byStrategy[t.strategyId] = [];
        byStrategy[t.strategyId].push(t);
    }
    const perStrategy = {};
    for (const [sid, trades] of Object.entries(byStrategy)) {
        perStrategy[sid] = wfCore.evaluateAggregate(trades, opts.numWindows || 4, 5);
    }

    // ۴) Deflated Sharpe
    let deflated = null;
    if (overall.sharpe !== null && overall.totalTrades >= 5) {
        deflated = wfCore.deflatedSharpe(
            overall.sharpe,
            opts.numTrials || 234,
            overall.totalTrades
        );
    }

    return {
        jobId,
        analyzedAt: new Date(),
        totalWhitelistPairs: wl.pairs.size,
        totalTrades: allTrades.length,
        overall,
        perStrategy,
        deflated,
        gate: {
            ...(overall.gate || {}),
            deflatedSharpeOk: deflated !== null && deflated.deflated > 0.5,
            allPassed: (overall.gate && overall.gate.allPassed) &&
                       (deflated !== null && deflated.deflated > 0.5)
        }
    };
}

module.exports = {
    init, runOnePair, runWhitelist, runAggregate,
    saveWfStrategyWhitelist,
    getWfStrategyWhitelist
};