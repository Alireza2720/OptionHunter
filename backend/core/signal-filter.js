'use strict';
// ============================================================
// signal-filter.js — فیلتر کیفیت سیگنال (Phase 3.5)
// ============================================================
// قبل از sim، tradeها رو بر اساس:
//  - symbol whitelist (از analysis فاز ۱)
//  - strategy whitelist
//  - min PF per strategy
// فیلتر می‌کنیم
// ============================================================

/**
 * @param {Array} trades — tradeهای خام
 * @param {Object} analysis — نتیجه‌ی analysisService.analyzeJob
 * @param {Object} opts
 *   - minStrategyPF: حداقل PF استراتژی (default 1.3)
 *   - minSymbolLB: حداقل lower bound PF نماد (default 1.0)
 *   - useWhitelist: فعال/غیرفعال (default true)
 */
function filterTrades(trades, analysis, opts = {}) {
    const minStrategyPF = opts.minStrategyPF ?? 1.3;
    const minSymbolLB = opts.minSymbolLB ?? 1.0;
    const minTradesPerStrategy = opts.minTradesPerStrategy ?? 5;

    if (!opts.useWhitelist || !analysis || !analysis.results) {
        return { trades, filter: { applied: false } };
    }

    // ۱) از نتایج analysis، آمار استراتژی‌ها رو جمع کن
    const strategyStats = {};
    const symbolBestLB = {};

    for (const r of analysis.results) {
        const sid = r.strategyId;

        // استراتژی aggregate
        if (!strategyStats[sid]) {
            strategyStats[sid] = { trades: 0, wins: 0, totalPF: 0, count: 0 };
        }
        strategyStats[sid].trades += r.tradeCount;
        const wr = r.rawStats.winRate || 0;
        strategyStats[sid].wins += (r.tradeCount * wr / 100);
        if (typeof r.rawStats.pf === 'number' && Number.isFinite(r.rawStats.pf)) {
            strategyStats[sid].totalPF += r.rawStats.pf;
            strategyStats[sid].count += 1;
        }

        // نماد: بهترین LB از این نماد
        const lb = r.bootstrap?.pf?.p2_5 ?? 0;
        if (!symbolBestLB[r.symbol] || lb > symbolBestLB[r.symbol]) {
            symbolBestLB[r.symbol] = lb;
        }
    }

    // استراتژی‌های مجاز
    const allowedStrategies = new Set();
    const strategyInfo = {};
    for (const [sid, st] of Object.entries(strategyStats)) {
        if (st.trades < minTradesPerStrategy) continue;
        const avgPF = st.count > 0 ? st.totalPF / st.count : 0;
        const wr = st.trades > 0 ? (st.wins / st.trades) * 100 : 0;
        const ok = avgPF >= minStrategyPF;
        if (ok) allowedStrategies.add(sid);
        strategyInfo[sid] = {
            trades: st.trades,
            avgPF: Math.round(avgPF * 100) / 100,
            winRate: Math.round(wr * 100) / 100,
            allowed: ok,
            reason: !ok ? `PF ${avgPF.toFixed(2)} < ${minStrategyPF}` : 'ok'
        };
    }

    // نمادهای مجاز
    const allowedSymbols = new Set();
    for (const [sym, lb] of Object.entries(symbolBestLB)) {
        if (lb >= minSymbolLB) allowedSymbols.add(sym);
    }

    // فیلتر
    const kept = [];
    const dropped = [];
    for (const t of trades) {
        if (!allowedStrategies.has(t.strategyId)) {
            dropped.push({ ...t, _dropReason: `strategy ${t.strategyId} not in whitelist` });
            continue;
        }
        if (!allowedSymbols.has(t.symbol)) {
            dropped.push({ ...t, _dropReason: `symbol ${t.symbol} not in whitelist` });
            continue;
        }
        kept.push(t);
    }

    return {
        trades: kept,
        dropped,
        filter: {
            applied: true,
            originalCount: trades.length,
            keptCount: kept.length,
            droppedCount: dropped.length,
            allowedStrategies: Array.from(allowedStrategies),
            allowedSymbols: Array.from(allowedSymbols),
            strategyInfo
        }
    };
}

module.exports = { filterTrades };