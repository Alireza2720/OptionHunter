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
    regimeService: null, portfolioService: null,
    notify: null   // 🆕 برای ارسال گزارش تلگرام
};
function init(d) { deps = { ...deps, ...d }; }

// ------------------------------------------------------------
// Strategy side filter — stock strategies are neutral (no side),
// so this is a passthrough. Kept as a stub so that callers don't
// crash when params.optionSide is set.
// ------------------------------------------------------------
function __filterBySide(strategies, strategiesAll, side) {
    if (!Array.isArray(strategies)) return strategies || [];
    if (!side || side === 'both') return strategies;
    // Current strategies are stock-level. Future option-side strategies
    // will carry `side: 'call'|'put'` metadata and be filtered here.
    return strategies;
}

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

    const __side = (params && params.optionSide) || "call";
    let __strategiesList = strategies;
    if (__side !== "both") {
        const __ALL = require("../strategies").STRATEGIES;
        __strategiesList = __filterBySide(strategies, __ALL, __side);
    }
    const chunks = symbols.map(s => ({ label: s, items: [s] }));
    const payload = {
        mode, symbols, strategies: __strategiesList,
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

    // compute خطا خورده → فقط اگر retry کم است دوباره شروع کن
    if (cached && cached.error && !cached.computing) {
        const _retryCount = cached.retryCount || 0;
        const MAX_RETRY = 3;
        if (_retryCount >= MAX_RETRY) {
            return { ...base, error: cached.error, retriesExhausted: true };
        }
        deps.logger && deps.logger.warn(`[bt-compute] ${jobId} retry ${_retryCount + 1}/${MAX_RETRY} after error`);
        await db.collection(COLLECTIONS.META).updateOne(
            { _id: cacheId },
            { $set: { retryCount: _retryCount + 1, computing: false }, $unset: { error: '' } }
        );
        computeInBackground(jobId).catch(e =>
            deps.logger && deps.logger.error('[bt-compute] ' + e.message));
        return { ...base, computing: true, computingFor: 0, retry: _retryCount + 1 };
    }

    // در حال compute → flag رو برگردون
    if (cached && cached.computing) {
        const elapsedMs = cached.startedAt
            ? Date.now() - new Date(cached.startedAt).getTime()
            : 0;
        const elapsed = Math.round(elapsedMs / 1000);

        // 🆕 اگه بیشتر از ۱۵ دقیقه از شروع گذشته و هنوز تموم نشده → stuck
        const STUCK_THRESHOLD_MS = 15 * 60 * 1000;
        if (elapsedMs > STUCK_THRESHOLD_MS) {
            deps.logger && deps.logger.warn(
                `[bt-compute] ${jobId} stuck for ${elapsed}s — restarting`
            );
            // پاک کردن flag و شروع مجدد
            await db.collection(COLLECTIONS.META).updateOne(
                { _id: cacheId },
                { $set: { computing: false, error: 'stuck — auto-restart' }, $unset: { startedAt: '' } }
            );
            computeInBackground(jobId).catch(e =>
                deps.logger && deps.logger.error('[bt-compute] ' + e.message));
            return { ...base, computing: true, computingFor: 0 };
        }

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

    // 🆕 وضعیت job رو به COMPUTING تغییر بده → تو فعالیت‌ها دیده بشه
    await db.collection(COLLECTIONS.BACKTEST_JOBS).updateOne(
        { _id: new ObjectId(jobId) },
        { $set: { status: 'COMPUTING', updatedAt: new Date() } }
    );

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

        const memGuard = require('../infra/memory-guard');
        const before = memGuard.getMemoryStatus();
        deps.logger && deps.logger.info(
            `[bt-compute] ${jobId} start | RSS=${before.processRssMB}MB | free=${before.systemFreeMB}MB`
        );

        const result = await computeFullResult(job, jobId);

        // 🆕 اگه result خیلی بزرگه، خلاصه‌اش کن
        const resultSizeMB = Buffer.byteLength(JSON.stringify(result), 'utf8') / 1048576;
        let savedResult = result;

        // اگه بیشتر از 5MB، trades رو از result حذف کن (توی details هستن)
        if (resultSizeMB > 5) {
            deps.logger && deps.logger.warn(
                `[bt-compute] ${jobId} result is ${resultSizeMB.toFixed(1)}MB — trimming trades from top-level`
            );
            savedResult = {
                ...result,
                details: (result.details || []).map(d => ({
                    ...d,
                    // trades رو نگه دار فقط برای 10 تا اول
                    trades: (d.trades || []).slice(0, 10),
                    _tradesTruncated: (d.trades || []).length > 10,
                    _totalTrades: (d.trades || []).length,
                })),
                _trimmed: true,
                _originalSizeMB: Math.round(resultSizeMB * 10) / 10,
            };
        }

        await db.collection(COLLECTIONS.META).updateOne(
            { _id: cacheId },
            { $set: { computing: false, result: savedResult, cachedAt: new Date() }, $unset: { startedAt: '' } }
        );

        // 🆕 پاکسازی صریح
        memGuard.maybeGC();
        const after = memGuard.getMemoryStatus();
        deps.logger && deps.logger.info(
            `[bt-compute] ${jobId} end | RSS=${after.processRssMB}MB | free=${after.systemFreeMB}MB`
        );

        // 🆕 بعد از اتمام محاسبه → DONE
        await db.collection(COLLECTIONS.BACKTEST_JOBS).updateOne(
            { _id: new ObjectId(jobId) },
            { $set: { status: 'DONE', updatedAt: new Date() } }
        );

        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        deps.logger && deps.logger.info(`[bt-compute] ${jobId} done in ${elapsed}s`);

        // 🆕 Telegram notify کامل
        try {
            await sendBacktestNotification(job, result, elapsed);
        } catch (notifyErr) {
            deps.logger && deps.logger.warn(`[bt-compute] notify failed: ${notifyErr.message}`);
        }
    } catch (e) {
        await db.collection(COLLECTIONS.META).updateOne(
            { _id: cacheId },
            { $set: { computing: false, error: e.message }, $unset: { startedAt: '' } }
        );

        // 🆕 خطا → FAILED
        await db.collection(COLLECTIONS.BACKTEST_JOBS).updateOne(
            { _id: new ObjectId(jobId) },
            { $set: { status: 'FAILED', error: e.message, updatedAt: new Date() } }
        );

        deps.logger && deps.logger.error(`[bt-compute] ${jobId} FAILED: ${e.message}`);

        // 🆕 Telegram error notify
        try {
            if (deps.notify) {
                await deps.notify(`❌ بک‌تست خطا خورد\n\nJob: ${jobId.slice(0,8)}\nخطا: ${e.message.slice(0, 200)}`);
            }
        } catch (_) {}
    }
}

// 🆕 Lock برای جلوگیری از notify تکراری
const _notifiedJobs = new Set();
const _MAX_NOTIFIED = 500;

function _markNotified(jobId) {
    _notifiedJobs.add(jobId);
    if (_notifiedJobs.size > _MAX_NOTIFIED) {
        const first = _notifiedJobs.values().next().value;
        _notifiedJobs.delete(first);
    }
}

// 🆕 ارسال گزارش کامل به تلگرام
async function sendBacktestNotification(job, result, elapsed) {
    if (!deps.notify) return;

    const jobId = String(job._id);
    if (_notifiedJobs.has(jobId)) {
        deps.logger && deps.logger.warn(`[bt-compute] ${jobId} already notified — skip`);
        return;
    }
    _markNotified(jobId);
    // 🆕 TTL تمیزکاری: بعد از ۱ ساعت حذف کن که حافظه نشتی نداشته باشیم
    setTimeout(() => _notifiedJobs.delete(jobId), 60 * 60 * 1000).unref?.();

    const mode = (job.payload && job.payload.mode) || 'option';
    const modeLabel = mode === 'stock' ? '📊 سهم پایه' : '🎯 آپشن';
    const symbols = (job.payload && job.payload.symbols) || [];
    const strategies = (job.payload && job.payload.strategies) || [];
    const details = (result.details || []);

    const targetKey = mode === 'stock' ? 'stockStats' : 'optionStats';

    // valid details
    const valid = details.filter(d => {
        const t = d[targetKey];
        return t && t.count > 0;
    });

    // 🆕 top 5 pairs — فقط با N>=20 (معناداری آماری)
    const meaningful = valid.filter(d => (d[targetKey] && d[targetKey].count || 0) >= 20);
    const sorted = [...meaningful].sort((a, b) => {
        const pa = (a[targetKey] && a[targetKey].profitFactor) || 0;
        const pb = (b[targetKey] && b[targetKey].profitFactor) || 0;
        return pb - pa;
    });
    const top = sorted.slice(0, 5);

    // آمار کل
    let totalTrades = 0;
    let totalWins = 0;
    for (const d of valid) {
        const t = d[targetKey];
        totalTrades += t.count || 0;
        totalWins += (t.count || 0) * (t.winRate || 0) / 100;
    }
    const winRate = totalTrades > 0 ? (totalWins / totalTrades * 100).toFixed(1) : '0';

    // Portfolio
    let portfolioLine = '';
    if (result.portfolio && !result.portfolio.error && result.portfolio.stats) {
        const p = result.portfolio.stats;
        portfolioLine =
            `\n💼 پورتفولیو:` +
            `\n   قبول/کل: ${result.portfolio.acceptedTrades || 0}/${result.portfolio.totalTrades || 0}` +
            `\n   بازده: ${p.totalReturnPct != null ? p.totalReturnPct.toFixed(1) : '-'}%` +
            `\n   MaxDD: ${p.maxDD != null ? p.maxDD.toFixed(1) : '-'}%` +
            `\n   PF: ${p.profitFactor != null ? p.profitFactor.toFixed(2) : '-'}` +
            `\n   Sharpe: ${p.sharpe != null ? p.sharpe.toFixed(2) : '-'}`;
    }

    // Analysis
    let analysisLine = '';
    if (result.analysis && !result.analysis.error) {
        analysisLine = `\n📈 تحلیل آماری: PASS=${result.analysis.passing || 0} از ${result.analysis.totalAnalyzed || 0}`;
    }

    // WF
    let wfLine = '';
    if (result.wf && !result.wf.error && result.wf.wfWhitelistSaved) {
        const s = result.wf.wfWhitelistSaved;
        wfLine = `\n🔬 WF برندگان: ${(s.passingStrategies || []).length}`;
    }

    // Top pairs
    let topLine = '\n🏆 برترین pairها:';
    for (let i = 0; i < top.length; i++) {
        const d = top[i];
        const t = d[targetKey];
        const pf = t.profitFactor != null ? (Number.isFinite(t.profitFactor) ? t.profitFactor.toFixed(2) : '∞') : '-';
        topLine += `\n   ${i+1}. ${d.symbol} / ${d.strategyName} | PF=${pf} N=${t.count || 0}`;
    }
    if (!top.length) topLine = '\n🏆 برنده‌ای نداشت';

    const text =
        `✅ بک‌تست کامل شد (${elapsed}s)\n` +
        `\n${modeLabel}` +
        `\n${symbols.length} نماد × ${strategies.length} استراتژی = ${symbols.length * strategies.length} ترکیب` +
        `\nمعتبر: ${valid.length} / ${details.length}` +
        `\nمیانگین WR: ${winRate}%` +
        `\nمجموع معاملات: ${totalTrades}` +
        topLine +
        portfolioLine +
        analysisLine +
        wfLine;

    await deps.notify(text);
    deps.logger && deps.logger.info(`[bt-compute] notify sent (${top.length} top pairs)`);
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
            'trades.delta': 1, 'trades.iv': 1, 'trades.source': 1, 'trades.exitReason': 1,
            'stockTrades.entryTime': 1, 'stockTrades.exitTime': 1, 'stockTrades.pnlPct': 1,
            'stockTrades.entryPrice': 1, 'stockTrades.exitPrice': 1,
            'stockTrades.entryFillTime': 1, 'stockTrades.exitFillTime': 1,
            'stockTrades.exitReason': 1, 'stockTrades.status': 1
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
            trades: (d.trades || []).slice(0, 200),
            stockTrades: (d.stockTrades || []).slice(0, 200)
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
            // 🆕 Historical regime distribution (per-symbol، نه رژیم امروز)
            const { computeHistoricalRegimeDistribution } = require('../core/regime-history');
            const allTrades = details.flatMap(d => (d.stockTrades || d.trades || []).map(t => ({ ...t, symbol: d.symbol })));
            const _bySym = {};
            for (const t of allTrades) {
                if (!_bySym[t.symbol]) _bySym[t.symbol] = [];
                _bySym[t.symbol].push(t);
            }
            const symbolRegimes = {};
            for (const [sym, trs] of Object.entries(_bySym)) {
                const dc = await deps.dataService.getCandles(sym, '1d').catch(() => []);
                if (dc && dc.length >= 50) {
                    symbolRegimes[sym] = computeHistoricalRegimeDistribution(trs, dc);
                }
            }
            const _aggCounts = { bull: 0, bear: 0, range: 0, unknown: 0 };
            let _aggTotal = 0;
            for (const r of Object.values(symbolRegimes)) {
                if (!r || !r.distribution) continue;
                for (const [k, v] of Object.entries(r.distribution)) {
                    _aggCounts[k] = (_aggCounts[k] || 0) + (v.count || 0);
                }
                _aggTotal += r.totalTrades || 0;
            }
            const _aggDist = {};
            for (const [k, v] of Object.entries(_aggCounts)) {
                _aggDist[k] = { count: v, pct: _aggTotal > 0 ? Math.round(v / _aggTotal * 1000) / 10 : 0 };
            }
            result.regimes = {
                distribution: _aggDist,
                totalTrades: _aggTotal,
                dominantRegime: Object.entries(_aggCounts).sort((a,b) => b[1]-a[1])[0][0],
                perSymbol: symbolRegimes
            };
        } catch (e) {
            result.regimes = [];
        }
    }

    // ---- Portfolio ----
    if (panels.portfolio && panels.portfolio.enabled) {
        deps.logger && deps.logger.info(`[bt-compute] ${jobId} portfolio (${mode})...`);
        try {
            const p = panels.portfolio;
            result.portfolio = await deps.portfolioService.simulateFromJob(jobId, {
                mode,   // 🆕
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

    // ---- Losing strategies (aggregate) ----
    try {
        const _losers = computeLosingStrategies(details, mode);
        result._losingStrategies = _losers.losers;
        result._strategyAgg = _losers.agg;
    } catch (_) {
        result._losingStrategies = new Set();
        result._strategyAgg = {};
    }

    // ---- Date range days (for dynamic min trades) ----
    try {
        const p = job.payload || {};
        const _from = p.dateFrom ? parseInt(p.dateFrom) : null;
        const _to   = p.dateTo   ? parseInt(p.dateTo)   : null;
        result._dateRangeDays = (_from && _to) ? Math.round((_to - _from) / 86400) : 180;
    } catch (_) {
        result._dateRangeDays = 180;
    }

    // ---- Auto-Config Suggestion ----
    result.autoConfigSuggestion = buildAutoConfigSuggestion(result, symbols);


    // 🆕 Compare to previous PF and alert on drop
    try {
        const _prevDoc = await deps.getDB().collection(COLLECTIONS.META).findOne({ _id: 'last_backtest_pf' });
        if (_prevDoc && Number.isFinite(_prevDoc.pf) && _prevDoc.pf > 0) {
            const _newPf = (result.portfolio && result.portfolio.stats && result.portfolio.stats.profitFactor) || null;
            if (_newPf != null && _newPf < _prevDoc.pf * 0.7) {
                const _drop = ((1 - _newPf / _prevDoc.pf) * 100).toFixed(0);
                if (deps.notify) {
                    await deps.notify('هشدار افت عملکرد بک‌تست\nPF قبلی: ' + _prevDoc.pf.toFixed(2) + '\nPF جدید: ' + _newPf.toFixed(2) + '\nافت: ' + _drop + '%\nJob: ' + jobId).catch(() => {});
                }
                deps.logger && deps.logger.warn('backtest PF dropped by ' + _drop + '%');
            }
        }
    } catch (e) {
        deps.logger && deps.logger.warn('pf drop alert: ' + e.message);
    }

    // 🆕 ذخیره‌ی PF در meta حتی بدون portfolio
    try {
        const db = deps.getDB();
        let pf = null;
        let maxDD = null;
        let sharpe = null;
        let returnPct = null;

        if (result.portfolio && !result.portfolio.error && result.portfolio.stats) {
            pf = result.portfolio.stats.profitFactor;
            maxDD = result.portfolio.stats.maxDD;
            sharpe = result.portfolio.stats.sharpe;
            returnPct = result.portfolio.stats.totalReturnPct;
        } else {
            // aggregate PF از details
            let gp = 0, gl = 0;
            for (const d of (result.details || [])) {
                const t = d.optionStats || d.stockStats || {};
                const n = t.count || 0;
                const wr = (t.winRate || 0) / 100;
                const wins = n * wr;
                const losses = n - wins;
                gp += wins * Math.abs(t.avgWin || 0);
                gl += losses * Math.abs(t.avgLoss || 0);
            }
            pf = gl > 0 ? gp / gl : (gp > 0 ? 999 : null);
        }

        if (pf != null && Number.isFinite(pf)) {
            await db.collection(COLLECTIONS.META).updateOne(
                { _id: 'last_backtest_pf' },
                { $set: {
                    pf, maxDD, sharpe, returnPct,
                    jobId: String(jobId),
                    mode: result.mode || 'option',
                    totalTrades: (result.details || []).reduce((s, d) => s + ((d.optionStats && d.optionStats.count) || 0), 0),
                    recordedAt: new Date()
                } },
                { upsert: true }
            );
            deps.logger && deps.logger.info(`[bt-compute] last_backtest_pf saved: ${pf.toFixed(2)}`);
        }
    } catch (e) {
        deps.logger && deps.logger.warn(`[bt-compute] save last_backtest_pf: ${e.message}`);
    }

    deps.logger && deps.logger.info(`[bt-compute] ${jobId} done`);
    return result;
}

// ------------------------------------------------------------
// Auto-Config Suggestion (فقط پیشنهاد، بدون ذخیره در DB)
// ------------------------------------------------------------
function getDynamicMinTrades(days) {
    const d = Number.isFinite(days) ? days : 180;
    if (d < 90)  return 3;
    if (d < 180) return 5;
    if (d < 365) return 8;
    if (d < 730) return 15;
    return 20;
}

function computeLosingStrategies(details, mode) {
    // Per-pair loser detection: a strategy is only marked as loser for
    // a SPECIFIC symbol if that pair has enough trades and negative PnL.
    // This avoids nuking a strategy globally because it lost on one symbol.
    const LOSS_THRESHOLD_N = 30;
    const agg = {};
    const pairs = {};

    for (const d of details) {
        const t = (mode === 'stock') ? (d.stockStats || {}) : (d.optionStats || d.stockStats || {});
        const sid = d.strategyId;
        const sym = d.symbol;
        if (!sid || !sym) continue;

        if (!agg[sid]) agg[sid] = { totalPnl: 0, totalN: 0 };
        agg[sid].totalPnl += t.totalPnl || 0;
        agg[sid].totalN += t.count || 0;

        const key = sym + '::' + sid;
        pairs[key] = {
            totalPnl: t.totalPnl || 0,
            totalN: t.count || 0,
            symbol: sym,
            strategyId: sid,
            strategyName: d.strategyName,
        };
    }

    const losers = new Set();
    for (const [key, a] of Object.entries(pairs)) {
        if (a.totalN >= LOSS_THRESHOLD_N && a.totalPnl < 0) {
            losers.add(key);
        }
    }
    return { losers, agg, pairs };
}

function buildAutoConfigSuggestion(result, symbolsInput) {
    const symbols = symbolsInput && symbolsInput.length
        ? symbolsInput
        : [...new Set((result.details || []).map(d => d.symbol))];

    const mode = result.mode || 'option';
    const suggestions = [];

    for (const sym of symbols) {
        const rows = (result.details || []).filter(d => d.symbol === sym);
        if (!rows.length) continue;

        // In option mode, option coverage is inherently partial (~30-80%).
        // Use a lower dynMin so auto-config doesn't reject every candidate.
        const baseDyn = getDynamicMinTrades(result._dateRangeDays || 180);
        const dynMin = mode === 'stock'
            ? baseDyn
            : Math.max(2, Math.round(baseDyn * 0.35));
        const losingSet = result._losingStrategies instanceof Set ? result._losingStrategies : new Set();
        const scored = rows.map(d => {
            const target = mode === 'stock' ? (d.stockStats || {}) : (d.optionStats || d.stockStats || {});
            let pf = target.profitFactor;
            if (pf === null || pf === undefined || !Number.isFinite(pf)) pf = 0;
            const wr = target.winRate || 0;
            const n = target.count || 0;
            const nScore = Math.min(Math.log10(Math.max(n, 1)) / Math.log10(200), 1.2);
            const pfScore = Math.min(pf, 5) / 5;
            const wrScore = wr / 100;
            const score = nScore * 0.55 + pfScore * 0.30 + wrScore * 0.15;
            // pairs_spread needs explicit pairSymbol; sector_momentum needs peer context
            const needsContext = (d.strategyId === 'pairs_spread' && !d.pairSymbol);
            const applicable = !needsContext;
            // Per-pair loser key
            const isLoser = losingSet.has(sym + '::' + d.strategyId);
            return { ...d, _pf: pf, _wr: wr, _n: n, _score: score, _applicable: applicable, _loser: isLoser };
        }).filter(d => d._n >= dynMin && d._applicable && !d._loser && d._pf >= 1.0)
          .sort((a, b) => b._score - a._score);

        if (!scored.length) {
            // Provide detailed reason why no candidates passed
            const all = rows.map(d => {
                const target = mode === 'stock' ? (d.stockStats || {}) : (d.optionStats || d.stockStats || {});
                const n = target.count || 0;
                const pf = Number.isFinite(target.profitFactor) ? target.profitFactor : 0;
                const reasons = [];
                if (n < dynMin) reasons.push(`N=${n} < ${dynMin}`);
                if (pf < 1.0) reasons.push(`PF=${pf.toFixed(2)} < 1`);
                if (losingSet.has(sym + '::' + d.strategyId)) reasons.push('pair total PnL negative');
                return { strategyId: d.strategyId, strategyName: d.strategyName, n, pf, reasons };
            });
            suggestions.push({
                symbol: sym, error: `no valid candidates (dynMin=${dynMin})`,
                allCandidates: all
            });
            continue;
        }

        const leader = scored[0];
        const confirmers = scored.slice(1, 1 + (result._maxConfirmers || 2)).filter(c => c._pf >= 1.0);

        suggestions.push({
            symbol: sym,
            leader: {
                strategyId: leader.strategyId,
                pairSymbol: leader.pairSymbol || null,   // 🆕
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
                pairSymbol: c.pairSymbol || null,   // 🆕
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
                pairSymbol: s.pairSymbol || null,   // 🆕
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

    // 🆕 Archive current configs before overwriting
    try {
        const _archiveCol = 'strategy_configs_archive';
        const _currentConfigs = await db.collection(COLLECTIONS.STRATEGY_CONFIGS).find({}).toArray();
        if (_currentConfigs.length) {
            await db.collection(_archiveCol).insertOne({
                archivedAt: new Date(),
                reason: 'apply-selections',
                jobId: String(jobId),
                count: _currentConfigs.length,
                configs: _currentConfigs
            });
            deps.logger && deps.logger.info('archived ' + _currentConfigs.length + ' configs before apply-selections');
        }
    } catch (e) {
        deps.logger && deps.logger.warn('config archive failed: ' + e.message);
    }

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

        let added = 0;
        const addedIds = [];

        for (const p of pairs) {
            const detail = await db.collection(COLLECTIONS.BACKTEST_COMPARE_DETAILS)
                .findOne({ jobId: String(jobId), symbol, strategyId: p.strategyId });
            if (!detail) continue;

            const STRATEGIES = require('../strategies').STRATEGIES;
            const def = STRATEGIES[p.strategyId];
            if (!def) continue;

            // 🆕 pairs_spread نیاز به pairSymbol داره
            const pairSymbol = detail.pairSymbol || p.pairSymbol || null;
            if (p.strategyId === 'pairs_spread' && !pairSymbol) {
                deps.logger && deps.logger.warn(
                    `apply: pairs_spread برای ${symbol} بدون pairSymbol — رد شد`
                );
                continue;
            }

            const doc = {
                symbol,
                pairSymbol,   // 🆕
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
                trainedFrom: null,
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