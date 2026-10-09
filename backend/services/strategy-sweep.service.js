'use strict';
// ============================================================
// strategy-sweep.service.js — parameter sweep (R23)
// ============================================================
// برای هر استراتژی، ۳ پارامتر کلیدی × ۱۰ مقدار = ۳۰ ترکیب
// بهترین ترکیب بر اساس PF^0.75 × N^0.25 انتخاب می‌شود
// ============================================================

const { ObjectId } = require('mongodb');
const { COLLECTIONS } = require('../config/constants');
const memGuard = require('../infra/memory-guard');
const marketHours = require('../infra/market-hours');

let deps = { getDB: null, logger: null, backtest: null, strategies: null };
function init(d) { deps = { ...deps, ...d }; }

// ۳ پارامتر کلیدی هر استراتژی
const SWEEP_PARAMS = {
    smc_unicorn:              ['swingLength', 'atrMult', 'tp1R'],
    smc_unicorn_pro:          ['swingLength', 'atrMult', 'tp1R'],
    ob_sweep:                 ['swingLength', 'atrMult', 'minSweepPct'],
    ob_sweep_pro:             ['swingLength', 'atrMult', 'minSweepPct'],
    ob_after_sweep:           ['swingLength', 'atrMult', 'sweepWithinBars'],
    ob_after_sweep_pro:       ['swingLength', 'atrMult', 'sweepWithinBars'],
    tsmom:                    ['lookbackDays', 'targetVol', 'atrMult'],
    tsmom_pro:                ['lookbackDays', 'targetVol', 'atrMult'],
    momentum_12_1:            ['lookbackMonths', 'atrMult', 'tp1R'],
    momentum_12_1_pro:        ['lookbackMonths', 'atrMult', 'tp1R'],
    donchian:                 ['entryPeriod', 'exitPeriod', 'atrMult'],
    donchian_pro:             ['entryPeriod', 'exitPeriod', 'atrMult'],
    low_vol_anomaly:          ['volWindow', 'volPct', 'atrMult'],
    low_vol_anomaly_pro:      ['volWindow', 'volPct', 'atrMult'],
    short_term_reversal:      ['lookbackDays', 'dropPct', 'atrMult'],
    short_term_reversal_pro:  ['lookbackDays', 'dropPct', 'atrMult'],
    sector_momentum:          ['momentumLookback', 'atrMult', 'tp1R'],
};

const MULTIPLIERS = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75];

function computeScore(pf, n) {
    if (!Number.isFinite(pf) || pf <= 0) return 0;
    if (!n || n < 5) return 0;
    return Math.pow(pf, 0.75) * Math.pow(n, 0.25);
}

async function _isCancelled(jobId) {
    try {
        const j = await deps.getDB().collection(COLLECTIONS.BACKTEST_JOBS)
            .findOne({ _id: new ObjectId(jobId) }, { projection: { cancelRequested: 1, status: 1 } });
        return !!(j && (j.cancelRequested || j.status === 'CANCELLED'));
    } catch (_) { return false; }
}

async function _runOneBacktest(cfg, dateFrom, dateTo, mode) {
    try {
        const result = await deps.backtest.runBacktest(cfg, dateFrom, dateTo, {
            mode: mode === 'stock' ? 'stock' : 'option',
            useRealOption: mode === 'option',
            lightMode: true,
            autoDetectTarget: false,
        });
        let stats = null;
        if (mode === 'stock') stats = result.stockStats || {};
        else stats = result.optionStats || result.stats || {};
        const pf = Number.isFinite(stats.profitFactor) ? stats.profitFactor
            : (stats.totalPnl > 0 ? 5 : 0);
        const n = stats.count || 0;
        return { pf, n, score: computeScore(pf, n) };
    } catch (e) {
        deps.logger && deps.logger.warn('sweep bt: ' + e.message);
        return { pf: 0, n: 0, score: 0, error: e.message };
    }
}

async function _sweepOneStrategy(jobId, symbol, strategyId, dateFrom, dateTo, mode, progressCb) {
    const def = deps.strategies.STRATEGIES[strategyId];
    if (!def) return null;
    const params = SWEEP_PARAMS[strategyId];
    if (!params || !params.length) return null;

    const baseParams = { ...def.defaultParams };
    const results = [];

    // Execute each combo — 3 params × 10 mults = 30
    for (const param of params) {
        const base = Number(baseParams[param]);
        if (!Number.isFinite(base) || base === 0) continue;
        for (const mult of MULTIPLIERS) {
            if (await _isCancelled(jobId)) throw new Error('CANCELLED_BY_USER');
            memGuard.maybeGC();

            const newVal = +(base * mult).toFixed(4);
            // skip trivial
            if (Math.abs(newVal - base) < 0.0001) {
                results.push({ param, mult, value: base, pf: 0, n: 0, score: 0, skipped: true });
                continue;
            }
            const testParams = { ...baseParams, [param]: newVal };

            const cfg = {
                symbol,
                strategyId,
                timeframe: def.defaultTimeframe,
                htfTimeframe: def.htfTimeframe || '1d',
                candleType: 'heikin',
                params: testParams,
            };
            const r = await _runOneBacktest(cfg, dateFrom, dateTo, mode);
            results.push({ param, mult, value: newVal, ...r });

            if (progressCb) progressCb({ param, mult, done: results.length, total: params.length * MULTIPLIERS.length });
        }
    }

    // baseline (current defaults)
    const baseCfg = {
        symbol,
        strategyId,
        timeframe: def.defaultTimeframe,
        htfTimeframe: def.htfTimeframe || '1d',
        candleType: 'heikin',
        params: baseParams,
    };
    const baseRes = await _runOneBacktest(baseCfg, dateFrom, dateTo, mode);

    // find best
    let best = { score: baseRes.score, pf: baseRes.pf, n: baseRes.n, params: { ...baseParams }, isBaseline: true };
    for (const r of results) {
        if (!r.score || r.score <= best.score) continue;
        best = {
            score: r.score,
            pf: r.pf,
            n: r.n,
            params: { ...baseParams, [r.param]: r.value },
            isBaseline: false,
            changed: { param: r.param, from: baseParams[r.param], to: r.value, mult: r.mult },
        };
    }

    return {
        strategyId,
        mode,
        baseline: { pf: baseRes.pf, n: baseRes.n, score: baseRes.score },
        best,
        allResults: results,
    };
}

async function runSweep(jobId, opts) {
    const db = deps.getDB();
    const symbols = Array.isArray(opts.symbols) ? opts.symbols : [];
    const strategies = Array.isArray(opts.strategies) ? opts.strategies : [];
    const modes = Array.isArray(opts.modes) && opts.modes.length ? opts.modes : ['stock'];
    const dateFrom = opts.dateFrom ? parseInt(opts.dateFrom) : null;
    const dateTo = opts.dateTo ? parseInt(opts.dateTo) : null;

    if (!symbols.length || !strategies.length) throw new Error('symbols/strategies empty');

    const check = memGuard.canStartHeavyJob();
    if (!check.ok) throw new Error('memory: ' + check.reason);

    const _total = symbols.length * strategies.length * modes.length * 3 * 10;
    let _done = 0;
    const results = [];

    deps.logger && deps.logger.info('[sweep ' + jobId + '] start: ' + symbols.length + ' sym × ' + strategies.length + ' strat × ' + modes.length + ' modes');

    for (const mode of modes) {
        for (const strategyId of strategies) {
            for (const symbol of symbols) {
                if (await _isCancelled(jobId)) throw new Error('CANCELLED_BY_USER');
                if (marketHours.isMarketOpen()) {
                    deps.logger && deps.logger.info('[sweep ' + jobId + '] paused (market open)');
                    await new Promise(r => setTimeout(r, 60000));
                    if (marketHours.isMarketOpen()) continue;
                }
                const t0 = Date.now();
                try {
                    const r = await _sweepOneStrategy(jobId, symbol, strategyId, dateFrom, dateTo, mode,
                        (p) => {
                            _done++;
                            if (_done % 20 === 0) {
                                db.collection(COLLECTIONS.BACKTEST_JOBS).updateOne(
                                    { _id: new ObjectId(jobId) },
                                    { $set: {
                                        'progress.current': _done,
                                        'progress.total': _total,
                                        'progress.message': symbol + '/' + strategyId + ' — ' + _done + '/' + _total,
                                        updatedAt: new Date(),
                                    } }
                                ).catch(() => {});
                            }
                        });
                    if (r) results.push(r);
                } catch (e) {
                    if (String(e.message).includes('CANCELLED')) throw e;
                    deps.logger && deps.logger.warn('[sweep] ' + symbol + '/' + strategyId + ': ' + e.message);
                }
                deps.logger && deps.logger.info('[sweep ' + jobId + '] ' + mode + ' ' + symbol + '/' + strategyId + ' in ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
            }
        }
    }

    // Aggregate per strategy per mode: best params across all symbols
    const byStrategy = {};
    for (const r of results) {
        const key = r.strategyId + '::' + r.mode;
        if (!byStrategy[key]) byStrategy[key] = { strategyId: r.strategyId, mode: r.mode, items: [] };
        byStrategy[key].items.push(r);
    }
    const finalMap = {};
    for (const [key, group] of Object.entries(byStrategy)) {
        // Average scores per candidate params across symbols
        const paramAgg = {};
        for (const item of group.items) {
            const bp = item.best;
            const pKey = JSON.stringify(bp.params);
            if (!paramAgg[pKey]) paramAgg[pKey] = { params: bp.params, scores: [], pfs: [], ns: [], isBaseline: bp.isBaseline, changed: bp.changed };
            paramAgg[pKey].scores.push(bp.score);
            paramAgg[pKey].pfs.push(bp.pf);
            paramAgg[pKey].ns.push(bp.n);
        }
        let best = null;
        for (const [k, v] of Object.entries(paramAgg)) {
            const avgScore = v.scores.reduce((s, x) => s + x, 0) / v.scores.length;
            if (!best || avgScore > best.avgScore) {
                best = {
                    params: v.params,
                    avgScore,
                    avgPf: v.pfs.reduce((s, x) => s + x, 0) / v.pfs.length,
                    avgN: v.ns.reduce((s, x) => s + x, 0) / v.ns.length,
                    isBaseline: v.isBaseline,
                    changed: v.changed,
                    symbolCount: v.scores.length,
                };
            }
        }
        if (!finalMap[group.strategyId]) finalMap[group.strategyId] = {};
        finalMap[group.strategyId][group.mode] = best;
    }

    const summary = {};
    for (const [sid, byMode] of Object.entries(finalMap)) {
        if (modes.length === 1) {
            const m = modes[0];
            summary[sid] = byMode[m];
        } else {
            // combined: average weighted score
            const entries = Object.values(byMode);
            const avgScore = entries.reduce((s, x) => s + x.avgScore, 0) / entries.length;
            // pick params from best mode by score
            const winner = entries.reduce((a, b) => (a.avgScore >= b.avgScore ? a : b));
            summary[sid] = { ...winner, avgScore, modes: Object.keys(byMode) };
        }
    }

    return { summary, byStrategy: finalMap, totalRuns: results.length, modes };
}

module.exports = { init, runSweep, SWEEP_PARAMS, MULTIPLIERS };
