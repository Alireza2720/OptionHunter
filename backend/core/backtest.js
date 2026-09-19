'use strict';
// ============================================================
// backtest.js — موتور بک‌تست (خالص)
// ============================================================
// - اجرای استراتژی روی کندل‌ها
// - Incremental trade cache (6 ماه -> 1 سال سریع)
// - آمار حرفه‌ای (Sharpe, Sortino, MaxDD, Equity Curve)
// ============================================================

const crypto = require('crypto');
const {
    TIMEFRAME_MINUTES,
    COLLECTIONS,
    ERROR_CODES,
    TRADING_DAYS_PER_YEAR
} = require('../config/constants');

let deps = {
    getDB: null,
    strategies: null,
    dataService: null,
    options: null,
    entryWindow: () => ({ start: 9 * 60 + 30, end: 12 * 60 }),
    getTehranParts: null   // ← اضافه
};

function init(d) { deps = { ...deps, ...d }; }

// ============================================================
// Cache key
// ============================================================
function makeCacheKey(parts) {
    return crypto.createHash('md5').update(JSON.stringify(parts)).digest('hex');
}

function buildSignature(cfg, mode) {
    return {
        symbol: cfg.symbol || null,
        configId: cfg._id ? String(cfg._id) : null,
        strategyId: cfg.strategyId,
        timeframe: cfg.timeframe,
        htfTimeframe: cfg.htfTimeframe || '1d',
        candleType: cfg.candleType || 'heikin',
        params: cfg.params || {},
        mode: mode || 'hybrid'
    };
}

// ============================================================
// Compute stock trades from candles
// ============================================================
async function computeStockTrades(cfg, dateFrom, dateTo, onProgress) {
    const STRATEGIES = deps.strategies.STRATEGIES;
    const def = STRATEGIES[cfg.strategyId];
    if (!def) throw new Error(`استراتژی نامعتبر: ${cfg.strategyId}`);

    const htfTf = cfg.htfTimeframe || '1d';

    let candles = deps.dataService.closedOnly(
        await deps.dataService.getCandlesFull(cfg.symbol, cfg.timeframe),
        cfg.timeframe
    );
    let htf = deps.dataService.closedOnly(
        await deps.dataService.getCandlesFull(cfg.symbol, htfTf),
        htfTf
    );

    // warmup buffer
    const WARMUP_SEC = 90 * 86400;
    if (dateFrom) {
        const fromWarm = dateFrom - WARMUP_SEC;
        candles = candles.filter(c => c.time >= fromWarm);
        htf = htf.filter(c => c.time >= fromWarm);
    }
    if (dateTo) {
        candles = candles.filter(c => c.time <= dateTo);
        htf = htf.filter(c => c.time <= dateTo);
    }

    if (onProgress) {
        onProgress({ phase: 'candles-loaded', candleCount: candles.length, htfCount: htf.length });
    }

    const result = def.run(
        candles,
        { ...cfg.params, candleType: cfg.candleType },
        {
            htfCandles: htf,
            htfTimeframe: htfTf,
            entryWindow: deps.entryWindow()
        }
    );

    // فیلتر سیگنال‌ها به بازه اصلی (بدون warmup)
    const signals = result.signals.filter(s => {
        if (dateFrom && s.time < dateFrom) return false;
        if (dateTo && s.time > dateTo) return false;
        return true;
    });

    // تبدیل به trades
    const closeAt = new Map(candles.map((c, i) => [c.time, { close: c.close, i }]));
    const trades = [];
    let open = null;

    for (const s of signals) {
        const c = closeAt.get(s.time);
        if (!c) continue;

        const tfMin = TIMEFRAME_MINUTES[cfg.timeframe] || 30;
        const fillDelaySec = tfMin * 60;   // سیگنال روی close کندل تأیید می‌شه

        if (s.signalType === 'BUY' && !open) {
            open = {
                entryTime: s.time,
                entryFillTime: s.time + fillDelaySec,      // ← لحظه ورود واقعی
                entryPrice: c.close,
                entryIdx: c.i,
                reason: s.reason,
                status: 'open',
                signalInfo: s.indicators || {}
            };
        } else if (s.signalType === 'EXIT_LONG' && open) {
            trades.push({
                ...open,
                exitTime: s.time,
                exitFillTime: s.time + fillDelaySec,       // ← لحظه خروج واقعی
                exitPrice: c.close,
                pnlPct: (c.close / open.entryPrice - 1) * 100,
                bars: c.i - open.entryIdx,
                exitReason: s.reason,
                status: 'closed'
            });
            open = null;
        }
    }
    if (open) trades.push(open);

    return { trades, candles, htf };
}

// ============================================================
// Incremental trade cache
// ============================================================
async function loadTradeCache(sigHash) {
    return deps.getDB().collection(COLLECTIONS.BACKTEST_TRADE_CACHE).findOne({ _id: sigHash });
}

async function saveTradeCache(sigHash, signature, coveredFrom, coveredTo, trades) {
    await deps.getDB().collection(COLLECTIONS.BACKTEST_TRADE_CACHE).updateOne(
        { _id: sigHash },
        { $set: {
            signature,
            coveredFrom, coveredTo,
            trades,
            tradeCount: trades.length,
            computedAt: new Date()
        }},
        { upsert: true }
    );
}

/**
 * بازگرداندن trades برای بازه [from, to] با کش افزایشی.
 * computeFn(cfg, from, to) باید آرایه trades برگردونه.
 */
async function getOrComputeTrades(cfg, from, to, mode, computeFn, onProgress) {
    const signature = buildSignature(cfg, mode);
    const sigHash = makeCacheKey(signature);
    const cached = await loadTradeCache(sigHash);

    // A) بدون cache
    if (!cached) {
        if (onProgress) onProgress({ phase: 'compute', from, to });
        const trades = await computeFn(cfg, from, to);
        await saveTradeCache(sigHash, signature, from, to, trades);
        return { trades, cached: false, computedRanges: [[from, to]], signature: sigHash };
    }

    // B) cache کامل پوشش می‌ده
    if (cached.coveredFrom <= from && cached.coveredTo >= to) {
        const filtered = cached.trades.filter(t => t.entryTime >= from && t.entryTime <= to);
        return { trades: filtered, cached: true, computedRanges: [], signature: sigHash };
    }

    // C) به آینده اضافه شده
    if (from >= cached.coveredFrom && to > cached.coveredTo) {
        if (onProgress) onProgress({ phase: 'extend-future', from: cached.coveredTo, to });
        const newTrades = await computeFn(cfg, cached.coveredTo, to);
        const merged = [...cached.trades, ...newTrades].sort((a, b) => a.entryTime - b.entryTime);
        await saveTradeCache(sigHash, signature, cached.coveredFrom, to, merged);
        const filtered = merged.filter(t => t.entryTime >= from && t.entryTime <= to);
        return {
            trades: filtered,
            cached: false,
            computedRanges: [[cached.coveredTo, to]],
            signature: sigHash,
            reusedFromCache: cached.trades.length
        };
    }

    // D) به عقب اضافه شده — فقط دلتای گذشته رو compute کن
    if (from < cached.coveredFrom) {
        if (onProgress) onProgress({ phase: 'extend-past', from, to: cached.coveredFrom });

        // فقط بخش جدید گذشته — از from تا cached.coveredFrom
        const newPastTrades = await computeFn(cfg, from, cached.coveredFrom);

        // cached trades از cached.coveredFrom به بعد دست‌نخورده می‌مونن
        const survivingCached = cached.trades.filter(t => t.entryTime >= cached.coveredFrom);

        let merged = [...newPastTrades, ...survivingCached]
            .sort((a, b) => a.entryTime - b.entryTime);

        // اگه به آینده هم نیازه
        if (to > cached.coveredTo) {
            if (onProgress) onProgress({ phase: 'extend-future', from: cached.coveredTo, to });
            const futureTrades = await computeFn(cfg, cached.coveredTo, to);
            merged = [...merged, ...futureTrades].sort((a, b) => a.entryTime - b.entryTime);
        }

        const newFrom = from;
        const newTo = Math.max(to, cached.coveredTo);
        await saveTradeCache(sigHash, signature, newFrom, newTo, merged);

        const filtered = merged.filter(t => t.entryTime >= from && t.entryTime <= to);
        return {
            trades: filtered,
            cached: false,
            computedRanges: [
                [from, cached.coveredFrom],
                ...(to > cached.coveredTo ? [[cached.coveredTo, to]] : [])
            ],
            signature: sigHash,
            reusedFromCache: survivingCached.length
        };
    }

    // fallback
    const trades = await computeFn(cfg, from, to);
    await saveTradeCache(sigHash, signature, from, to, trades);
    return { trades, cached: false, computedRanges: [[from, to]], signature: sigHash };
}

async function invalidateCacheForConfig(configId) {
    return deps.getDB().collection(COLLECTIONS.BACKTEST_TRADE_CACHE).deleteMany({
        'signature.configId': String(configId)
    });
}

async function clearTradeCache() {
    return deps.getDB().collection(COLLECTIONS.BACKTEST_TRADE_CACHE).deleteMany({});
}

// ============================================================
// Analytics — Sharpe, Sortino, MaxDD, Equity
// ============================================================
function computeStats(trades) {
    const n = trades.length;
    if (!n) {
        return {
            count: 0, winRate: 0, avgPnl: 0, totalPnl: 0,
            profitFactor: null, avgWin: 0, avgLoss: 0,
            maxWin: 0, maxLoss: 0, avgDaysHeld: 0,
            sharpe: null, sortino: null, maxDrawdownPct: 0, calmar: null
        };
    }

    const wins = trades.filter(t => t.pnlPct > 0);
    const losses = trades.filter(t => t.pnlPct <= 0);
    const sum = arr => arr.reduce((s, x) => s + x.pnlPct, 0);
    const gp = sum(wins);
    const gl = -sum(losses);
    const pf = gl > 0 ? gp / gl : (gp > 0 ? null : 0);

    // Sharpe/Sortino روی بازده معاملات
    const meanPnl = sum(trades) / n;
    const variance = trades.reduce((s, t) => s + (t.pnlPct - meanPnl) ** 2, 0) / Math.max(n - 1, 1);
    const stdDev = Math.sqrt(variance);
    const downside = trades.filter(t => t.pnlPct < 0);
    const downsideVar = downside.length
        ? downside.reduce((s, t) => s + t.pnlPct ** 2, 0) / downside.length
        : 0;
    const downsideStd = Math.sqrt(downsideVar);

    const tradesPerYear = n * (TRADING_DAYS_PER_YEAR / Math.max(
        1, trades.reduce((s, t) => s + (t.exitTime - t.entryTime) / 86400, 0)
    ));
    const annFactor = Math.sqrt(Math.max(1, tradesPerYear));

    const sharpe = stdDev > 0 ? (meanPnl / stdDev) * annFactor : null;
    const sortino = downsideStd > 0 ? (meanPnl / downsideStd) * annFactor : null;

    // Equity curve + Max Drawdown
    let equity = 100;
    let peak = 100;
    let maxDD = 0;
    const equityCurve = [];
    for (const t of trades) {
        equity *= (1 + t.pnlPct / 100);
        equityCurve.push({ time: t.exitTime, equity: round2(equity) });
        if (equity > peak) peak = equity;
        const dd = ((peak - equity) / peak) * 100;
        if (dd > maxDD) maxDD = dd;
    }

    const totalReturnPct = equity - 100;
    const calmar = maxDD > 0 ? totalReturnPct / maxDD : null;

    return {
        count: n,
        winRate: wins.length / n * 100,
        avgPnl: meanPnl,
        totalPnl: sum(trades),
        totalReturnPct,
        profitFactor: pf,
        avgWin: wins.length ? gp / wins.length : 0,
        avgLoss: losses.length ? -gl / losses.length : 0,
        maxWin: Math.max(...trades.map(t => t.pnlPct)),
        maxLoss: Math.min(...trades.map(t => t.pnlPct)),
        avgDaysHeld: trades.reduce((s, t) => s + (t.exitTime - t.entryTime) / 86400, 0) / n,
        sharpe: round2(sharpe),
        sortino: round2(sortino),
        maxDrawdownPct: round2(maxDD),
        calmar: round2(calmar),
        equityCurve
    };
}
// ============================================================
// Jalali conversion
// ============================================================
function gregorianToJalali(gy, gm, gd) {
    const g_d_m = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
    let jy = (gy <= 1600) ? 0 : 979;
    gy -= (gy <= 1600) ? 621 : 1600;
    const gy2 = (gm > 2) ? (gy + 1) : gy;
    let days = (365 * gy) + Math.floor((gy2 + 3) / 4) - Math.floor((gy2 + 99) / 100)
        + Math.floor((gy2 + 399) / 400) - 80 + gd + g_d_m[gm - 1];
    jy += 33 * Math.floor(days / 12053);
    days %= 12053;
    jy += 4 * Math.floor(days / 1461);
    days %= 1461;
    if (days > 365) {
        jy += Math.floor((days - 1) / 365);
        days = (days - 1) % 365;
    }
    const jm = (days < 186) ? 1 + Math.floor(days / 31) : 7 + Math.floor((days - 186) / 30);
    const jd = 1 + ((days < 186) ? (days % 31) : ((days - 186) % 30));
    return { jy, jm, jd };
}

const JALALI_MONTHS = [
    'فروردین', 'اردیبهشت', 'خرداد',
    'تیر', 'مرداد', 'شهریور',
    'مهر', 'آبان', 'آذر',
    'دی', 'بهمن', 'اسفند'
];

// ============================================================
// Advanced analytics
// ============================================================
function computeMonthlyReturns(trades) {
    const map = new Map();
    for (const t of trades) {
        const entryT = deps.getTehranParts(new Date(t.entryTime * 1000));
        const { jy, jm } = gregorianToJalali(entryT.year, entryT.month, entryT.day);
        const key = `${jy}-${String(jm).padStart(2, '0')}`;
        if (!map.has(key)) map.set(key, { pnl: 0, count: 0, wins: 0, jy, jm });
        const m = map.get(key);
        m.pnl += t.pnlPct;
        m.count++;
        if (t.pnlPct > 0) m.wins++;
    }
    return Array.from(map.values()).map(v => ({
        monthKey: `${v.jy}-${String(v.jm).padStart(2, '0')}`,
        monthLabel: `${JALALI_MONTHS[v.jm - 1]} ${v.jy}`,
        year: v.jy, month: v.jm,
        totalPnl: round2(v.pnl),
        avgPnl: round2(v.pnl / v.count),
        count: v.count,
        winRate: round2(v.wins / v.count * 100)
    })).sort((a, b) => a.monthKey.localeCompare(b.monthKey));
}

function computeHourlyReturns(trades) {
    const map = new Map();
    for (const t of trades) {
        const entryT = deps.getTehranParts(new Date(t.entryTime * 1000));
        const h = entryT.hour;
        if (!map.has(h)) map.set(h, { pnl: 0, count: 0, wins: 0 });
        const x = map.get(h);
        x.pnl += t.pnlPct;
        x.count++;
        if (t.pnlPct > 0) x.wins++;
    }
    return Array.from(map.entries()).map(([h, v]) => ({
        hour: h,
        hourLabel: `${String(h).padStart(2, '0')}:00`,
        totalPnl: round2(v.pnl),
        avgPnl: round2(v.pnl / v.count),
        count: v.count,
        winRate: round2(v.wins / v.count * 100)
    })).sort((a, b) => a.hour - b.hour);
}

const DOW_NAMES = {
    Sat: 'شنبه', Sun: 'یک‌شنبه', Mon: 'دوشنبه',
    Tue: 'سه‌شنبه', Wed: 'چهارشنبه', Thu: 'پنج‌شنبه', Fri: 'جمعه'
};
const DOW_ORDER = { Sat: 0, Sun: 1, Mon: 2, Tue: 3, Wed: 4, Thu: 5, Fri: 6 };

function computeDayOfWeekReturns(trades) {
    const map = new Map();
    for (const t of trades) {
        const entryT = deps.getTehranParts(new Date(t.entryTime * 1000));
        const d = entryT.weekday;
        if (!map.has(d)) map.set(d, { pnl: 0, count: 0, wins: 0 });
        const x = map.get(d);
        x.pnl += t.pnlPct;
        x.count++;
        if (t.pnlPct > 0) x.wins++;
    }
    return Array.from(map.entries()).map(([d, v]) => ({
        day: d,
        dayLabel: DOW_NAMES[d] || d,
        totalPnl: round2(v.pnl),
        avgPnl: round2(v.pnl / v.count),
        count: v.count,
        winRate: round2(v.wins / v.count * 100)
    })).sort((a, b) => DOW_ORDER[a.day] - DOW_ORDER[b.day]);
}

function computeEMA(closes, period) {
    const ema = new Array(closes.length).fill(null);
    if (closes.length < period) return ema;
    let s = 0;
    for (let i = 0; i < period; i++) s += closes[i];
    ema[period - 1] = s / period;
    const k = 2 / (period + 1);
    for (let i = period; i < closes.length; i++) ema[i] = closes[i] * k + ema[i - 1] * (1 - k);
    return ema;
}

function computeRegimeBreakdown(trades, dailyCandles) {
    if (!dailyCandles || dailyCandles.length < 200) return null;
    const closes = dailyCandles.map(c => c.close);
    const ema20 = computeEMA(closes, 20);
    const ema50 = computeEMA(closes, 50);
    const ema200 = computeEMA(closes, 200);
    const times = dailyCandles.map(c => c.time);

    function regimeAt(timeSec) {
        let idx = -1;
        for (let i = 0; i < times.length; i++) {
            if (times[i] <= timeSec) idx = i; else break;
        }
        if (idx < 0 || ema200[idx] === null || ema20[idx] === null || ema50[idx] === null) return 'unknown';
        const c = closes[idx];
        if (c > ema200[idx] && ema20[idx] > ema50[idx]) return 'bull';
        if (c < ema200[idx] && ema20[idx] < ema50[idx]) return 'bear';
        return 'range';
    }

    const stats = {
        bull: { count: 0, wins: 0, pnl: 0 },
        bear: { count: 0, wins: 0, pnl: 0 },
        range: { count: 0, wins: 0, pnl: 0 },
        unknown: { count: 0, wins: 0, pnl: 0 }
    };
    for (const t of trades) {
        const r = regimeAt(t.entryTime);
        stats[r].count++;
        stats[r].pnl += t.pnlPct;
        if (t.pnlPct > 0) stats[r].wins++;
    }
    const labels = { bull: 'صعودی', bear: 'نزولی', range: 'رنج', unknown: 'نامشخص' };
    const result = [];
    for (const k of ['bull', 'bear', 'range', 'unknown']) {
        if (stats[k].count > 0) {
            result.push({
                regime: k,
                regimeLabel: labels[k],
                count: stats[k].count,
                avgPnl: round2(stats[k].pnl / stats[k].count),
                totalPnl: round2(stats[k].pnl),
                winRate: round2(stats[k].wins / stats[k].count * 100)
            });
        }
    }
    return result;
}

function computeEquityCurve(trades) {
    const sorted = [...trades].sort((a, b) => (a.exitFillTime || a.exitTime) - (b.exitFillTime || b.exitTime));
    let eq = 100;
    let peak = 100;
    const curve = [{ time: sorted.length ? sorted[0].entryTime : 0, equity: 100, drawdown: 0 }];
    for (const t of sorted) {
        eq *= (1 + t.pnlPct / 100);
        if (eq > peak) peak = eq;
        const dd = ((peak - eq) / peak) * 100;
        curve.push({
            time: t.exitFillTime || t.exitTime,
            equity: round2(eq),
            drawdown: round2(dd),
            pnl: t.pnlPct,
            reason: t.exitReason || null
        });
    }
    return curve;
}
// ============================================================
// Rolling Segments (شبیه walk-forward ساده)
// ============================================================
function computeRollingSegments(trades, numSegments = 10) {
    if (!trades || trades.length < numSegments) return null;

    const sorted = [...trades].sort((a, b) => a.entryTime - b.entryTime);
    const minTime = sorted[0].entryTime;
    const maxTime = sorted[sorted.length - 1].entryTime;
    const range = maxTime - minTime;
    if (range <= 0) return null;
    const segSize = range / numSegments;

    const segments = [];
    for (let i = 0; i < numSegments; i++) {
        const from = minTime + i * segSize;
        const to = minTime + (i + 1) * segSize;
        const segTrades = sorted.filter(t => t.entryTime >= from && t.entryTime < to);
        if (!segTrades.length) {
            segments.push({ index: i + 1, from, to, count: 0 });
            continue;
        }
        const wins = segTrades.filter(t => t.pnlPct > 0);
        const sum = segTrades.reduce((s, t) => s + t.pnlPct, 0);
        const gp = wins.reduce((s, t) => s + t.pnlPct, 0);
        const gl = -segTrades.filter(t => t.pnlPct <= 0).reduce((s, t) => s + t.pnlPct, 0);
        segments.push({
            index: i + 1,
            from, to,
            count: segTrades.length,
            winRate: round2(wins.length / segTrades.length * 100),
            avgPnl: round2(sum / segTrades.length),
            totalPnl: round2(sum),
            profitFactor: gl > 0 ? round2(gp / gl) : (gp > 0 ? null : 0)
        });
    }

    // consistency: چند درصد پنجره‌ها سودده بودن
    const profitable = segments.filter(s => s.count > 0 && s.totalPnl > 0).length;
    const withData = segments.filter(s => s.count > 0).length;

    return {
        segments,
        numSegments,
        withData,
        profitable,
        consistencyPct: withData ? round2(profitable / withData * 100) : 0
    };
}

// ============================================================
// Monte Carlo Bootstrap
// ============================================================
function computeMonteCarlo(trades, iterations = 10000) {
    if (!trades || !trades.length) return null;
    const pnls = trades.map(t => t.pnlPct);
    const N = pnls.length;

    const totalReturns = new Array(iterations);
    const maxDDs = new Array(iterations);
    const sharpes = new Array(iterations);

    for (let iter = 0; iter < iterations; iter++) {
        let eq = 100;
        let peak = 100;
        let maxDD = 0;
        let sum = 0, sumSq = 0;

        for (let i = 0; i < N; i++) {
            const p = pnls[Math.floor(Math.random() * N)];
            eq *= (1 + p / 100);
            if (eq > peak) peak = eq;
            const dd = (peak - eq) / peak * 100;
            if (dd > maxDD) maxDD = dd;
            sum += p;
            sumSq += p * p;
        }
        const mean = sum / N;
        const variance = Math.max(sumSq / N - mean * mean, 0);
        const std = Math.sqrt(variance);
        const sharpe = std > 0 ? (mean / std) * Math.sqrt(N) : 0;

        totalReturns[iter] = eq - 100;
        maxDDs[iter] = maxDD;
        sharpes[iter] = sharpe;
    }

    totalReturns.sort((a, b) => a - b);
    maxDDs.sort((a, b) => a - b);
    sharpes.sort((a, b) => a - b);

    const pctAt = (arr, p) => arr[Math.floor(arr.length * p / 100)];
    const avg = arr => arr.reduce((a, b) => a + b, 0) / arr.length;

    const probLoss = totalReturns.filter(r => r < 0).length / iterations * 100;
    const probBigDD = maxDDs.filter(d => d > 30).length / iterations * 100;

    // histogram
    const minR = totalReturns[0];
    const maxR = totalReturns[totalReturns.length - 1];
    const bucketSize = (maxR - minR) / 20 || 1;
    const histogram = new Array(20).fill(0);
    for (const r of totalReturns) {
        const idx = Math.min(19, Math.floor((r - minR) / bucketSize));
        histogram[idx]++;
    }

    return {
        iterations,
        returns: {
            min: round2(totalReturns[0]),
            p5: round2(pctAt(totalReturns, 5)),
            p25: round2(pctAt(totalReturns, 25)),
            median: round2(pctAt(totalReturns, 50)),
            p75: round2(pctAt(totalReturns, 75)),
            p95: round2(pctAt(totalReturns, 95)),
            max: round2(totalReturns[totalReturns.length - 1]),
            mean: round2(avg(totalReturns))
        },
        maxDrawdowns: {
            best: round2(maxDDs[0]),
            p5: round2(pctAt(maxDDs, 5)),
            median: round2(pctAt(maxDDs, 50)),
            p95: round2(pctAt(maxDDs, 95)),
            worst: round2(maxDDs[maxDDs.length - 1])
        },
        sharpes: {
            p5: round2(pctAt(sharpes, 5)),
            median: round2(pctAt(sharpes, 50)),
            p95: round2(pctAt(sharpes, 95))
        },
        probLoss: round2(probLoss),
        probBigDD: round2(probBigDD),
        histogram: histogram.map((c, i) => ({
            from: round2(minR + i * bucketSize),
            to: round2(minR + (i + 1) * bucketSize),
            count: c
        }))
    };
}

// ============================================================
// Robustness — حذف بهترین‌ها و بدترین‌ها
// ============================================================
function computeRobustness(trades) {
    if (!trades || trades.length < 5) return null;

    const sorted = [...trades].sort((a, b) => b.pnlPct - a.pnlPct);
    const N = sorted.length;

    const stats = arr => {
        if (!arr.length) return { count: 0, totalPnl: 0, avgPnl: 0, winRate: 0, profitFactor: null };
        const wins = arr.filter(t => t.pnlPct > 0);
        const sum = arr.reduce((s, t) => s + t.pnlPct, 0);
        const gp = wins.reduce((s, t) => s + t.pnlPct, 0);
        const gl = -arr.filter(t => t.pnlPct <= 0).reduce((s, t) => s + t.pnlPct, 0);
        return {
            count: arr.length,
            totalPnl: round2(sum),
            avgPnl: round2(sum / arr.length),
            winRate: round2(wins.length / arr.length * 100),
            profitFactor: gl > 0 ? round2(gp / gl) : (gp > 0 ? null : 0)
        };
    };

    const k = Math.max(1, Math.floor(N * 0.1));   // ۱۰٪ بهترین و بدترین

    return {
        full: stats(sorted),
        withoutTop10: stats(sorted.slice(k)),       // بدون k بهترین
        withoutTopAndBottom10: stats(sorted.slice(k, N - k)),  // بدون k بهترین و k بدترین
        top10PctContribution: (() => {
            const topSum = sorted.slice(0, k).reduce((s, t) => s + t.pnlPct, 0);
            const fullSum = sorted.reduce((s, t) => s + t.pnlPct, 0);
            return fullSum !== 0 ? round2(topSum / fullSum * 100) : 0;
        })(),
        topK: k
    };
}
function computeAdvancedStats(trades, dailyCandles) {
    if (!trades || !trades.length) {
        return { monthly: [], hourly: [], dow: [], regime: [], equityCurve: [], rolling: null, monteCarlo: null, robustness: null };
    }
    return {
        monthly: computeMonthlyReturns(trades),
        hourly: computeHourlyReturns(trades),
        dow: computeDayOfWeekReturns(trades),
        regime: computeRegimeBreakdown(trades, dailyCandles),
        equityCurve: computeEquityCurve(trades),
        rolling: computeRollingSegments(trades, 10),
        monteCarlo: computeMonteCarlo(trades, 10000),
        robustness: computeRobustness(trades)
    };
}
function round2(v) {
    if (v === null || v === undefined || !Number.isFinite(v)) return null;
    return Math.round(v * 100) / 100;
}

// ============================================================
// Full backtest for a config (stock + option)
// ============================================================
async function runBacktest(cfg, from, to, opts = {}) {
    const mode = opts.useRealOption ? 'real' : 'hybrid';

    const computeFn = async (c, f, t) => {
        const r = await computeStockTrades(c, f, t);
        return r.trades.filter(x => x.status === 'closed');
    };

    const tradeRes = await getOrComputeTrades(cfg, from, to, mode, computeFn, opts.onProgress);

    if (opts.onProgress) opts.onProgress({ phase: 'option-backtest', tradeCount: tradeRes.trades.length });

    const optionResult = await deps.options.runHybridOptionBacktest(
        cfg.symbol,
        tradeRes.trades,
        { realEnabled: !!opts.useRealOption }
    );

    // آمار پایه
    const stockStats = computeStats(tradeRes.trades);
    const optionStats = computeStats(optionResult.trades || []);

    // دیتای روزانه برای regime
    let dailyCandles = [];
    try {
        dailyCandles = await deps.dataService.getCandles(cfg.symbol, '1d');
    } catch (_) {}

    // آمار پیشرفته — روی معاملات آپشن (چون خروجی واقعی کاربر)
    const advanced = computeAdvancedStats(optionResult.trades || tradeRes.trades, dailyCandles);

    return {
        stockTradesCount: tradeRes.trades.length,
        stockClosedCount: tradeRes.trades.length,
        dateRange: { from, to },
        cached: tradeRes.cached,
        reusedFromCache: tradeRes.reusedFromCache || 0,
        computedRanges: tradeRes.computedRanges || [],
        cacheSignature: tradeRes.signature,
        stockStats,
        optionStats,
        advanced,
        ...optionResult
    };
}

module.exports = {
    init,
    makeCacheKey, buildSignature,
    computeStockTrades,
    getOrComputeTrades,
    loadTradeCache, saveTradeCache,
    invalidateCacheForConfig, clearTradeCache,
    computeStats, runBacktest,
    computeAdvancedStats,
    computeRollingSegments,
    computeMonteCarlo,
    computeRobustness,
    gregorianToJalali,
    JALALI_MONTHS
};