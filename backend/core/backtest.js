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
    entryWindow: () => ({ start: 9 * 60 + 30, end: 12 * 60 })
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

        if (s.signalType === 'BUY' && !open) {
            open = {
                entryTime: s.time,
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

    // D) به عقب اضافه شده
    if (from < cached.coveredFrom) {
        if (onProgress) onProgress({ phase: 'extend-past', from, to: cached.coveredTo });
        const pastTrades = await computeFn(cfg, from, cached.coveredTo);
        let merged;
        if (to > cached.coveredTo) {
            const futureTrades = await computeFn(cfg, cached.coveredTo, to);
            merged = [...pastTrades, ...futureTrades].sort((a, b) => a.entryTime - b.entryTime);
        } else {
            merged = [...pastTrades].sort((a, b) => a.entryTime - b.entryTime);
        }
        const newFrom = from;
        const newTo = Math.max(to, cached.coveredTo);
        await saveTradeCache(sigHash, signature, newFrom, newTo, merged);
        const filtered = merged.filter(t => t.entryTime >= from && t.entryTime <= to);
        return {
            trades: filtered,
            cached: false,
            computedRanges: [
                [from, cached.coveredTo],
                ...(to > cached.coveredTo ? [[cached.coveredTo, to]] : [])
            ],
            signature: sigHash
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

    // آمار حرفه‌ای روی معاملات سهم
    const stockStats = computeStats(tradeRes.trades);
    // آمار حرفه‌ای روی معاملات آپشن
    const optionStats = computeStats(optionResult.trades || []);

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
    computeStats, runBacktest
};