'use strict';
// ============================================================
// pipeline.service.js — Master Pipeline (Auto-Pilot)
// ============================================================
// همه مراحل تحلیل رو پشت سر هم اجرا می‌کنه
// ============================================================

const { ObjectId } = require('mongodb');
const { COLLECTIONS, JOB_TYPE } = require('../config/constants');

let deps = {
    getDB: null,
    logger: null,
    backtestService: null,
    analysisService: null,
    wfService: null,
    regimeService: null,
    portfolioService: null,
    notify: null
};
function init(d) { deps = { ...deps, ...d }; }

// ------------------------------------------------------------
// Master pipeline
// ------------------------------------------------------------
async function runMaster(jobId, opts = {}) {
    const db = deps.getDB();
    const log = (msg) => {
        deps.logger && deps.logger.info(`[pipeline ${jobId}] ${msg}`);
        // progress در job ذخیره کن
        db.collection(COLLECTIONS.BACKTEST_JOBS).updateOne(
            { _id: new ObjectId(jobId) },
            { $set: { 'progress.message': msg, updatedAt: new Date() } }
        ).catch(() => {});
    };

    const steps = [];
    const t0 = Date.now();

    try {
        // ============ Step 1: Backtest Compare ============
        log('مرحله ۱: بک تست همه ترکیب‌ها...');
        const t1 = Date.now();

        const symbols = opts.symbols || [];
        const strategies = opts.strategies || [];

        if (!symbols.length || !strategies.length) {
            throw new Error('symbols و strategies الزامی');
        }

        const btJob = await deps.backtestService.createJob('backtest-compare', {
            symbols, strategies,
            useRealOption: opts.useRealOption !== false,
            dateFrom: opts.dateFrom,
            dateTo: opts.dateTo
        }, symbols.map(s => ({ label: s, items: [s] })));

        // Process queue و منتظر موندن
        await deps.backtestService.processQueue();

        // نتیجه رو از job خودش بگیر
        const btDone = await db.collection(COLLECTIONS.BACKTEST_JOBS)
            .findOne({ _id: btJob._id });

        if (!btDone || btDone.status !== 'DONE') {
            throw new Error('backtest-compare ناموفق: ' + (btDone ? btDone.status : 'unknown'));
        }
        const btJobId = String(btJob._id);
        steps.push({ name: 'backtest_compare', jobId: btJobId, ms: Date.now() - t1, status: 'ok' });

        // ============ Step 2: Analysis ============
        log('مرحله ۲: تحلیل آماری (Bootstrap CI)...');
        const t2 = Date.now();
        const analysis = await deps.analysisService.analyzeJob(btJobId, {
            minTrades: opts.minTrades || 5,
            iterations: opts.iterations || 3000
        });
        steps.push({
            name: 'analysis',
            ms: Date.now() - t2,
            status: 'ok',
            analyzed: analysis.totalAnalyzed,
            passing: analysis.passing
        });

        // ============ Step 3: WF Aggregate ============
        log('مرحله ۳: اعتبارسنجی زمانی (Walk-Forward)...');
        const t3 = Date.now();
        let wf = null;
        try {
            // اول signal_whitelist رو بساز
            await deps.signalFilterService.buildAndSaveWhitelist(btJobId, {
                filterMode: 'pair',
                minPairPF: opts.minPairPF || 2.0,
                minPairTrades: opts.minPairTrades || 5,
                minPairLB: opts.minPairLB || 1.0
            });
            // بعد WF
            wf = await deps.wfService.runAggregate(btJobId, {
                numWindows: 4,
                minTrades: opts.minTrades || 5,
                numTrials: opts.numTrials || 234
            });
            steps.push({
                name: 'walk_forward',
                ms: Date.now() - t3,
                status: 'ok',
                passing: wf.passingPairs,
                strategies: wf.wfWhitelistSaved ? wf.wfWhitelistSaved.passingStrategies : []
            });
        } catch (e) {
            steps.push({ name: 'walk_forward', ms: Date.now() - t3, status: 'failed', error: e.message });
        }

        // ============ Step 4: Regime Refresh ============
        log('مرحله ۴: رفرش رژیم بازار...');
        const t4 = Date.now();
        let regimes = [];
        try {
            regimes = await deps.regimeService.refreshAll();
            steps.push({
                name: 'regime_refresh',
                ms: Date.now() - t4,
                status: 'ok',
                symbols: regimes.length
            });
        } catch (e) {
            steps.push({ name: 'regime_refresh', ms: Date.now() - t4, status: 'failed', error: e.message });
        }

        // ============ Step 5: Auto-Config روی کاندیدها ============
        log('مرحله ۵: انتخاب بهترین‌ها و اعمال...');
        const t5 = Date.now();
        const applied = [];
        try {
            // کاندیدهایی که WF passing + analysis passing
            const wfStrats = new Set(
                wf && wf.wfWhitelistSaved && wf.wfWhitelistSaved.passingStrategies
                    ? wf.wfWhitelistSaved.passingStrategies
                    : []
            );

            // از analysis نتایج، pairهای برنده رو بگیر
            const details = await db.collection(COLLECTIONS.BACKTEST_COMPARE_DETAILS)
                .find({ jobId: btJobId }).toArray();

            // برای هر نماد، بهترین pair رو انتخاب کن که:
            //   - strategy در wfStrats باشه (اگه wf داریم)
            //   - PF آپشن > 2
            //   - N >= 5
            const bySymbol = {};
            for (const d of details) {
                if (!d.trades || d.trades.length < (opts.minTrades || 5)) continue;
                if (wfStrats.size > 0 && !wfStrats.has(d.strategyId)) continue;

                const pnls = d.trades.map(t => t.pnlPct).filter(Number.isFinite);
                const wins = pnls.filter(x => x > 0);
                const losses = pnls.filter(x => x <= 0);
                const gp = wins.reduce((s, x) => s + x, 0);
                const gl = -losses.reduce((s, x) => s + x, 0);
                const pf = gl > 0 ? gp / gl : (gp > 0 ? 999 : 0);

                if (pf < (opts.minPF || 2.0)) continue;

                if (!bySymbol[d.symbol]) bySymbol[d.symbol] = [];
                bySymbol[d.symbol].push({
                    strategyId: d.strategyId,
                    strategyName: d.strategyName,
                    timeframe: d.timeframe,
                    htfTimeframe: d.htfTimeframe,
                    tradesCount: d.trades.length,
                    pf,
                    winRate: wins.length / pnls.length * 100,
                    avgPnl: pnls.reduce((s, x) => s + x, 0) / pnls.length,
                    // برای applyAutoConfig
                    stock: { count: d.trades.length, winRate: wins.length / pnls.length * 100, totalPnl: pnls.reduce((s, x) => s + x, 0) },
                    option: { count: d.trades.length, winRate: wins.length / pnls.length * 100, profitFactor: pf, totalPnl: pnls.reduce((s, x) => s + x, 0), avgPnl: pnls.reduce((s, x) => s + x, 0) / pnls.length }
                });
            }

            // برای هر نماد، بهترین pair رو leader، بعدی‌ها رو confirmer
            const plans = [];
            for (const [symbol, candidates] of Object.entries(bySymbol)) {
                candidates.sort((a, b) => b.pf - a.pf);
                const leader = candidates[0];
                const confirmers = candidates.slice(1, 1 + (opts.maxConfirmers || 2));
                plans.push({ symbol, leader, confirmers, allResults: candidates });
            }

            if (plans.length) {
                const applyResult = await deps.backtestService.applyAutoConfig(plans, {
                    from: opts.dateFrom, to: opts.dateTo
                });
                applied.push(...applyResult);
            }
            steps.push({
                name: 'auto_config',
                ms: Date.now() - t5,
                status: 'ok',
                applied: applied.length,
                symbols: Object.keys(bySymbol)
            });
        } catch (e) {
            steps.push({ name: 'auto_config', ms: Date.now() - t5, status: 'failed', error: e.message });
        }

        // ============ Step 6: Portfolio Sim ============
        log('مرحله ۶: شبیه‌سازی نهایی پرتفولیو...');
        const t6 = Date.now();
        let sim = null;
        try {
            sim = await deps.portfolioService.simulateFromJob(btJobId, {
                capital: opts.capital || 100_000_000,
                riskPct: opts.riskPct || 2.0,
                useSignalFilter: true,
                useRegime: true,
                useSignalScore: true,
                filterMode: 'pair',
                minPairPF: opts.minPF || 2.0,
                minTrades: opts.minTrades || 5
            });
            steps.push({
                name: 'portfolio_sim',
                ms: Date.now() - t6,
                status: 'ok',
                accepted: sim.acceptedTrades,
                returnPct: sim.stats.totalReturnPct,
                maxDD: sim.stats.maxDD,
                pf: sim.stats.profitFactor,
                sharpe: sim.stats.sharpe
            });
        } catch (e) {
            steps.push({ name: 'portfolio_sim', ms: Date.now() - t6, status: 'failed', error: e.message });
        }

        // ============ گزارش نهایی ============
        const totalMs = Date.now() - t0;
        const summary = {
            jobId,
            btJobId,
            at: new Date(),
            totalMs,
            steps,
            // ملخص
            analysis: { total: analysis.totalAnalyzed, passing: analysis.passing },
            wf: wf ? { passing: wf.passingPairs, strategies: wf.wfWhitelistSaved ? wf.wfWhitelistSaved.passingStrategies : [] } : null,
            regimes: { total: regimes.length },
            applied: applied.length,
            portfolio: sim ? {
                accepted: sim.acceptedTrades,
                totalTrades: sim.totalTrades,
                returnPct: sim.stats.totalReturnPct,
                maxDD: sim.stats.maxDD,
                pf: sim.stats.profitFactor,
                sharpe: sim.stats.sharpe
            } : null,
            // برنده‌ها
            winners: applied.filter(a => !a.error).map(a => ({
                symbol: a.symbol,
                leader: a.leader,
                leaderName: a.leaderName,
                confirmers: (a.confirmers || []).map(c => c.id || c)
            }))
        };

        // نوتیفای
        if (deps.notify) {
            const lines = [
                `🎯 Pipeline کامل شد (${(totalMs/1000).toFixed(0)}s)`,
                `کاندید PASS تحلیل: ${analysis.passing}`,
                `WF استراتژی‌های برنده: ${(summary.wf?.strategies || []).join(', ') || '-'}`,
                `نمادهای تنظیم‌شده: ${applied.length}`,
                `بازده پورتفولیو: ${summary.portfolio?.returnPct?.toFixed(1) || '-'}%`,
                `MaxDD: ${summary.portfolio?.maxDD?.toFixed(1) || '-'}%`
            ];
            await deps.notify(lines.join('\n')).catch(() => {});
        }

        log(`✅ Pipeline تمام شد — ${applied.length} نماد`);
        return summary;

    } catch (e) {
        deps.logger && deps.logger.error(`[pipeline ${jobId}] FATAL: ${e.message}`);
        throw e;
    }
}

module.exports = { init, runMaster };