'use strict';
// ============================================================
// regime-history.js — Historical regime distribution for backtest
// ============================================================
// محاسبه توزیع رژیم بازار در طول بازه بک‌تست
// (به جای رژیم امروز)

const regimeCore = require('./regime');

/**
 * برای هر trade، رژیم در entryTime را محاسبه کن
 * @param {Array} trades — [{entryTime, ...}]
 * @param {Array} dailyCandles — [{time, open, high, low, close}]
 * @returns {Object} — توزیع درصدی
 */
function computeHistoricalRegimeDistribution(trades, dailyCandles) {
    if (!trades || !trades.length) return { bull: 0, bear: 0, range: 0, unknown: 0, total: 0 };
    if (!dailyCandles || dailyCandles.length < 50) {
        return { bull: 0, bear: 0, range: 0, unknown: 0, total: trades.length };
    }

    // محاسبه EMA200 روی daily candles
    const closes = dailyCandles.map(c => c.close);
    const ema = regimeCore.computeEMA(closes, 200);
    const times = dailyCandles.map(c => Math.floor(new Date(c.time).getTime() / 1000));

    function regimeAt(timeSec) {
        let idx = -1;
        for (let i = 0; i < times.length; i++) {
            if (times[i] <= timeSec) idx = i; else break;
        }
        if (idx < 200 || ema[idx] === null) return 'unknown';
        const prevIdx = Math.max(0, idx - 10);
        if (ema[prevIdx] === null) return 'unknown';
        const slopePct = ((ema[idx] - ema[prevIdx]) / ema[prevIdx]) * 100;
        const c = closes[idx];
        if (c > ema[idx] && slopePct > 0) return 'bull';
        if (c < ema[idx] && slopePct < 0) return 'bear';
        return 'range';
    }

    const counts = { bull: 0, bear: 0, range: 0, unknown: 0 };
    for (const t of trades) {
        const r = regimeAt(t.entryTime);
        counts[r]++;
    }

    const total = trades.length;
    const dist = {};
    for (const [k, v] of Object.entries(counts)) {
        dist[k] = {
            count: v,
            pct: total > 0 ? Math.round(v / total * 1000) / 10 : 0
        };
    }

    return {
        distribution: dist,
        totalTrades: total,
        dominantRegime: Object.entries(counts).sort((a,b) => b[1]-a[1])[0][0]
    };
}

module.exports = { computeHistoricalRegimeDistribution };