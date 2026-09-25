'use strict';
// ============================================================
// signal-filter.service.js — مدیریت signal whitelist
// ============================================================
// - از نتایج analysis، whitelist رو می‌سازه و در meta ذخیره می‌کنه
// - مسیر زنده از whitelist استفاده می‌کنه
// ============================================================

const { COLLECTIONS } = require('../config/constants');
const { filterTrades } = require('../core/signal-filter');

let deps = { getDB: null, logger: null, analysisService: null };
function init(d) { deps = { ...deps, ...d }; }

// ------------------------------------------------------------
// از یک job، whitelist بساز و ذخیره کن
// ------------------------------------------------------------
async function buildAndSaveWhitelist(jobId, opts = {}) {
    const db = deps.getDB();
    const analysis = await deps.analysisService.analyzeJob(jobId, {
        minTrades: opts.minTrades || 5,
        iterations: opts.iterations || 2000
    });

    // tradeهای خام
    const details = await db.collection(COLLECTIONS.BACKTEST_COMPARE_DETAILS)
        .find({ jobId: String(jobId) }).toArray();
    const allTrades = [];
    for (const d of details) {
        if (!d.trades || d.trades.length < (opts.minTrades || 5)) continue;
        for (const t of d.trades) {
            allTrades.push({
                ...t,
                symbol: d.symbol, strategyId: d.strategyId, strategyName: d.strategyName
            });
        }
    }

    const fr = filterTrades(allTrades, analysis, {
        mode: opts.filterMode || 'pair',
        minPairPF: opts.minPairPF || 2.0,
        minPairTrades: opts.minPairTrades || 5,
        minPairLB: opts.minPairLB || 1.0,
        minStrategyPF: opts.minStrategyPF || 1.3,
        minStrategyTrades: opts.minStrategyTrades || 5
    });

    const pairs = fr.filter.allowedPairs || [];
    const strategies = fr.filter.allowedStrategies || [];
    const symbols = fr.filter.allowedSymbols || [];

    await db.collection(COLLECTIONS.META).updateOne(
        { _id: 'signal_whitelist' },
        { $set: {
            jobId: String(jobId),
            pairs,
            strategies,
            symbols,
            filterMode: opts.filterMode || 'pair',
            computedAt: new Date(),
            stats: {
                totalPairs: fr.filter.originalCount,
                allowedPairs: pairs.length
            }
        }},
        { upsert: true }
    );

    deps.logger && deps.logger.info(
        `signal whitelist saved: ${pairs.length} pairs, ${symbols.length} symbols`
    );

    return {
        pairs: pairs.length,
        strategies,
        symbols: symbols.length,
        totalPairs: fr.filter.originalCount
    };
}

// ------------------------------------------------------------
// بازیابی برای مسیر زنده
// ------------------------------------------------------------
async function getWhitelist() {
    const db = deps.getDB();
    const doc = await db.collection(COLLECTIONS.META).findOne({ _id: 'signal_whitelist' });
    if (!doc) return null;

    // منبع اصلی: pair-level signal_whitelist
    const pairs = doc.pairs || [];
    const strategies = doc.strategies || [];

    // WF whitelist فقط برای insight (نه فیلتر)
    const wfDoc = await db.collection(COLLECTIONS.META).findOne({ _id: 'wf_strategy_whitelist' });
    let wfApplied = false;
    let wfStrategies = null;
    if (wfDoc && wfDoc.hasPassing && wfDoc.strategies && wfDoc.strategies.length > 0) {
        wfApplied = true;
        wfStrategies = wfDoc.strategies;
    }

    return {
        pairs: new Set(pairs),
        strategies: new Set(strategies),
        symbols: new Set(doc.symbols || []),
        jobId: doc.jobId,
        computedAt: doc.computedAt,
        filterMode: doc.filterMode,
        wfApplied,
        wfStrategies
    };
}

async function clear() {
    const db = deps.getDB();
    await db.collection(COLLECTIONS.META).deleteOne({ _id: 'signal_whitelist' });
}

module.exports = { init, buildAndSaveWhitelist, getWhitelist, clear };