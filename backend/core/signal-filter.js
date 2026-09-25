'use strict';
// ============================================================
// signal-filter.js — فیلتر کیفیت سیگنال (Phase 3.5 — v2)
// ============================================================
// v2: pair-level (symbol × strategy) — نه aggregate استراتژی
// ============================================================

/**
 * @param {Array} trades — tradeهای خام
 * @param {Object} analysis — نتیجه‌ی analysisService.analyzeJob
 * @param {Object} opts
 *   - minPairPF: حداقل PF هر pair (default 2.0)
 *   - minPairTrades: حداقل معامله‌ی pair (default 5)
 *   - minPairLB: حداقل LB (default 1.0) — alternative gate
 *   - minStrategyPF: fallback aggregate (default 1.3)
 *   - mode: 'pair' (default) | 'strategy' | 'off'
 */
function filterTrades(trades, analysis, opts = {}) {
    const mode = opts.mode || 'pair';
    const minPairPF = opts.minPairPF ?? 2.0;
    const minPairTrades = opts.minPairTrades ?? 5;
    const minPairLB = opts.minPairLB ?? 1.0;
    const minStrategyPF = opts.minStrategyPF ?? 1.3;
    const minStrategyTrades = opts.minStrategyTrades ?? 5;

    if (mode === 'off' || !analysis || !analysis.results) {
        return { trades, filter: { applied: false, mode } };
    }

    // ─── 1) ساخت نقشه‌ی pair → metrics ───
    const pairs = new Map();   // "symbol::strategyId" → {symbol, strategyId, pf, lb, trades, winRate}
    for (const r of analysis.results) {
        const key = `${r.symbol}::${r.strategyId}`;
        const pf = typeof r.rawStats.pf === 'number' ? r.rawStats.pf : 0;
        const lb = r.bootstrap?.pf?.p2_5 ?? 0;
        pairs.set(key, {
            symbol: r.symbol,
            strategyId: r.strategyId,
            strategyName: r.strategyName,
            pf,
            lb,
            trades: r.tradeCount,
            winRate: r.rawStats.winRate
        });
    }

    // ─── 2) strategy-level aggregate (برای fallback) ───
    const strategyAgg = {};
    for (const p of pairs.values()) {
        const sid = p.strategyId;
        if (!strategyAgg[sid]) {
            strategyAgg[sid] = { count: 0, totalPF: 0, trades: 0, wins: 0 };
        }
        strategyAgg[sid].count += 1;
        strategyAgg[sid].totalPF += p.pf === Infinity ? 5 : p.pf;
        strategyAgg[sid].trades += p.trades;
        strategyAgg[sid].wins += (p.trades * p.winRate / 100);
    }

    const trustedStrategies = new Set();
    const strategyInfo = {};
    for (const [sid, a] of Object.entries(strategyAgg)) {
        const avgPF = a.count ? a.totalPF / a.count : 0;
        const wr = a.trades ? (a.wins / a.trades) * 100 : 0;
        const trusted = a.trades >= minStrategyTrades && avgPF >= minStrategyPF;
        if (trusted) trustedStrategies.add(sid);
        strategyInfo[sid] = {
            totalTrades: a.trades,
            avgPF: Math.round(avgPF * 100) / 100,
            winRate: Math.round(wr * 100) / 100,
            trusted
        };
    }

    // ─── 3) pair decision ───
    const allowedPairs = new Set();   // "symbol::strategyId"
    const pairDecisions = [];

    for (const [key, p] of pairs) {
        let decision = null;
        let reason = null;

        if (mode === 'pair') {
            // gate مستقیم pair
            if (p.pf >= minPairPF && p.trades >= minPairTrades) {
                decision = true;
                reason = `pair PF=${p.pf.toFixed(2)} >= ${minPairPF}`;
            } else if (p.lb >= minPairLB) {
                decision = true;
                reason = `pair LB=${p.lb.toFixed(2)} >= ${minPairLB}`;
            } else if (trustedStrategies.has(p.strategyId) && p.pf >= 1.0 && p.trades >= 3) {
                // fallback: استراتژی معتمده + pair حداقل سودآور
                decision = true;
                reason = `trusted strategy + pair PF>=1`;
            } else {
                decision = false;
                reason = `PF=${p.pf.toFixed(2)}, LB=${p.lb.toFixed(2)}, strategy=${trustedStrategies.has(p.strategyId) ? 'trusted' : 'no'}`;
            }
        } else if (mode === 'strategy') {
            decision = trustedStrategies.has(p.strategyId);
            reason = decision ? 'strategy trusted' : 'strategy not trusted';
        }

        if (decision) allowedPairs.add(key);
        pairDecisions.push({
            key, symbol: p.symbol, strategyId: p.strategyId,
            pf: p.pf, lb: p.lb, trades: p.trades, winRate: p.winRate,
            allowed: decision, reason
        });
    }

    // ─── 4) filter trades ───
    const kept = [];
    const dropped = [];
    for (const t of trades) {
        const key = `${t.symbol}::${t.strategyId}`;
        if (allowedPairs.has(key)) {
            kept.push(t);
        } else {
            dropped.push({ ...t, _dropReason: `pair ${key} not whitelisted` });
        }
    }

    // ─── 5) report ───
    const allowedSymbols = new Set(pairDecisions.filter(d => d.allowed).map(d => d.symbol));
    const allowedStrategies = new Set(pairDecisions.filter(d => d.allowed).map(d => d.strategyId));

    return {
        trades: kept,
        dropped,
        filter: {
            applied: true,
            mode,
            originalCount: trades.length,
            keptCount: kept.length,
            droppedCount: dropped.length,
            allowedPairs: Array.from(allowedPairs),
            allowedSymbols: Array.from(allowedSymbols),
            allowedStrategies: Array.from(allowedStrategies),
            trustedStrategies: Array.from(trustedStrategies),
            strategyInfo,
            pairDecisions: pairDecisions
                .sort((a, b) => (b.allowed - a.allowed) || (b.pf - a.pf))
                .slice(0, 50)   // top 50
        }
    };
}

module.exports = { filterTrades };