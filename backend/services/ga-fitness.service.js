'use strict';
// ============================================================
// ga-fitness.service.js — GT-Score fitness for GA
// ============================================================
// Formula: (Sharpe × Return × WinRate) / (MaxDD × log(N))
//   + PF penalty if profitFactor > 5
//   + consistency bonus based on profitable-window ratio
// ============================================================

const MIN_TRADES = 20;
const MIN_SHARPE = 0.5;
const MIN_PF = 1.0;
const PF_PENALTY_THRESHOLD = 5;

function _num(v, fallback = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

function isEligible(stats) {
    if (!stats) return { ok: false, reason: 'no stats' };
    const n = _num(stats.totalTrades != null ? stats.totalTrades : stats.count);
    if (n < MIN_TRADES) return { ok: false, reason: 'N=' + n + ' < ' + MIN_TRADES };
    const sharpe = _num(stats.sharpe, NaN);
    if (!Number.isFinite(sharpe) || sharpe < MIN_SHARPE) {
        return { ok: false, reason: 'Sharpe=' + sharpe + ' < ' + MIN_SHARPE };
    }
    const pf = _num(stats.profitFactor, NaN);
    if (!Number.isFinite(pf) || pf < MIN_PF) {
        return { ok: false, reason: 'PF=' + pf + ' < ' + MIN_PF };
    }
    return { ok: true };
}

function computeFitness(stats) {
    const elig = isEligible(stats);
    if (!elig.ok) return 0;

    const sharpe = _num(stats.sharpe);
    const totalReturn = _num(stats.totalReturnPct != null ? stats.totalReturnPct : stats.totalPnl);
    const winRate = _num(stats.winRate);
    const maxDD = Math.abs(_num(stats.maxDrawdownPct != null ? stats.maxDrawdownPct : stats.maxDD));
    const n = _num(stats.totalTrades != null ? stats.totalTrades : stats.count);
    const pf = _num(stats.profitFactor);
    const windowsProfitable = _num(stats.windowsProfitable);
    const windowsTotal = Math.max(1, _num(stats.windowsTotal, 1));

    const safeDD = Math.max(maxDD, 1);
    const safeLogN = Math.log(Math.max(n, 2));

    const base = (sharpe * totalReturn * winRate) / (safeDD * safeLogN);
    const pfPenalty = pf > PF_PENALTY_THRESHOLD ? 0.7 : 1.0;
    const consistencyBonus = windowsProfitable / windowsTotal;

    const fitness = base * pfPenalty * (0.5 + 0.5 * consistencyBonus);
    return Number.isFinite(fitness) ? Math.max(0, fitness) : 0;
}

module.exports = { computeFitness, isEligible, MIN_TRADES, MIN_SHARPE, MIN_PF };