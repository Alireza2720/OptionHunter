'use strict';
// ============================================================
// backtest-orchestrator.service.js
// یک job یکپارچه: compare → analysis → WF → regime → portfolio → suggest
// ============================================================

const { ObjectId } = require('mongodb');
const { COLLECTIONS } = require('../config/constants');

let deps = {
    getDB: null, logger: null,
    backtestService: null, analysisService: null,
    signalFilterService: null, wfService: null,
    regimeService: null, portfolioService: null
};
function init(d) { deps = { ...deps, ...d }; }

// ------------------------------------------------------------
// Run — فقط job می‌سازه، processQueue در پس‌زمینه
// ------------------------------------------------------------
async function runBacktest(params) {
    const {
        mode = 'option',
        symbols, strategies,
        dateFrom, dateTo,
        optionType = 'call',
        panels = {}
    } = params;

    if (!Array.isArray(symbols) || !symbols.length) {
        throw Object.assign(new Error('symbols لازم است'), { status: 400 });
    }
    if (!Array.isArray(strategies) || !strategies.length) {
        throw Object.assign(new Error('strategies لازم است'), { status: 400 });
    }

    const chunks = symbols.map(s => ({ label: s, items: [s] }));
    const payload = {
        mode, symbols, strategies,
        useRealOption: mode === 'option',
        dateFrom: dateFrom ? parseInt(dateFrom) : null,
        dateTo: dateTo ? parseInt(dateTo) : null,
        optionType, panels
    };

    const job = await deps.backtestService.createJob('backtest-compare', payload, chunks);
    deps.backtestService.processQueue().catch(e =>
        deps.logger && deps.logger.error('processQueue: ' + e.message));

    return { jobId: String(job._id), status: 'QUEUED' };
}

// ------------------------------------------------------------
// Get Results — job status + محاسبه‌ی rich results وقتی DONE
// ------------------------------------------------------------
async function getResults(jobId) {
    const db = deps.getDB();
    const job = await db.collection(COLLECTIONS.BACKTEST_JOBS)
        .findOne({ _id: new ObjectId(jobId) });
    if (!job) return { error: 'job not found' };

    const base = {
        _id: String(job._id),
        type: job.type,
        status: job.status,
        progress: job.progress,
        error: job.error,
        createdAt: job.createdAt,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt
    };

    if (job.status !== 'DONE') return base;

    const cacheId = 'backtest_result_' + jobId;
    const cached = await db.collection(COLLECTIONS.META).findOne({ _id: cacheId });

    // compute تمام شده → نتیجه رو برگردون
    if (cached && cached.result && !cached.computing) {
        return { ...base, result: cached.result };
    }

    // در حال compute → flag رو برگردون
    if (cached && cached.computing) {
        const elapsed = cached.startedAt
            ? Math.round((Date.now() - new Date(cached.startedAt).getTime()) / 1000)
            : 0;
        return { ...base, computing: true, computingFor: elapsed };
    }

    // هنوز شروع نشده → در پس‌زمینه شروع کن، بلافاصله برگردون
    computeInBackground(jobId).catch(e =>
        deps.logger && deps.logger.error('[bt-compute] ' + e.message));
    return { ...base, computing: true, computingFor: 0 };
}

// ------------------------------------------------------------
// Compute in background — سنگین‌ترین بخش
// ------------------------------------------------------------
async function computeInBackground(jobId) {
    const db = deps.getDB();
    const cacheId = 'backtest_result_' + jobId;

    // flag اول
    await db.collection(COLLECTIONS.META).updateOne(
        { _id: cacheId },
        { $set: { computing: true, startedAt: new Date() } },
        { upsert: true }
    );

    const t0 = Date.now();
    try {
        const job = await db.collection(COLLECTIONS.BACKTEST_JOBS)
            .findOne({ _id: new ObjectId(jobId) });
        if (!job) throw new Error('job disappeared');

        const result = await computeFullResult(job, jobId);

        await db.collection(COLLECTIONS.META).updateOne(
            { _id: cacheId },
            { $set: { computing: false, result, cachedAt: new Date() }, $unset: { startedAt: '' } }
        );
        deps.logger && deps.logger.info(
            `[bt-compute] ${jobId} done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    } catch (e) {
        await db.collection(COLLECTIONS.META).updateOne(
            { _id: cacheId },
            { $set: { computing: false, error: e.message }, $unset: { startedAt: '' } }
        );
        deps.logger && deps.logger.error(`[bt-compute] ${jobId} FAILED: ${e.message}`);
    }
}

async function computeFullResult(job, jobId) {
    const db = deps.getDB();
    const panels = (job.payload && job.payload.panels) || {};
    const mode = (job.payload && job.payload.mode) || 'option';
    const symbols = (job.payload && job.payload.symbols) || [];

    deps.logger && deps.logger.info(`[bt-compute] ${jobId} start (${symbols.length} symbols)`);

    const details = await db.collection(COLLECTIONS.BACKTEST_COMPARE_DETAILS)
        .find({ jobId: String(jobId) })
        .project({
            symbol: 1, strategyId: 1, strategyName: 1,
            timeframe: 1, htfTimeframe: 1,
            stockStats: 1, optionStats: 1,
            realUsed: 1, approxUsed: 1,
            'trades.entryTime': 1, 'trades.exitTime': 1, 'trades.pnlPct': 1,
            'trades.stockEntry': 1, 'trades.stockExit': 1,
            'trades.optionEntry': 1, 'trades.optionExit': 1,
            'trades.delta': 1, 'trades.iv': 1, 'trades.source': 1, 'trades.exitReason': 1
        })
        .toArray();

    const result = {
        mode,
        panelsUsed: panels,
        summary: job.result || {},
        details: details.map(d => ({
            symbol: d.symbol,
            strategyId: d.strategyId,
            strategyName: d.strategyName,
            timeframe: d.timeframe,
            htfTimeframe: d.htfTimeframe,
            stockStats: d.stockStats || null,
            optionStats: d.optionStats || null,
            tradesCount: (d.trades || []).length,
            realUsed: d.realUsed || 0,
            approxUsed: d.approxUsed || 0,
            trades: (d.trades || []).slice(0, 200)
        }))
    };

    // ---- Analysis ----
    if (panels.analysis && panels.analysis.enabled) {
        deps.logger && deps.logger.info(`[bt-compute] ${jobId} analysis...`);
        try {
            // 🆕 کاهش خودکار iterations بر اساس تعداد combos
            const totalCombos = details.length;
            let iter = panels.analysis.iterations || 10000;
            if (totalCombos > 100) iter = Math.min(iter, 1000);
            else if (totalCombos > 50) iter = Math.min(iter, 2000);
            else if (totalCombos > 20) iter = Math.min(iter, 5000);

            result.analysis = await deps.analysisService.analyzeJob(jobId, {
                minTrades: panels.analysis.minTrades || 5,
                iterations: iter
            });
        } catch (e) {
            result.analysis = { error: e.message };
        }
    }

    // ---- WF ----
    if (panels.wf && panels.wf.enabled) {
        deps.logger && deps.logger.info(`[bt-compute] ${jobId} wf...`);
        try {
            await deps.signalFilterService.buildAndSaveWhitelist(jobId, {
                filterMode: 'pair',
                minPairPF: 2.0, minPairTrades: 5, minPairLB: 1.0
            });
            const wf = await deps.wfService.runAggregate(jobId, {
                numWindows: panels.wf.windows || 4,
                minTrades: 5,
                numTrials: panels.wf.numTrials || 234
            });
            if (!wf.error && wf.perStrategy) {
                try {
                    wf.wfWhitelistSaved =
                        await deps.wfService.saveWfStrategyWhitelist(jobId, wf);
                } catch (_) {}
            }
            result.wf = wf;
        } catch (e) {
            result.wf = { error: e.message };
        }
    }

    // ---- Regime ----
    if (panels.regime && panels.regime.enabled) {
        deps.logger && deps.logger.info(`[bt-compute] ${jobId} regime...`);
        try {
            await deps.regimeService.refreshAll();
            const all = await deps.regimeService.getAllCached();
            result.regimes = all.map(r => ({
                symbol: r.symbol, macro: r.macro, vol: r.vol,
                slopePct: r.macroSlopePct || null, close: r.close || null
            }));
        } catch (e) {
            result.regimes = [];
        }
    }

    // ---- Portfolio ----
    if (panels.portfolio && panels.portfolio.enabled) {
        deps.logger && deps.logger.info(`[bt-compute] ${jobId} portfolio...`);
        try {
            const p = panels.portfolio;
            result.portfolio = await deps.portfolioService.simulateFromJob(jobId, {
                capital: p.capital || 100000000,
                riskPct: p.riskPct || 1.5,
                maxSymPct: p.maxSymPct || 20,
                maxTotalPct: p.maxTotalPct || 50,
                maxClusterPct: p.maxClusterPct || 30,
                maxSectorPct: p.maxSectorPct || 40,
                useDuplicateGuard: p.useDuplicateGuard !== false,
                useKelly: p.useKelly !== false,
                useCorrelation: p.useCorrelation !== false,
                useSectors: p.useSectors !== false,
                useSignalFilter: p.useSignalFilter !== false,
                useRegime: p.useRegime !== false,
                useSignalScore: p.useSignalScore !== false,
                filterMode: 'pair',
                minPairPF: 2.0,
                minTrades: panels.analysis ? (panels.analysis.minTrades || 5) : 5
            });
        } catch (e) {
            result.portfolio = { error: e.message };
        }
    }

    // ---- Auto-Config Suggestion ----
    result.autoConfigSuggestion = buildAutoConfigSuggestion(result, symbols);

    deps.logger && deps.logger.info(`[bt-compute] ${jobId} done`);
    return result;
}

// ------------------------------------------------------------
// Auto-Config Suggestion (فقط پیشنهاد، بدون ذخیره در DB)
// ------------------------------------------------------------
function buildAutoConfigSuggestion(result, symbolsInput) {
    const symbols = symbolsInput && symbolsInput.length
        ? symbolsInput
        : [...new Set((result.details || []).map(d => d.symbol))];

    const mode = result.mode || 'option';
    const suggestions = [];

    for (const sym of symbols) {
        const rows = (result.details || []).filter(d => d.symbol === sym);
        if (!rows.length) continue;

        const scored = rows.map(d => {
            const target = mode === 'stock'
                ? (d.stockStats || {})
                : (d.optionStats || d.stockStats || {});
            let pf = target.profitFactor;
            if (pf === null || pf === undefined || !Number.isFinite(pf)) pf = 0;
            const wr = target.winRate || 0;
            const n = target.count || 0;
            const score = pf * 0.4 + (wr / 100) * 0.3 + Math.min(n, 20) / 20 * 0.3;
            return { ...d, _pf: pf, _wr: wr, _n: n, _score: score };
        }).filter(d => d._n > 0)
          .sort((a, b) => b._score - a._score);

        if (!scored.length) {
            suggestions.push({
                symbol: sym, error: 'no valid candidates',
                allCandidates: []
            });
            continue;
        }

        const leader = scored[0];
        const confirmers = scored.slice(1, 3).filter(c => c._pf >= 1.0);

        suggestions.push({
            symbol: sym,
            leader: {
                strategyId: leader.strategyId,
                strategyName: leader.strategyName,
                timeframe: leader.timeframe,
                htfTimeframe: leader.htfTimeframe,
                pf: round2(leader._pf),
                wr: round2(leader._wr),
                n: leader._n,
                score: round2(leader._score)
            },
            confirmers: confirmers.map(c => ({
                strategyId: c.strategyId,
                strategyName: c.strategyName,
                timeframe: c.timeframe,
                htfTimeframe: c.htfTimeframe,
                pf: round2(c._pf),
                wr: round2(c._wr),
                n: c._n,
                score: round2(c._score)
            })),
            allCandidates: scored.map(s => ({
                strategyId: s.strategyId,
                strategyName: s.strategyName,
                timeframe: s.timeframe,
                htfTimeframe: s.htfTimeframe,
                pf: round2(s._pf),
                wr: round2(s._wr),
                n: s._n,
                score: round2(s._score)
            }))
        });
    }
    return suggestions;
}

function round2(v) {
    if (v === null || v === undefined || !Number.isFinite(v)) return null;
    return Math.round(v * 100) / 100;
}

// ------------------------------------------------------------
// Apply — کاربر انتخاب‌های خودش رو اعمال می‌کنه
// ------------------------------------------------------------
async function applySelections(jobId, selections) {
    const db = deps.getDB();
    const applied = [];

    for (const sel of (selections || [])) {
        const { symbol, pairs } = sel;
        if (!symbol || !Array.isArray(pairs) || !pairs.length) continue;

        // حذف configs قبلی نماد
        const old = await db.collection(COLLECTIONS.STRATEGY_CONFIGS)
            .find({ symbol }).toArray();
        const oldIds = old.map(o => o._id.toString());
        await db.collection(COLLECTIONS.STRATEGY_CONFIGS).deleteMany({ symbol });
        await db.collection(COLLECTIONS.SIGNALS_STATE).deleteMany({ configId: { $in: oldIds } });
        await deps.backtestService.constructor
            ? Promise.resolve()
            : Promise.resolve();

        let added = 0;
        const addedIds = [];

        for (const p of pairs) {
            const detail = await db.collection(COLLECTIONS.BACKTEST_COMPARE_DETAILS)
                .findOne({ jobId: String(jobId), symbol, strategyId: p.strategyId });
            if (!detail) continue;

            const STRATEGIES = require('../strategies').STRATEGIES;
            const def = STRATEGIES[p.strategyId];
            if (!def) continue;

            const doc = {
                symbol,
                strategyId: p.strategyId,
                timeframe: detail.timeframe || def.defaultTimeframe,
                htfTimeframe: detail.htfTimeframe || def.htfTimeframe || '1d',
                candleType: 'heikin',
                params: {
                    ...def.defaultParams,
                    ...(require('../settings').getStrategyDefaults(p.strategyId) || {})
                },
                enabled: true,
                role: p.role === 'confirmer' ? 'confirmer' : 'leader',
                autoConfigured: true,
                sourceJobId: String(jobId),
                trainedFrom: jobId ? null : null,
                trainedAt: new Date(),
                createdAt: new Date()
            };
            const r = await db.collection(COLLECTIONS.STRATEGY_CONFIGS).insertOne(doc);
            addedIds.push(String(r.insertedId));
            added++;
        }

        applied.push({ symbol, added, removedOld: old.length });
    }

    deps.logger && deps.logger.info(
        `apply: ${applied.length} symbols, ${applied.reduce((s, a) => s + a.added, 0)} configs`
    );
    return { ok: true, applied };
}

module.exports = { init, runBacktest, getResults, applySelections };