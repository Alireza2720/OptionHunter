'use strict';
// ============================================================
// regime-diversity.js — تنوع رژیم در trades
// ============================================================
// مسئله: اگه pair فقط در رژیم bull کار کنه، در رژیم بعدی
// شکست می‌خوره. باید حداقل ۲۰٪ تنوع داشته باشیم.
// ============================================================

function computeEMA(closes, period) {
    const ema = new Array(closes.length).fill(null);
    if (closes.length < period) return ema;
    let s = 0;
    for (let i = 0; i < period; i++) s += closes[i];
    ema[period - 1] = s / period;
    const k = 2 / (period + 1);
    for (let i = period; i < closes.length; i++) {
        ema[i] = closes[i] * k + ema[i - 1] * (1 - k);
    }
    return ema;
}

/**
 * توزیع رژیم در trades
 * @param {Array} trades — [{entryTime, ...}]
 * @param {Array} dailyCandles — [{time, open, high, low, close}]
 * @param {number} emaPeriod — پیش‌فرض 200
 * @returns {Object|null}
 */
function computeRegimeDistribution(trades, dailyCandles, emaPeriod = 200) {
    if (!Array.isArray(trades) || !trades.length) {
        return { distribution: null, totalTrades: 0, error: 'no trades' };
    }
    if (!dailyCandles || dailyCandles.length < emaPeriod + 20) {
        return {
            distribution: null,
            totalTrades: trades.length,
            error: `daily candles کم (${dailyCandles ? dailyCandles.length : 0} < ${emaPeriod + 20})`
        };
    }

    const closes = dailyCandles.map(c => c.close);
    const times = dailyCandles.map(c => c.time);
    const ema = computeEMA(closes, emaPeriod);
    const slopeBars = Math.min(10, Math.max(3, Math.floor(dailyCandles.length / 20)));

    // برای هر trade → regime در لحظه ورود
    function regimeAt(timeSec) {
        let idx = -1;
        for (let i = 0; i < times.length; i++) {
            if (times[i] <= timeSec) idx = i; else break;
        }
        if (idx < emaPeriod || ema[idx] === null) return 'unknown';
        const prevIdx = idx - slopeBars;
        if (prevIdx < 0 || ema[prevIdx] === null) return 'unknown';
        const slopePct = ((ema[idx] - ema[prevIdx]) / ema[prevIdx]) * 100;
        const c = closes[idx];
        if (c > ema[idx] && slopePct > 0) return 'bull';
        if (c < ema[idx] && slopePct < 0) return 'bear';
        return 'range';
    }

    const counts = { bull: 0, bear: 0, range: 0, unknown: 0 };
    for (const t of trades) {
        counts[regimeAt(t.entryTime)]++;
    }

    const total = trades.length;
    const dist = {};
    for (const [k, v] of Object.entries(counts)) {
        dist[k] = {
            count: v,
            pct: total > 0 ? Math.round(v / total * 1000) / 10 : 0
        };
    }

    // بیشترین تراکم در یک رژیم
    const nonUnknown = ['bull', 'bear', 'range'].map(k => ({ k, pct: dist[k].pct }));
    const maxPct = Math.max(...nonUnknown.map(x => x.pct), 0);
    const dominant = nonUnknown.find(x => x.pct === maxPct);

    return {
        distribution: dist,
        totalTrades: total,
        dominantRegime: dominant ? dominant.k : null,
        dominantPct: maxPct,
        diverse: maxPct < 80,
        hasBear: dist.bear.pct >= 10,
        hasBull: dist.bull.pct >= 10,
        hasRange: dist.range.pct >= 10,
        // شمارش رژیم‌های غیر unknown
        knownRegimes: ['bull', 'bear', 'range'].filter(k => dist[k].count > 0).length
    };
}

module.exports = { computeRegimeDistribution, computeEMA };