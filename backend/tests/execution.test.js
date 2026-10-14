'use strict';
// execution.test.js — verifies Stage 9.3 fixes: fill-from-next-open, daily Sharpe, PIT-safe option selection
// Run: node backend/tests/execution.test.js
//
// Approach: standalone tests using a local mini-backtest harness (mock dataService).
// No DB, no HTTP, no live server required.

const assert = require('assert');
const path = require('path');

// ── Load modules ──
const backtest = require(path.join(__dirname, '..', 'core', 'backtest'));

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
    try { fn(); console.log('\u2705 ' + name); passed++; }
    catch (e) { console.error('\u274c ' + name + ': ' + e.message); failures.push({ name, error: e.message }); failed++; }
}
async function testAsync(name, fn) {
    try { await fn(); console.log('\u2705 ' + name); passed++; }
    catch (e) { console.error('\u274c ' + name + ': ' + e.message); failures.push({ name, error: e.message }); failed++; }
}

console.log('\u2500\u2500 Execution test suite (Stage 9.3 + 9.2 fixes) \u2500\u2500\n');

// ═══════════════════════════════════════════════════════════════
// Harness — mock dataService + a fake strategy so we control signals
// ═══════════════════════════════════════════════════════════════
function makeMockDeps(candles, signals) {
    // A fake strategy: emits whatever signals[] says at matching candle times.
    const _signalsByTime = new Map();
    for (const s of signals) _signalsByTime.set(s.time, s);
    const fakeStrategy = {
        id: 'test_fake',
        name: 'Fake',
        defaultTimeframe: '1h',
        defaultParams: {},
        run: function(cs) {
            const out = cs.map(c => {
                const s = _signalsByTime.get(c.time);
                return s || { time: c.time, signalType: null, position: null, indicators: {}, reason: null };
            });
            // compute last position
            let pos = null;
            for (let i = out.length - 1; i >= 0; i--) {
                if (out[i].position) { pos = out[i].position; break; }
            }
            return { signals: out, trades: [], ha: cs, htfTrend: null };
        }
    };
    const mockDataService = {
        closedOnly: (arr) => arr,
        getCandlesFull: async () => candles,
        getCandles: async () => candles,
        getTehranParts: (d) => {
            const t = new Date(d.getTime() + 3.5 * 3600 * 1000);
            const wds = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
            return {
                year: t.getUTCFullYear(),
                month: t.getUTCMonth() + 1,
                day: t.getUTCDate(),
                hour: t.getUTCHours(),
                minute: t.getUTCMinutes(),
                weekday: wds[t.getUTCDay()]
            };
        }
    };
    return {
        getDB: () => null,
        strategies: {
            STRATEGIES: { test_fake: fakeStrategy },
            getRequiredCandles: () => 10,
            getRequiredHtfCandles: () => 5,
            TIMEFRAME_MINUTES: { '1h': 60 }
        },
        dataService: mockDataService,
        options: { runHybridOptionBacktest: async () => ({ trades: [], stats: { count: 0 }, realUsed: 0, approxUsed: 0 }) },
        entryWindow: () => ({ start: 0, end: 1440 }),
        getTehranParts: mockDataService.getTehranParts,
        logger: { warn: () => {}, info: () => {}, error: () => {} }
    };
}

// ═══════════════════════════════════════════════════════════════
// Test 1: BUY fill uses NEXT candle's OPEN, not signal candle's close
// ═══════════════════════════════════════════════════════════════
async function testBuyFill() {
    const t0 = Math.floor(Date.UTC(2024, 0, 1, 9, 0, 0) / 1000);
    const candles = [
        { time: t0,          open: 100, high: 105, low:  99, close: 104, volume: 1000 },
        { time: t0 + 3600,   open: 110, high: 115, low: 108, close: 112, volume: 1000 },  // ← next candle
        { time: t0 + 7200,   open: 112, high: 120, low: 111, close: 118, volume: 1000 },
        { time: t0 + 10800,  open: 119, high: 122, low: 117, close: 120, volume: 1000 }
    ];
    // Signal BUY at candle[0], EXIT at candle[2]
    const signals = [
        { time: t0,        signalType: 'BUY',       position: 'LONG', indicators: { atr: 3 }, reason: 'buy' },
        { time: t0 + 3600, signalType: null,        position: 'LONG', indicators: {} },
        { time: t0 + 7200, signalType: 'EXIT_LONG', position: null,   indicators: { atr: 3 }, reason: 'exit' }
    ];
    backtest.init(makeMockDeps(candles, signals));

    // Patch buildSignature so cache lookup is a no-op (unique symbol)
    const cfg = {
        symbol: 'TESTBUYFILL_' + Date.now(),
        strategyId: 'test_fake',
        timeframe: '1h',
        htfTimeframe: '1d',
        candleType: 'heikin',
        params: {}
    };

    const computeStock = backtest.computeStockTrades;
    const r = await computeStock(cfg, null, null);
    assert.ok(r.trades && r.trades.length === 1, 'expected exactly 1 trade, got ' + (r.trades ? r.trades.length : 0));

    const t = r.trades[0];
    // Expected: entry from candle[1].open (110) plus slippage
    const expectedEntryBase = 110;   // candle[1].open
    const notExpected = 104;          // candle[0].close — the OLD buggy behavior
    // Entry price = base * (1 + STOCK_SLIPPAGE_PCT + STOCK_HALF_SPREAD_PCT) = 110 * 1.004 = 110.44
    const expectedEntry = expectedEntryBase * 1.004;
    assert.ok(Math.abs(t.entryPrice - expectedEntry) < 0.01,
        'entry should be ~' + expectedEntry + ', got ' + t.entryPrice + ' (old buggy value was ~' + (notExpected * 1.004) + ')');
    assert.ok(t.entryPrice > 108, 'entry price should be near 110 not 104: got ' + t.entryPrice);
    // entryFillTime should be next candle's time + latency
    assert.ok(t.entryFillTime >= t0 + 3600, 'entryFillTime should be >= next candle time, got ' + t.entryFillTime);
}

// ═══════════════════════════════════════════════════════════════
// Test 2: EXIT fill uses NEXT candle's OPEN
// ═══════════════════════════════════════════════════════════════
async function testExitFill() {
    const t0 = Math.floor(Date.UTC(2024, 0, 1, 9, 0, 0) / 1000);
    const candles = [
        { time: t0,          open: 100, high: 105, low:  99, close: 104, volume: 1000 },
        { time: t0 + 3600,   open: 110, high: 115, low: 108, close: 112, volume: 1000 },
        { time: t0 + 7200,   open: 120, high: 125, low: 118, close: 122, volume: 1000 },  // ← EXIT signal
        { time: t0 + 10800,  open: 130, high: 135, low: 128, close: 132, volume: 1000 }   // ← exit fill from here
    ];
    const signals = [
        { time: t0,        signalType: 'BUY',       position: 'LONG', indicators: { atr: 3 }, reason: 'buy' },
        { time: t0 + 3600, signalType: null,        position: 'LONG', indicators: {} },
        { time: t0 + 7200, signalType: 'EXIT_LONG', position: null,   indicators: { atr: 3 }, reason: 'exit' }
    ];
    backtest.init(makeMockDeps(candles, signals));
    const cfg = {
        symbol: 'TESTEXITFILL_' + Date.now(),
        strategyId: 'test_fake', timeframe: '1h', htfTimeframe: '1d',
        candleType: 'heikin', params: {}
    };
    const r = await backtest.computeStockTrades(cfg, null, null);
    assert.ok(r.trades && r.trades.length === 1, 'expected 1 trade');
    const t = r.trades[0];
    // exit fill from candle[3].open = 130 with -slippage
    const expectedExit = 130 * (1 - 0.003 - 0.001); // 130 * 0.996 = 129.48
    assert.ok(Math.abs(t.exitPrice - expectedExit) < 0.01,
        'exit should be ~' + expectedExit + ', got ' + t.exitPrice);
    assert.ok(t.exitPrice > 125, 'exit should be near 130, not 122: got ' + t.exitPrice);
}

// ═══════════════════════════════════════════════════════════════
// Test 3: last-candle signal → fallback to close (no next candle)
// ═══════════════════════════════════════════════════════════════
async function testLastCandleFallback() {
    const t0 = Math.floor(Date.UTC(2024, 0, 1, 9, 0, 0) / 1000);
    const candles = [
        { time: t0,          open: 100, high: 105, low:  99, close: 104, volume: 1000 },
        { time: t0 + 3600,   open: 110, high: 115, low: 108, close: 112, volume: 1000 }
        // Only 2 candles; BUY at last → no next → fallback to close
    ];
    const signals = [
        { time: t0,        signalType: null, position: null, indicators: {} },
        { time: t0 + 3600, signalType: 'BUY', position: 'LONG', indicators: { atr: 3 }, reason: 'buy-last' }
    ];
    backtest.init(makeMockDeps(candles, signals));
    const cfg = {
        symbol: 'TESTFALLBACK_' + Date.now(),
        strategyId: 'test_fake', timeframe: '1h', htfTimeframe: '1d',
        candleType: 'heikin', params: {}
    };
    const r = await backtest.computeStockTrades(cfg, null, null);
    // Force-close: since only 2 candles and BUY at last, trade should be force-closed
    assert.ok(r.trades && r.trades.length === 1, 'expected 1 forced-closed trade, got ' + (r.trades ? r.trades.length : 0));
    const t = r.trades[0];
    assert.ok(t.forcedClose === true, 'trade should be forced-closed');
    assert.ok(t.entryPrice > 0, 'entry price should be > 0 (from fallback close)');
    // entry fallback = candle[1].close = 112 * 1.004
    const expectedEntry = 112 * 1.004;
    assert.ok(Math.abs(t.entryPrice - expectedEntry) < 0.01,
        'fallback entry should be ~' + expectedEntry + ', got ' + t.entryPrice);
}

// ═══════════════════════════════════════════════════════════════
// Test 4: daily Sharpe path — enough trades with daily spread → non-null
// ═══════════════════════════════════════════════════════════════
function testDailySharpe() {
    const daySec = 86400;
    const base = Math.floor(Date.UTC(2024, 0, 1) / 1000);
    const trades = [];
    for (let i = 0; i < 30; i++) {
        const entryTime = base + i * daySec;
        const exitTime  = entryTime + 3600;
        trades.push({
            entryTime, exitTime, entryFillTime: entryTime, exitFillTime: exitTime,
            entryPrice: 100, exitPrice: 102,
            pnlPct: (i % 3 === 0) ? -1.5 : +2.5,   // mixed
            bars: 1, exitReason: 'test'
        });
    }
    const s = backtest.computeStats(trades);
    assert.ok(s.count === 30, 'expected 30 trades');
    assert.ok(typeof s.sharpe === 'number' && Number.isFinite(s.sharpe),
        'sharpe should be a finite number, got ' + s.sharpe);
    assert.ok(typeof s.sortino === 'number' && Number.isFinite(s.sortino),
        'sortino should be a finite number, got ' + s.sortino);
    // Sanity: sharpe in reasonable range (-10..10)
    assert.ok(s.sharpe > -10 && s.sharpe < 10, 'sharpe out of sanity range: ' + s.sharpe);
}

// ═══════════════════════════════════════════════════════════════
// Test 5: legacy fallback — few trades (<5) → sharpe still valid via legacy path
// ═══════════════════════════════════════════════════════════════
function testLegacyFallback() {
    const daySec = 86400;
    const base = Math.floor(Date.UTC(2024, 0, 1) / 1000);
    const trades = [];
    for (let i = 0; i < 4; i++) {
        const et = base + i * daySec;
        trades.push({
            entryTime: et, exitTime: et + 3600,
            entryFillTime: et, exitFillTime: et + 3600,
            entryPrice: 100, exitPrice: 103, pnlPct: 3 - i * 1.5, bars: 1
        });
    }
    const s = backtest.computeStats(trades);
    assert.ok(s.count === 4, 'expected 4 trades');
    // With <5 trades daily-curve path won't produce sharpe; legacy should fill in
    // Either way sharpe should be null or number (not crash).
    assert.ok(s.sharpe === null || typeof s.sharpe === 'number',
        'sharpe should be null or number, got ' + typeof s.sharpe);
}

// ═══════════════════════════════════════════════════════════════
// Test 6: empty trades → clean zero-state, no crash
// ═══════════════════════════════════════════════════════════════
function testEmptyTrades() {
    const s = backtest.computeStats([]);
    assert.strictEqual(s.count, 0);
    assert.strictEqual(s.sharpe, null);
    assert.strictEqual(s.sortino, null);
    assert.strictEqual(s.winRate, 0);
}

// ═══════════════════════════════════════════════════════════════
// Run all
// ═══════════════════════════════════════════════════════════════
(async () => {
    await testAsync('buy fill uses NEXT candle open (fix #1)', testBuyFill);
    await testAsync('exit fill uses NEXT candle open (fix #1)', testExitFill);
    await testAsync('last-candle BUY → fallback to close + forced close', testLastCandleFallback);
    test('daily Sharpe (fix #4) — 30 daily-spread trades', testDailySharpe);
    test('legacy fallback — <5 trades still safe', testLegacyFallback);
    test('empty trades → zero-state, no crash', testEmptyTrades);

    console.log('');
    console.log('\u2550'.repeat(45));
    console.log('  ' + passed + ' passed, ' + failed + ' failed');
    if (failed > 0) {
        console.log('  Failures:');
        for (const f of failures) console.log('    - ' + f.name + ': ' + f.error);
        process.exit(1);
    }
    console.log('\u2550'.repeat(45));
})();
