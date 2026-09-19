'use strict';
// تست‌های خودکار core/backtest.js
// اجرا: node backend/tests/backtest.test.js

const assert = require('assert');

// Stub برای deps (core/backtest.js نیاز به دیتا نداره برای computeStats)
const path = require('path');
const backtest = require(path.join(__dirname, '..', 'core', 'backtest'));

let passed = 0, failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`✅ ${name}`);
        passed++;
    } catch (e) {
        console.error(`❌ ${name}: ${e.message}`);
        failed++;
    }
}

// ---- computeStats ----
test('computeStats با ۳ معامله سودده', () => {
    const trades = [
        { entryTime: 1000, exitTime: 2000, pnlPct: 5 },
        { entryTime: 3000, exitTime: 4000, pnlPct: 3 },
        { entryTime: 5000, exitTime: 6000, pnlPct: 4 }
    ];
    const s = backtest.computeStats(trades);
    assert.strictEqual(s.count, 3);
    assert.strictEqual(s.winRate, 100);
    assert.ok(s.totalPnl > 0);
    assert.ok(s.sharpe !== null);
});

test('computeStats با ترکیب سود/ضرر', () => {
    const trades = [
        { entryTime: 1000, exitTime: 2000, pnlPct: 10 },
        { entryTime: 3000, exitTime: 4000, pnlPct: -5 },
        { entryTime: 5000, exitTime: 6000, pnlPct: 8 }
    ];
    const s = backtest.computeStats(trades);
    assert.strictEqual(s.count, 3);
    assert.strictEqual(Math.round(s.winRate), 67);
    assert.ok(s.profitFactor > 1);
    assert.ok(s.maxDrawdownPct >= 0);
});

test('computeStats با آرایه خالی', () => {
    const s = backtest.computeStats([]);
    assert.strictEqual(s.count, 0);
    assert.strictEqual(s.winRate, 0);
    assert.strictEqual(s.sharpe, null);
});

test('computeStats محاسبه Sharpe', () => {
    const trades = [];
    for (let i = 0; i < 10; i++) {
        trades.push({
            entryTime: i * 1000,
            exitTime: i * 1000 + 500,
            pnlPct: i % 2 === 0 ? 5 : -2
        });
    }
    const s = backtest.computeStats(trades);
    assert.strictEqual(s.count, 10);
    assert.ok(typeof s.sharpe === 'number');
    assert.ok(typeof s.sortino === 'number');
});

test('makeCacheKey سازگار است', () => {
    const k1 = backtest.makeCacheKey({ a: 1, b: 2 });
    const k2 = backtest.makeCacheKey({ a: 1, b: 2 });
    const k3 = backtest.makeCacheKey({ a: 2, b: 1 });
    assert.strictEqual(k1, k2);
    assert.notStrictEqual(k1, k3);
});

test('buildSignature فیلد symbol داره', () => {
    const sig = backtest.buildSignature({ symbol: 'فملی', strategyId: 'rsi50_2', timeframe: '30m' }, 'hybrid');
    assert.strictEqual(sig.symbol, 'فملی');
    assert.strictEqual(sig.strategyId, 'rsi50_2');
});

// ---- نتیجه ----
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);