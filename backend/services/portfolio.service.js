'use strict';
// ============================================================
// portfolio.service.js — orchestrate شبیه‌سازی پرتفولیو
// ============================================================

const { COLLECTIONS } = require('../config/constants');
const portfolioCore = require('../core/portfolio');
const sizing = require('../core/sizing');

let deps = { getDB: null, logger: null, settings: null };
function init(d) { deps = { ...deps, ...d }; }

async function simulateFromJob(jobId, opts = {}) {
    const db = deps.getDB();
    const minTrades = opts.minTrades || 5;

    const details = await db.collection(COLLECTIONS.BACKTEST_COMPARE_DETAILS)
        .find({ jobId: String(jobId) })
        .toArray();

    // جمع‌آوری همه‌ی tradeها
    const allTrades = [];
    for (const d of details) {
        if (!d.trades || d.trades.length < minTrades) continue;
        for (const t of d.trades) {
            allTrades.push({
                ...t,
                symbol: d.symbol,
                strategyId: d.strategyId,
                strategyName: d.strategyName
            });
        }
    }

    if (!allTrades.length) {
        return { error: 'هیچ معامله‌ی معتبری برای شبیه‌سازی نیست', jobId };
    }

    // limits
    const limits = {
        capital: opts.capital || 100_000_000,
        riskPct: opts.riskPct || 1.5,
        maxSymPct: opts.maxSymPct || 20,
        maxTotalPct: opts.maxTotalPct || 50,
        minCashPct: opts.minCashPct || 20,
        maxPositionSize: opts.maxPositionSize || 10
    };

    const result = portfolioCore.simulate(allTrades, limits);

    // CVaR روی tradeهای قبول‌شده
    const pnls = result.trades.map(t => t.pnlPct);
    const cvar = sizing.cvar95(pnls);

    // Kelly
    const wins = result.trades.filter(t => t.pnlPct > 0);
    const losses = result.trades.filter(t => t.pnlPct <= 0);
    const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnlPct, 0) / wins.length : 0;
    const avgLoss = losses.length ? Math.abs(losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length) : 0;
    const winRate = result.trades.length ? wins.length / result.trades.length : 0;
    const kelly = sizing.kellyFraction(winRate, avgWin, avgLoss);
    const halfK = sizing.halfKelly(winRate, avgWin, avgLoss);

    return {
        jobId,
        at: new Date(),
        limits,
        totalTrades: result.totalTrades,
        acceptedTrades: result.acceptedTrades,
        rejectedTrades: result.rejectedTrades,
        trades: result.trades,
        rejected: result.rejected.slice(0, 50),   // فقط ۵۰ تای اول برای UI
        equityCurve: result.equityCurve,
        stats: result.stats,
        advanced: {
            cvar95: cvar,
            kellyFraction: Math.round(kelly * 1000) / 1000,
            halfKelly: Math.round(halfK * 1000) / 1000,
            avgWin: Math.round(avgWin * 100) / 100,
            avgLoss: Math.round(avgLoss * 100) / 100,
            winRate: Math.round(winRate * 10000) / 100
        }
    };
}

module.exports = { init, simulateFromJob };