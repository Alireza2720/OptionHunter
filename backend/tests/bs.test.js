'use strict';
// تست‌های خودکار core/options.js (Black-Scholes)
// اجرا: node backend/tests/bs.test.js

const assert = require('assert');
const path = require('path');
const options = require(path.join(__dirname, '..', 'core', 'options'));

// options.js نیاز به init داره ولی برای BS و IV بدون init هم کار می‌کنه
options.init({
    getDB: () => { throw new Error('test - db not needed'); },
    settings: {
        get: () => ({ RISK_FREE_RATE: 0.05, OPTION_FEE_BUY: 0.001, OPTION_FEE_SELL: 0.001 })
    }
});

let passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); console.log(`✅ ${name}`); passed++; }
    catch (e) { console.error(`❌ ${name}: ${e.message}`); failed++; }
}

test('bsCall قیمت مرجع (ATM, 1y)', () => {
    const c = options.bsCall(100, 100, 1, 0.05, 0.2);
    // مرجع: 10.4506
    assert.ok(Math.abs(c.price - 10.45) < 0.05, `expected ~10.45, got ${c.price}`);
});

test('bsCall دلتا در محدوده معقول (ATM)', () => {
    const c = options.bsCall(100, 100, 1, 0.05, 0.2);
    // مرجع: 0.6368
    assert.ok(c.delta > 0.62 && c.delta < 0.66);
});

test('bsCall ITM (S > K) دلتا بالاتر', () => {
    const c = options.bsCall(110, 100, 1, 0.05, 0.2);
    assert.ok(c.delta > 0.7);
});

test('bsCall OTM (S < K) دلتا پایین‌تر', () => {
    const c = options.bsCall(90, 100, 1, 0.05, 0.2);
    assert.ok(c.delta < 0.5);
});

test('impliedVol معکوس bsCall', () => {
    const targetPrice = 10.4505835722;
    const iv = options.impliedVol(targetPrice, 100, 100, 1, 0.05);
    assert.ok(iv !== null);
    assert.ok(Math.abs(iv - 0.2) < 0.01, `expected ~0.2, got ${iv}`);
});

test('impliedVol با قیمت خیلی کم برمی‌گردونه null', () => {
    const iv = options.impliedVol(0.01, 100, 100, 1, 0.05);
    assert.strictEqual(iv, null);
});

test('impliedVol با T=0 برمی‌گردونه null', () => {
    const iv = options.impliedVol(10, 100, 100, 0, 0.05);
    assert.strictEqual(iv, null);
});

test('normCdf مقادیر مرجع', () => {
    assert.ok(Math.abs(options.normCdf(0) - 0.5) < 0.001);
    assert.ok(Math.abs(options.normCdf(1.96) - 0.975) < 0.005);
    assert.ok(Math.abs(options.normCdf(-1.96) - 0.025) < 0.005);
});

test('norm (نرمال‌سازی فارسی)', () => {
    assert.strictEqual(options.norm('فملی'), 'فملی');
    assert.strictEqual(options.norm('فملي'), 'فملی');  // ی عربی
    assert.strictEqual(options.norm('ف م ل ی'), 'فملی');
    assert.strictEqual(options.norm('فملی '), 'فملی');
});

test('matchUnderlying تطبیق دقیق', () => {
    assert.strictEqual(options.matchUnderlying('فملی', ['فملی']), true);
    assert.strictEqual(options.matchUnderlying('فملي', ['فملی']), true);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);