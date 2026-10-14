'use strict';
// ============================================================
// ga-orchestrator.service.js — main GA loop
// ============================================================
// One GA per strategy, TPE-sampled, walk-forward verified,
// pruned by median + permanent. State persisted per strategy.
// ============================================================

const { ObjectId } = require('mongodb');
const { COLLECTIONS } = require('../config/constants');
const fitness = require('./ga-fitness.service');
const wfMod = require('./ga-walk-forward.service');
const { TPESampler } = require('./ga-sampler.service');
const { MedianPruner, ParamPruner } = require('./ga-pruner.service');
const stopResume = require('./ga-stop-resume.service');

let deps = {
    getDB: null, logger: null, backtest: null,
    dataService: null, strategies: null, notify: null
};
function init(d) { deps = { ...deps, ...d }; }

const DEFAULTS = {
    maxGenerations: 30,
    trialsPerGeneration: 4,
    numWindows: 3,
    symbolsLimit: 0,   // 0 = all monitored symbols
    patience: 8,
    mode: 'both',
    lightMode: true,
    softMaxMinutes: 90,
    dateFrom: null,
    dateTo: null
};

const SPECIAL_RANGES = {
    swingLength: { type: 'int', min: 2, max: 8 },
    atrMult: { type: 'float', min: 0.8, max: 3.0, step: 0.1 },
    maxHoldBars: { type: 'int', min: 5, max: 60 },
    cooldownBars: { type: 'int', min: 0, max: 10 },
    minConfluence: { type: 'int', min: 1, max: 3 },
    minConditions: { type: 'int', min: 1, max: 3 },
    minSweepPct: { type: 'float', min: 0.01, max: 0.5, step: 0.01 },
    minBreakoutPct: { type: 'float', min: 0.1, max: 2.0, step: 0.05 },
    breakoutBufferPct: { type: 'float', min: 0.1, max: 2.0, step: 0.05 },
    minVolMult: { type: 'float', min: 1.0, max: 3.0, step: 0.1 },
    rsiEntry: { type: 'int', min: 15, max: 40 },
    rsiBuy: { type: 'int', min: 15, max: 40 },
    rsiExit: { type: 'int', min: 50, max: 80 },
    rsiSell: { type: 'int', min: 50, max: 80 },
    nrWindow: { type: 'int', min: 3, max: 15 },
    entryPeriod: { type: 'int', min: 10, max: 50 },
    exitPeriod: { type: 'int', min: 5, max: 30 },
    lookbackDays: { type: 'int', min: 60, max: 400 },
    lookbackMonths: { type: 'int', min: 3, max: 18 },
    contractionWindow: { type: 'int', min: 2, max: 6 },
    minPivotDistance: { type: 'int', min: 3, max: 12 },
    fvgMinGapPct: { type: 'float', min: 0.02, max: 0.3, step: 0.01 },
    minLiquiditySweepPct: { type: 'float', min: 0.02, max: 0.3, step: 0.01 },
    adxMin: { type: 'int', min: 15, max: 40 },
    adxPeriod: { type: 'int', min: 10, max: 20 },
    emaPeriod: { type: 'int', min: 10, max: 50 },
    kcMult: { type: 'float', min: 1.0, max: 3.0, step: 0.1 },
    maPeriod: { type: 'int', min: 10, max: 50 },
    fastMA: { type: 'int', min: 3, max: 15 },
    slowMA: { type: 'int', min: 30, max: 120 },
    rsiPeriod: { type: 'int', min: 7, max: 21 },
    volWindow: { type: 'int', min: 20, max: 120 },
    volPct: { type: 'float', min: 0.1, max: 0.5, step: 0.05 },
    dropPct: { type: 'float', min: -15, max: -3, step: 0.5 },
    minZScore: { type: 'float', min: 0.5, max: 3.0, step: 0.1 },
    atrPeriod: { type: 'int', min: 7, max: 21 },
    ltfLookback: { type: 'int', min: 10, max: 40 },
    htfLookback: { type: 'int', min: 30, max: 120 },
    atrPctThreshold: { type: 'int', min: 20, max: 50 },
    daysBeforeEOM: { type: 'int', min: 1, max: 5 },
    daysAfterBOM: { type: 'int', min: 1, max: 5 },
    sweepWithinBars: { type: 'int', min: 5, max: 25 },
    obLookback: { type: 'int', min: 5, max: 20 },
    momentumLookback: { type: 'int', min: 10, max: 40 },
    minBreakoutVolMult: { type: 'float', min: 1.2, max: 3.5, step: 0.1 },
    minSqueezeBars: { type: 'int', min: 3, max: 15 },
    minRangePct: { type: 'float', min: 0.1, max: 1.5, step: 0.05 },
    maxRangePct: { type: 'float', min: 1.5, max: 4.0, step: 0.1 }
};

function _buildSearchSpace(strategyId, defaults) {
    let KEY_PARAMS = {};
    try {
        KEY_PARAMS = require('./sensitivity.service').KEY_PARAMS || {};
    } catch (_) {}
    const kp = KEY_PARAMS[strategyId] || [];
    const space = {};
    for (const p of kp) {
        if (SPECIAL_RANGES[p]) { space[p] = Object.assign({}, SPECIAL_RANGES[p]); continue; }
        const v = defaults[p];
        if (!Number.isFinite(v)) continue;
        if (Number.isInteger(v)) {
            space[p] = { type: 'int', min: Math.max(1, Math.round(v * 0.5)), max: Math.round(v * 1.5) };
        } else {
            space[p] = { type: 'float', min: v * 0.6, max: v * 1.4, step: 0.01 };
        }
    }
    for (const p of ['atrMult', 'maxHoldBars', 'cooldownBars']) {
        if (Object.keys(space).length >= 5) break;
        if (space[p]) continue;
        if (SPECIAL_RANGES[p] && Number.isFinite(defaults[p])) {
            space[p] = Object.assign({}, SPECIAL_RANGES[p]);
        }
    }
    const keys = Object.keys(space).slice(0, 6);
    const out = {};
    for (const k of keys) out[k] = space[k];
    return out;
}

async function _evalParams(strategyId, params, symbols, opts) {
    const def = deps.strategies.STRATEGIES[strategyId];
    if (!def) return { error: 'unknown strategy', stats: null };
    const mergedParams = Object.assign({}, def.defaultParams, params);
    const mode = opts.mode || 'both';

    const perSymbol = [];
    const _CONCURRENCY = 2;

    const _evalOneMode = async (sym, m) => {
        const _cfg = {
            symbol: sym, strategyId: strategyId,
            timeframe: def.defaultTimeframe,
            htfTimeframe: def.htfTimeframe || '1d',
            candleType: 'heikin',
            params: mergedParams
        };
        try {
            const r = await wfMod.evaluate(_cfg, {
                backtest: deps.backtest,
                dateFrom: opts.dateFrom,
                dateTo: opts.dateTo,
                numWindows: opts.numWindows,
                mode: m,
                lightMode: opts.lightMode
            });
            if (r && r.stats && r.stats.totalTrades > 0) {
                return { symbol: sym, mode: m, stats: r.stats, windows: r.windows };
            }
        } catch (e) {
            deps.logger && deps.logger.warn('[ga] eval ' + sym + '/' + m + ': ' + e.message);
        }
        return null;
    };

    let _optCounts = {};
    if (mode === 'both') {
        const db = deps.getDB();
        const since = opts.dateFrom ? new Date(opts.dateFrom * 1000) : new Date(Date.now() - 365 * 86400 * 1000);
        const until = opts.dateTo ? new Date(opts.dateTo * 1000) : new Date();
        await Promise.all(symbols.map(async (s) => {
            try {
                _optCounts[s] = await db.collection('option_history').countDocuments({
                    underlying: s,
                    time: { $gte: since, $lte: until },
                    bid: { $gt: 0 }, ask: { $gt: 0 }
                });
            } catch (_) { _optCounts[s] = 0; }
        }));
    }

    const _evalSymbol = async (sym) => {
        const out = [];
        if (mode === 'stock') {
            const r = await _evalOneMode(sym, 'stock');
            if (r) out.push(r);
        } else if (mode === 'option') {
            const r = await _evalOneMode(sym, 'option');
            if (r) out.push(r);
        } else {
            const stockR = await _evalOneMode(sym, 'stock');
            const optCount = _optCounts[sym] || 0;
            const hasOption = optCount >= 30;
            if (stockR) {
                stockR.optWeight = hasOption ? 0.5 : 1.0;
                out.push(stockR);
            }
            if (hasOption) {
                const optR = await _evalOneMode(sym, 'option');
                if (optR) {
                    optR.optWeight = 0.5 * Math.min(1, optCount / 500);
                    optR.optCount = optCount;
                    out.push(optR);
                }
            }
        }
        return out;
    };

    for (let _i = 0; _i < symbols.length; _i += _CONCURRENCY) {
        const _batch = symbols.slice(_i, _i + _CONCURRENCY);
        const _res = await Promise.all(_batch.map(s => _evalSymbol(s)));
        for (const arr of _res) for (const r of arr) perSymbol.push(r);
    }

    if (!perSymbol.length) return { stats: null, fitness: 0, perSymbol: [] };

    // BUG-NEW-11 fix: separate raw N from weighted fitness
    let rawN = 0, rawWins = 0;
    let totalPnl = 0, gp = 0, gl = 0, profWin = 0, totWin = 0;
    let ddMax = 0; const sharpes = [];
    for (const x of perSymbol) {
        const s = x.stats;
        const weight = x.optWeight != null ? x.optWeight : 1.0;
        // Raw counts (unweighted) — for MIN_TRADES gate
        rawN += s.totalTrades;
        rawWins += s.totalTrades * s.winRate / 100;
        // Weighted totals — for fitness / PF
        totalPnl += s.totalPnl * weight;
        const w = s.totalTrades * s.winRate / 100;
        const l = s.totalTrades - w;
        if (Number.isFinite(s.grossWin) && Number.isFinite(s.grossLoss)) {
            gp += s.grossWin * weight;
            gl += s.grossLoss * weight;
        } else {
            gp += w * Math.abs(s.avgWin || 0) * weight;
            gl += l * Math.abs(s.avgLoss || 0) * weight;
        }
        profWin += (s.profitableWindows || 0) * weight;
        totWin += (s.windowsTotal || 0) * weight;
        if (Number.isFinite(s.maxDrawdownPct)) ddMax = Math.max(ddMax, s.maxDrawdownPct);
        if (Number.isFinite(s.sharpe)) sharpes.push(s.sharpe);
    }
    const merged = {
        totalTrades: Math.round(rawN),
        winRate: rawN > 0 ? rawWins / rawN * 100 : 0,
        totalReturnPct: totalPnl,
        totalPnl: totalPnl,
        profitFactor: gl > 0 ? gp / gl : (gp > 0 ? 999 : 0),
        sharpe: sharpes.length ? sharpes.reduce((a, b) => a + b, 0) / sharpes.length : null,
        maxDrawdownPct: ddMax,
        windowsProfitable: Math.round(profWin),
        windowsTotal: Math.round(totWin)
    };
    const _fit = fitness.computeFitness(merged);
    return { stats: merged, fitness: _fit, perSymbol: perSymbol };
}

async function _updateJobProgress(jobDbId, patch) {
    try {
        const db = deps.getDB();
        await db.collection(COLLECTIONS.BACKTEST_JOBS).updateOne(
            { _id: new ObjectId(jobDbId) },
            { $set: Object.assign({}, patch, { updatedAt: new Date() }) }
        );
    } catch (_) {}
}

async function _isCancelled(jobDbId) {
    try {
        const db = deps.getDB();
        const j = await db.collection(COLLECTIONS.BACKTEST_JOBS).findOne(
            { _id: new ObjectId(jobDbId) },
            { projection: { cancelRequested: 1, status: 1 } }
        );
        return !!(j && (j.cancelRequested || j.status === 'CANCELLED'));
    } catch (_) { return false; }
}

async function _runSingleStrategy(strategyId, jobDbId, opts) {
    const def = deps.strategies.STRATEGIES[strategyId];
    if (!def) {
        deps.logger && deps.logger.warn('[ga] skip ' + strategyId + ': unknown');
        return { strategyId: strategyId, error: 'unknown strategy' };
    }

    const space = _buildSearchSpace(strategyId, def.defaultParams);
    if (!Object.keys(space).length) {
        return { strategyId: strategyId, error: 'no search space' };
    }

    // FIX GA-12: only resume state if opts.resume === true
    const _isResume = opts.resume === true;
    const prev = _isResume ? await stopResume.loadState(deps.getDB, strategyId) : null;
    const sampler = prev && prev.tpeState
        ? TPESampler.import(prev.tpeState)
        : new TPESampler(space);
    sampler.space = space;
    const pruner = prev && prev.prunerState
        ? ParamPruner.import(prev.prunerState)
        : new ParamPruner(space);
    const medianPruner = new MedianPruner();

    let bestFitness = (prev && prev.best && prev.best.fitness) || 0;
    let bestParams = (prev && prev.best && prev.best.params) || Object.assign({}, def.defaultParams);
    let bestStats = (prev && prev.best && prev.best.stats) || null;
    let bestEquityCurve = (prev && prev.bestEquityCurve) || null;
    let generation = (prev && prev.generation) || 0;
    let patienceLeft = opts.patience;
    const t0 = Date.now();
    const softMs = opts.softMaxMinutes * 60 * 1000;

    // Load symbols
    const db = deps.getDB();
    const allSyms = await db.collection(COLLECTIONS.MONITORED_SYMBOLS).find({ enabled: true }).toArray();
    const HARD_SYMBOL_CAP = 30;
    let _limit = opts.symbolsLimit > 0 ? opts.symbolsLimit : allSyms.length;
    if (_limit > HARD_SYMBOL_CAP) {
        deps.logger && deps.logger.warn('[ga] hard-capping symbols to ' + HARD_SYMBOL_CAP + ' (requested ' + _limit + ')');
        _limit = HARD_SYMBOL_CAP;
    }
    const symbols = allSyms
        .map(s => s.symbol)
        .sort()
        .slice(0, _limit);
    if (!symbols.length) return { strategyId: strategyId, error: 'no symbols' };

    while (generation < opts.maxGenerations) {
        // -- check cancel
        if (await _isCancelled(jobDbId)) {
            await stopResume.saveState(deps.getDB, strategyId, {
                status: 'cancelled', generation: generation,
                best: { params: bestParams, fitness: bestFitness, stats: bestStats },
                bestEquityCurve: bestEquityCurve,
                tpeState: sampler.export(),
                prunerState: pruner.export()
            });
            return { strategyId: strategyId, cancelled: true };
        }

        // -- manual pause request
        try {
            const _st = await stopResume.loadState(deps.getDB, strategyId);
            if (_st && _st.pauseRequested) {
                const _savedOpts = { mode: opts.mode, maxGenerations: opts.maxGenerations, trialsPerGeneration: opts.trialsPerGeneration, numWindows: opts.numWindows, patience: opts.patience, symbolsLimit: opts.symbolsLimit, dateFrom: opts.dateFrom, dateTo: opts.dateTo, lightMode: opts.lightMode, softMaxMinutes: opts.softMaxMinutes };
                await stopResume.saveState(deps.getDB, strategyId, {
                    status: 'paused', generation: generation,
                    best: { params: bestParams, fitness: bestFitness, stats: bestStats },
                    bestEquityCurve: bestEquityCurve,
                    tpeState: sampler.export(),
                    prunerState: pruner.export(),
                    resumeAfter: null,
                    manualPause: true,
                    pauseRequested: false,
                    savedOpts: _savedOpts
                });
                deps.logger && deps.logger.info('[ga] manually paused ' + strategyId + ' at gen ' + generation);
                return { strategyId: strategyId, paused: true, manual: true };
            }
        } catch (_) {}

        // -- BUG-10: also check holiday
        let _isHoliday = false;
        try {
            const _hol = await deps.getDB().collection('meta').findOne({ _id: 'holiday' });
            if (_hol && _hol.date) {
                const _now = new Date();
                const _teh = new Date(_now.getTime() + 3.5 * 3600 * 1000);
                const _todayStr = _teh.getUTCFullYear() + '-' + String(_teh.getUTCMonth() + 1).padStart(2, '0') + '-' + String(_teh.getUTCDate()).padStart(2, '0');
                if (String(_hol.date) === _todayStr) _isHoliday = true;
            }
        } catch (_) {}

        // -- check market hours (skip if holiday)
        if (!_isHoliday && stopResume.isDangerWindow()) {
            const resumeAt = stopResume.nextSafeTime();
            const _savedOpts = { mode: opts.mode, maxGenerations: opts.maxGenerations, trialsPerGeneration: opts.trialsPerGeneration, numWindows: opts.numWindows, patience: opts.patience, symbolsLimit: opts.symbolsLimit, dateFrom: opts.dateFrom, dateTo: opts.dateTo, lightMode: opts.lightMode, softMaxMinutes: opts.softMaxMinutes };
            await stopResume.saveState(deps.getDB, strategyId, {
                status: 'paused', generation: generation,
                best: { params: bestParams, fitness: bestFitness, stats: bestStats },
                bestEquityCurve: bestEquityCurve,
                tpeState: sampler.export(),
                prunerState: pruner.export(),
                resumeAfter: resumeAt,
                savedOpts: _savedOpts
            });
            deps.logger && deps.logger.info('[ga] paused ' + strategyId + ' at gen ' + generation);
            return { strategyId: strategyId, paused: true, resumeAt: resumeAt };
        }

        // -- check soft budget
        if (Date.now() - t0 > softMs) {
            const _savedOptsB = { mode: opts.mode, maxGenerations: opts.maxGenerations, trialsPerGeneration: opts.trialsPerGeneration, numWindows: opts.numWindows, patience: opts.patience, symbolsLimit: opts.symbolsLimit, dateFrom: opts.dateFrom, dateTo: opts.dateTo, lightMode: opts.lightMode, softMaxMinutes: opts.softMaxMinutes };
            await stopResume.saveState(deps.getDB, strategyId, {
                status: 'paused', generation: generation,
                best: { params: bestParams, fitness: bestFitness, stats: bestStats },
                bestEquityCurve: bestEquityCurve,
                tpeState: sampler.export(),
                prunerState: pruner.export(),
                savedOpts: _savedOptsB
            });
            return { strategyId: strategyId, budgetOut: true };
        }

        try { require('../infra/memory-guard').maybeGC(); } catch (_) {}
        generation++;
        let genBest = bestFitness;
        const _bestAtGenStart = bestFitness;

        for (let t = 0; t < opts.trialsPerGeneration; t++) {
            const params = sampler.sample();
            const _toMs = 120000;
            let ev;
            try {
                ev = await Promise.race([
                    _evalParams(strategyId, params, symbols, opts),
                    new Promise((_, rej) => setTimeout(() => rej(new Error('eval timeout ' + _toMs + 'ms')), _toMs))
                ]);
            } catch (_te) {
                deps.logger && deps.logger.warn('[ga] trial timeout: ' + _te.message);
                sampler.addPoint(params, 0);
                continue;
            }

            if (!ev.stats) {
                sampler.addPoint(params, 0);
                continue;
            }

            // Pruner update
            pruner.report(params, ev.fitness);

            // BUG-1 fix: also track for median pruning
            const _medianBad = medianPruner.shouldPrune(t, ev.fitness);
            if (!(_medianBad && sampler.history.length >= 15)) {
                sampler.addPoint(params, ev.fitness);
            }

            // Sampler update
            sampler.addPoint(params, ev.fitness);

            if (ev.fitness > genBest) genBest = ev.fitness;
            if (ev.fitness > bestFitness * (1 + 0.01)) {
                bestFitness = ev.fitness;
                bestParams = Object.assign({}, def.defaultParams, params);
                bestStats = ev.stats;
                // FIX: equity curve is in advanced, not stats
                for (const _ps of (ev.perSymbol || [])) {
                    const _ws = _ps.windows;
                    if (!_ws) continue;
                    let found = false;
                    for (let _wi = 0; _wi < _ws.length; _wi++) {
                        if (_ws[_wi] && _ws[_wi].advanced && Array.isArray(_ws[_wi].advanced.equityCurve) && _ws[_wi].advanced.equityCurve.length) {
                            bestEquityCurve = _ws[_wi].advanced.equityCurve;
                            found = true;
                            break;
                        }
                    }
                    if (found) break;
                }
                patienceLeft = opts.patience;
            }

            // Pruner update: reduced space
            const reduced = pruner.reducedSpace();
            sampler.space = reduced;

            await _updateJobProgress(jobDbId, {
                'progress.message': 'GA ' + strategyId + ' | gen ' + generation + '/' + opts.maxGenerations
                    + ' | trial ' + (t + 1) + '/' + opts.trialsPerGeneration
                    + ' | best=' + bestFitness.toFixed(3)
            });
        }

        // FIX GA-9: per-generation patience
        if (bestFitness <= _bestAtGenStart * (1 + 0.01)) {
            patienceLeft--;
        } else {
            patienceLeft = opts.patience;
        }

        // Save state
        await stopResume.saveState(deps.getDB, strategyId, {
            status: 'running', generation: generation,
            best: { params: bestParams, fitness: bestFitness, stats: bestStats },
            bestEquityCurve: bestEquityCurve,
            tpeState: sampler.export(),
            prunerState: pruner.export(),
            history: sampler.history.slice(-100)
        });

        if (patienceLeft <= 0) {
            deps.logger && deps.logger.info('[ga] ' + strategyId + ' converged at gen ' + generation);
            break;
        }
    }

    await stopResume.saveState(deps.getDB, strategyId, {
        status: 'done', generation: generation,
        best: { params: bestParams, fitness: bestFitness, stats: bestStats },
        bestEquityCurve: bestEquityCurve,
        tpeState: sampler.export(),
        prunerState: pruner.export()
    });

    return {
        strategyId: strategyId,
        done: true,
        generation: generation,
        best: { params: bestParams, fitness: bestFitness, stats: bestStats },
        bestEquityCurve: bestEquityCurve,
        pruner: pruner.snapshot()
    };
}

async function runGA(jobDbId, opts) {
    opts = Object.assign({}, DEFAULTS, opts || {});
    if (!deps.getDB || !deps.strategies) {
        return { error: 'deps not initialized' };
    }

    const EXCLUDED = new Set(['pairs_spread', 'sector_momentum', 'ensemble', 'dual_thrust', 'rsi2_mr', 'orb_pro', 'gap_and_go']);
    let strategyIds = [];
    if (opts.allStrategies) {
        strategyIds = Object.keys(deps.strategies.STRATEGIES).filter(id => {
            const def = deps.strategies.STRATEGIES[id];
            if (EXCLUDED.has(id)) return false;
            if (def && def.deprecated) return false;
            return true;
        });
    } else if (opts.strategyId) {
        strategyIds = [opts.strategyId];
    } else if (Array.isArray(opts.strategies) && opts.strategies.length) {
        strategyIds = opts.strategies.filter(id => !EXCLUDED.has(id));
    }
    if (!strategyIds.length) return { error: 'no strategies selected (all excluded?)' };

    // Default date range: from first option data or 1 year back
    if (!opts.dateFrom || !opts.dateTo) {
        const db = deps.getDB();
        try {
            const latest = await db.collection(COLLECTIONS.CANDLES_DAILY)
                .findOne({}, { sort: { time: -1 }, projection: { time: 1 } });
            const earliest = await db.collection(COLLECTIONS.CANDLES_DAILY)
                .findOne({}, { sort: { time: 1 }, projection: { time: 1 } });
            if (latest && earliest) {
                const to = Math.floor(new Date(latest.time).getTime() / 1000);
                const oneYear = 365 * 86400;
                const from = Math.max(
                    Math.floor(new Date(earliest.time).getTime() / 1000),
                    to - oneYear
                );
                opts.dateFrom = opts.dateFrom || from;
                opts.dateTo = opts.dateTo || to;
            }
        } catch (_) {}
    }
    if (!opts.dateFrom || !opts.dateTo) {
        const now = Math.floor(Date.now() / 1000);
        opts.dateFrom = now - 365 * 86400;
        opts.dateTo = now;
    } else {
    }
    const results = [];
    for (let i = 0; i < strategyIds.length; i++) {
        const sid = strategyIds[i];
        await _updateJobProgress(jobDbId, {
            'progress.current': i + 1,
            'progress.total': strategyIds.length,
            'progress.message': 'GA: ' + sid + ' (' + (i + 1) + '/' + strategyIds.length + ')'
        });
        try {
            const r = await _runSingleStrategy(sid, jobDbId, opts);
            results.push(r);
        } catch (e) {
            deps.logger && deps.logger.error('[ga] ' + sid + ': ' + e.message);
            // BUG-39 fix: save error state
            try {
                await stopResume.saveState(deps.getDB, sid, {
                    status: 'error', error: String(e.message || ''),
                    updatedAt: new Date()
                });
            } catch (_) {}
            results.push({ strategyId: sid, error: e.message });
        }
        // If paused/cancelled/budget, stop processing rest
        const last = results[results.length - 1];
        if (last && last.cancelled) break;   // user cancelled → stop everything
        // paused / budgetOut: keep going so remaining strategies at least try
        if (last && (last.paused || last.budgetOut)) {
            deps.logger && deps.logger.info('[ga] ' + sid + ' ' + (last.paused ? 'paused' : 'budget') + ' — continuing');
        }
    }

    return {
        totalStrategies: strategyIds.length,
        completed: results.filter(r => r.done).length,
        paused: results.filter(r => r.paused).length,
        results: results
    };
}

async function resumeReady() {
    if (!deps.getDB) return { resumed: 0 };
    if (stopResume.isDangerWindow()) return { resumed: 0, inDanger: true };
    const paused = await stopResume.listPaused(deps.getDB);
    let resumed = 0;
    // FIX GA-8: sequential, one at a time
    for (const st of paused) {
        if (st.manualPause === true) continue;   // manual pause -- wait for user
        if (st.resumeAfter && new Date(st.resumeAfter) > new Date()) continue;
        if (stopResume.isDangerWindow()) break;
        await stopResume.saveState(deps.getDB, st.strategyId, Object.assign({}, st, { status: 'running' }));
        try {
            const db = deps.getDB();
            const jobDoc = {
                type: 'ga', payload: { strategyId: st.strategyId, resume: true },
                status: 'RUNNING', progress: { current: 0, total: 1, message: 'resume' },
                createdAt: new Date(), updatedAt: new Date(), startedAt: new Date()
            };
            const ins = await db.collection(COLLECTIONS.BACKTEST_JOBS).insertOne(jobDoc);
            const _resumeOpts = Object.assign({}, st.savedOpts || {}, { strategyId: st.strategyId, resume: true });
        const r = await runGA(String(ins.insertedId), _resumeOpts);
            await db.collection(COLLECTIONS.BACKTEST_JOBS).updateOne(
                { _id: ins.insertedId },
                { $set: { status: 'DONE', result: r, finishedAt: new Date() } }
            );
        } catch (e) {
            deps.logger && deps.logger.warn('[ga] resume ' + st.strategyId + ': ' + e.message);
        }
        resumed++;
    }
    return { resumed: resumed, inDanger: false };
}

module.exports = {
    init, runGA, resumeReady,
    DEFAULTS, _buildSearchSpace
};