'use strict';
const { COLLECTIONS } = require('../config/constants');
function _pnlOf(p) {
    if (p && p.pnl && typeof p.pnl.pnlPct === 'number') return p.pnl.pnlPct;
    if (p && typeof p.pnlPct === 'number') return p.pnlPct;
    return null;
}
function _statsOf(trades) {
    if (!trades || !trades.length) return { count: 0, winRate: 0, avgPnl: 0, totalPnl: 0, profitFactor: null, avgWin: 0, avgLoss: 0, grossWin: 0, grossLoss: 0 };
    const pnls = trades.map(_pnlOf).filter(x => x !== null);
    if (!pnls.length) return { count: 0, winRate: 0, avgPnl: 0, totalPnl: 0, profitFactor: null, avgWin: 0, avgLoss: 0, grossWin: 0, grossLoss: 0 };
    const wins = pnls.filter(x => x > 0);
    const losses = pnls.filter(x => x <= 0);
    const gp = wins.reduce((s, x) => s + x, 0);
    const gl = -losses.reduce((s, x) => s + x, 0);
    const pf = gl > 0 ? gp / gl : (gp > 0 ? null : 0);
    return { count: pnls.length, winRate: pnls.length ? wins.length / pnls.length * 100 : 0, avgPnl: pnls.reduce((s, x) => s + x, 0) / pnls.length, totalPnl: pnls.reduce((s, x) => s + x, 0), profitFactor: pf, avgWin: wins.length ? gp / wins.length : 0, avgLoss: losses.length ? -gl / losses.length : 0, grossWin: gp, grossLoss: gl };
}
function _r(v, d) { if (v === null || v === undefined || !Number.isFinite(v)) return null; const m = Math.pow(10, d == null ? 2 : d); return Math.round(v * m) / m; }
async function computeDrift(getDB, opts) {
    opts = opts || {};
    if (!getDB) throw new Error('getDB required');
    const db = getDB();
    const daysWindow = +(opts.days || 30);
    const since = new Date(Date.now() - daysWindow * 86400 * 1000);
    const allPaper = await db.collection(COLLECTIONS.OPTION_POSITIONS).find({ paper: true }).toArray();
    const open = allPaper.filter(p => p.status === 'open');
    const pending = allPaper.filter(p => p.status === 'pending');
    const skipped = allPaper.filter(p => p.status === 'skipped');
    const closedAll = allPaper.filter(p => p.status === 'closed');
    const closedWindow = closedAll.filter(p => p.exitTime && new Date(p.exitTime) >= since);
    const statsWindow = _statsOf(closedWindow);
    const statsAll = _statsOf(closedAll);
    const meta = await db.collection(COLLECTIONS.META).findOne({ _id: 'last_backtest_pf' });
    const backtestPF = meta && Number.isFinite(meta.pf) ? meta.pf : null;
    const backtestJobId = meta && meta.jobId ? meta.jobId : null;
    const backtestRecordedAt = meta && meta.recordedAt ? meta.recordedAt : null;
    const backtestMode = meta && meta.mode ? meta.mode : null;
    const baseStats = statsWindow.count >= 5 ? statsWindow : statsAll;
    const baseWindowUsed = statsWindow.count >= 5 ? (daysWindow + 'd') : 'all-time';
    let ratio = null, severity = 'insufficient', message = null;
    if (!backtestPF || backtestPF <= 0) { severity = 'insufficient'; message = 'Backtest PF not recorded - drift unavailable'; }
    else if (baseStats.count < 5) { severity = 'insufficient'; message = 'sample too small (' + baseStats.count + ' closed, need 5)'; }
    else if (baseStats.profitFactor === null) { ratio = 2.0; severity = 'ok'; message = 'paper with no losses (PF=inf)'; }
    else if (baseStats.profitFactor === 0) { ratio = 0; severity = 'critical'; message = 'all paper trades lost'; }
    else { ratio = baseStats.profitFactor / backtestPF;
        if (ratio < 0.3) { severity = 'critical'; message = 'paper PF only ' + (ratio * 100).toFixed(0) + '% of backtest'; }
        else if (ratio < 0.5) { severity = 'warn'; message = 'paper PF ' + (ratio * 100).toFixed(0) + '% of backtest'; }
        else if (ratio < 0.7) { severity = 'notice'; message = 'paper PF ' + (ratio * 100).toFixed(0) + '% of backtest (acceptable)'; }
        else { severity = 'ok'; message = null; }
    }
    const byStrategy = new Map();
    for (const p of closedAll) { const sid = (p.signal && p.signal.strategyId) || p.strategyId || 'unknown'; if (!byStrategy.has(sid)) byStrategy.set(sid, []); byStrategy.get(sid).push(p); }
    const perStrategy = [];
    for (const entry of byStrategy) { const s = _statsOf(entry[1]); perStrategy.push({ strategyId: entry[0], count: s.count, winRate: _r(s.winRate, 1), avgPnl: _r(s.avgPnl, 2), totalPnl: _r(s.totalPnl, 2), profitFactor: _r(s.profitFactor, 2) }); }
    perStrategy.sort((a, b) => (b.profitFactor || 0) - (a.profitFactor || 0));
    const bySymbol = new Map();
    for (const p of closedAll) { const sym = p.underlying || (p.signal && p.signal.symbol) || 'unknown'; if (!bySymbol.has(sym)) bySymbol.set(sym, []); bySymbol.get(sym).push(p); }
    const perSymbol = [];
    for (const entry of bySymbol) { const s = _statsOf(entry[1]); perSymbol.push({ symbol: entry[0], count: s.count, winRate: _r(s.winRate, 1), avgPnl: _r(s.avgPnl, 2), totalPnl: _r(s.totalPnl, 2), profitFactor: _r(s.profitFactor, 2) }); }
    perSymbol.sort((a, b) => (b.profitFactor || 0) - (a.profitFactor || 0));
    return {
        computedAt: new Date(), windowDays: daysWindow,
        paper: { open: open.length, pending: pending.length, skipped: skipped.length, closed: closedWindow.length, closedAllTime: closedAll.length,
            statsWindow: Object.assign({}, statsWindow, { winRate: _r(statsWindow.winRate, 1), avgPnl: _r(statsWindow.avgPnl, 2), totalPnl: _r(statsWindow.totalPnl, 2), profitFactor: _r(statsWindow.profitFactor, 2), avgWin: _r(statsWindow.avgWin, 2), avgLoss: _r(statsWindow.avgLoss, 2) }),
            statsAll: Object.assign({}, statsAll, { winRate: _r(statsAll.winRate, 1), avgPnl: _r(statsAll.avgPnl, 2), totalPnl: _r(statsAll.totalPnl, 2), profitFactor: _r(statsAll.profitFactor, 2) }) },
        backtest: { pf: backtestPF, jobId: backtestJobId, recordedAt: backtestRecordedAt, mode: backtestMode },
        baseWindowUsed: baseWindowUsed, ratio: _r(ratio, 4), severity: severity, message: message,
        perStrategy: perStrategy, perSymbol: perSymbol
    };
}
module.exports = { computeDrift: computeDrift };