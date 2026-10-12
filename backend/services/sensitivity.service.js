'use strict';
// ============================================================
// sensitivity.service.js — Parameter Sensitivity
// ============================================================
// Tests 2 params x 3 values each = 9 combos on ALL symbols.
// Returns baseline vs each combo, plus warnings for overfit.
// ============================================================

const { ObjectId } = require('mongodb');
const { COLLECTIONS } = require('../config/constants');

let deps = { getDB: null, logger: null, backtest: null, strategies: null };
function init(d) { deps = { ...deps, ...d }; }

const KEY_PARAMS = {
    smc_unicorn: ['swingLength', 'atrMult'],
    smc_unicorn_pro: ['swingLength', 'atrMult'],
    ob_sweep: ['swingLength', 'minSweepPct'],
    ob_sweep_pro: ['swingLength', 'minSweepPct'],
    ob_after_sweep: ['sweepWithinBars', 'obLookback'],
    ob_after_sweep_pro: ['sweepWithinBars', 'obLookback'],
    tsmom: ['lookbackDays', 'atrMult'],
    tsmom_pro: ['lookbackDays', 'atrMult'],
    momentum_12_1: ['lookbackMonths', 'atrMult'],
    momentum_12_1_pro: ['lookbackMonths', 'atrMult'],
    donchian: ['entryPeriod', 'atrMult'],
    donchian_pro: ['entryPeriod', 'atrMult'],
    nr7: ['nrWindow', 'atrMult'],
    nr7_pro: ['nrWindow', 'atrMult'],
    opening_drive: ['rangeMinutes', 'minVolMult'],
    opening_drive_pro: ['rangeMinutes', 'minVolMult'],
    vw_breakout: ['lookbackHigh', 'minVolMult'],
    vw_breakout_pro: ['lookbackHigh', 'minVolMult'],
    vwap_reclaim: ['minVolumeMult', 'atrMult'],
    vwap_reclaim_pro: ['minVolumeMult', 'atrMult'],
    rsi_divergence: ['rsiPeriod', 'minRsiDelta'],
    rsi_divergence_pro: ['rsiPeriod', 'minRsiDelta'],
    ib_breakout: ['atrMult', 'maxHoldBars'],
    ib_breakout_pro: ['atrMult', 'maxHoldBars'],
    low_vol_anomaly: ['volWindow', 'volPct'],
    low_vol_anomaly_pro: ['volWindow', 'volPct'],
    short_term_reversal: ['lookbackDays', 'atrMult'],
    short_term_reversal_pro: ['lookbackDays', 'atrMult'],
    sector_momentum: ['momentumLookback', 'atrMult'],
};

function getKeyParams(strategyId) { return KEY_PARAMS[strategyId] || null; }

async function runOne(params, strategyId, symbols, dateFrom, dateTo) {
    const STRATEGIES = deps.strategies.STRATEGIES;
    const def = STRATEGIES[strategyId];
    if (!def) throw new Error('unknown strategy: ' + strategyId);

    let trades = 0, wins = 0, totalPnl = 0, gp = 0, gl = 0;

    for (const sym of symbols) {
        const cfg = {
            symbol: sym,
            strategyId,
            timeframe: def.defaultTimeframe,
            htfTimeframe: def.htfTimeframe || '1d',
            candleType: 'heikin',
            params: { ...params },
        };
        try {
            const r = await deps.backtest.runBacktest(cfg, dateFrom, dateTo, {
                mode: 'stock',
                lightMode: true,
            });
            const st = r.stockStats || {};
            const n = st.count || 0;
            const w = n * (st.winRate || 0) / 100;
            const l = n - w;
            trades += n;
            wins += w;
            totalPnl += st.totalPnl || 0;
            gp += w * Math.abs(st.avgWin || 0);
            gl += l * Math.abs(st.avgLoss || 0);
        } catch (_) {}
    }

    const pf = gl > 0 ? gp / gl : (gp > 0 ? 999 : 0);
    const wr = trades > 0 ? wins / trades * 100 : 0;
    return {
        trades,
        winRate: Math.round(wr * 10) / 10,
        totalPnl: Math.round(totalPnl * 100) / 100,
        pf: Math.round(pf * 100) / 100,
    };
}

function makeValues(base, range) {
    const n = Number(base);
    if (!Number.isFinite(n) || n === 0) return [n, n, n];
    const isInt = Number.isInteger(base);
    const lo = base * (1 - range);
    const hi = base * (1 + range);
    return [
        isInt ? Math.max(1, Math.round(lo)) : Math.round(lo * 1000) / 1000,
        base,
        isInt ? Math.round(hi) : Math.round(hi * 1000) / 1000,
    ];
}

async function runSensitivity(jobId, opts) {
    const db = deps.getDB();
    const { strategyId, symbols, dateFrom, dateTo } = opts;
    const v1 = opts.param1, v2 = opts.param2;
    const rangePct = Number.isFinite(opts.rangePct) && opts.rangePct > 0 ? opts.rangePct : 0.2;

    if (!strategyId || !Array.isArray(symbols) || !symbols.length) throw new Error('strategyId + symbols required');
    if (!v1 || !v2) throw new Error('param1 + param2 required');

    const STRATEGIES = deps.strategies.STRATEGIES;
    const def = STRATEGIES[strategyId];
    if (!def) throw new Error('unknown strategy');

    const baseParams = { ...def.defaultParams, ...(opts.baseParams || {}) };
    const vals1 = makeValues(baseParams[v1], rangePct);
    const vals2 = makeValues(baseParams[v2], rangePct);

    const total = 9 + 1;
    let step = 0;

    const upd = async (patch) => {
        try {
            await db.collection(COLLECTIONS.BACKTEST_JOBS).updateOne(
                { _id: new ObjectId(jobId) },
                { $set: { ...patch, updatedAt: new Date() } }
            );
        } catch (_) {}
    };

    await upd({ 'progress.current': 0, 'progress.total': total, 'progress.message': 'Baseline...' });
    const baseline = await runOne(baseParams, strategyId, symbols, dateFrom, dateTo);
    step++;

    const combos = [];
    for (const p1 of vals1) {
        for (const p2 of vals2) {
            const isBase = (p1 === baseParams[v1] && p2 === baseParams[v2]);
            if (isBase) {
                combos.push({ v1: p1, v2: p2, isBaseline: true, ...baseline });
                continue;
            }
            await upd({
                'progress.current': step, 'progress.total': total,
                'progress.message': v1 + '=' + p1 + ', ' + v2 + '=' + p2,
            });
            const r = await runOne({ ...baseParams, [v1]: p1, [v2]: p2 }, strategyId, symbols, dateFrom, dateTo);
            combos.push({ v1: p1, v2: p2, isBaseline: false, ...r });
            step++;
        }
    }

    for (const c of combos) {
        c.deltaPf = baseline.pf > 0 ? Math.round((c.pf / baseline.pf - 1) * 1000) / 10 : 0;
        c.deltaPnl = baseline.totalPnl !== 0 ? Math.round((c.totalPnl / baseline.totalPnl - 1) * 1000) / 10 : 0;
    }

    let best = null;
    for (const c of combos) {
        if (c.isBaseline) continue;
        if (c.trades < baseline.trades * 0.7) continue;
        if (c.pf < 1.0) continue;
        if (!best || c.pf > best.pf || (c.pf === best.pf && c.totalPnl > best.totalPnl)) best = c;
    }

    const warnings = [];
    if (!best) warnings.push('هیچ ترکیبی با شرایط قابل قبول پیدا نشد');
    else {
        const dpct = baseline.pf > 0 ? (best.pf / baseline.pf - 1) * 100 : 0;
        if (dpct < 5) warnings.push('بهبود کمتر از ۵٪ — احتمال نویز یا overfit');
        if (best.trades < baseline.trades * 0.7) warnings.push('کاهش شدید تعداد معاملات — overfit احتمالی');
        if (best.pf < 1.5) warnings.push('PF نهایی پایین — عملکرد ضعیف');
    }

    const finalResult = {
        strategyId,
        strategyName: def.name,
        symbolsCount: symbols.length,
        dateRange: { from: dateFrom, to: dateTo },
        rangePct,
        param1: v1, param2: v2,
        baseParams,
        baseline,
        combos,
        best,
        warnings,
        computedAt: new Date(),
    };

    await db.collection(COLLECTIONS.BACKTEST_JOBS).updateOne(
        { _id: new ObjectId(jobId) },
        { $set: {
            status: 'DONE', result: finalResult, finishedAt: new Date(),
            'progress.current': total, 'progress.message': 'تکمیل',
        } }
    );

    return finalResult;
}

module.exports = { init, runSensitivity, getKeyParams, KEY_PARAMS };
