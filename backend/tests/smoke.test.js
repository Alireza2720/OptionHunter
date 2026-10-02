'use strict';
// Smoke test — بررسی سلامت پایه‌ی ماژول‌ها
// اجرا: node backend/tests/smoke.test.js

const path = require('path');
let passed = 0, failed = 0;
const failures = [];

function test(name, fn) {
    try {
        fn();
        console.log(`✅ ${name}`);
        passed++;
    } catch (e) {
        console.error(`❌ ${name}: ${e.message}`);
        failures.push({ name, error: e.message });
        failed++;
    }
}

function asyncTest(name, fn) {
    return fn().then(() => {
        console.log(`✅ ${name}`);
        passed++;
    }).catch((e) => {
        console.error(`❌ ${name}: ${e.message}`);
        failures.push({ name, error: e.message });
        failed++;
    });
}

(async () => {
    console.log('══════════════════════════════════════');
    console.log('  OptionHunter Smoke Test');
    console.log('══════════════════════════════════════\n');

    // 1. ماژول‌ها لود می‌شن
    console.log('── Module Loading ──');
    test('core/backtest.js loads', () => {
        require(path.join(__dirname, '..', 'core', 'backtest'));
    });
    test('core/options.js loads', () => {
        require(path.join(__dirname, '..', 'core', 'options'));
    });
    test('core/signals.js loads', () => {
        require(path.join(__dirname, '..', 'core', 'signals'));
    });
    test('core/execution-guard.js loads', () => {
        require(path.join(__dirname, '..', 'core', 'execution-guard'));
    });
    test('strategies.js loads', () => {
        const s = require(path.join(__dirname, '..', 'strategies'));
        if (!s.STRATEGIES) throw new Error('STRATEGIES undefined');
        if (Object.keys(s.STRATEGIES).length < 10) throw new Error('too few strategies');
    });
    test('config/constants.js loads', () => {
        const c = require(path.join(__dirname, '..', 'config', 'constants'));
        if (!c.COLLECTIONS) throw new Error('COLLECTIONS undefined');
        if (!c.OPTION_DATA_CUTOFF) throw new Error('OPTION_DATA_CUTOFF undefined');
    });

    // 2. تابع‌های کلیدی موجودن
    console.log('\n── Key Functions ──');
    test('backtest.computeStats exists', () => {
        const b = require(path.join(__dirname, '..', 'core', 'backtest'));
        if (typeof b.computeStats !== 'function') throw new Error('not a function');
    });
    test('options.bsCall exists', () => {
        const o = require(path.join(__dirname, '..', 'core', 'options'));
        if (typeof o.bsCall !== 'function') throw new Error('not a function');
    });
    test('options.impliedVol exists', () => {
        const o = require(path.join(__dirname, '..', 'core', 'options'));
        if (typeof o.impliedVol !== 'function') throw new Error('not a function');
    });

    // 3. computeStats با داده‌ی ساختگی
    console.log('\n── computeStats Logic ──');
    test('computeStats: empty array', () => {
        const b = require(path.join(__dirname, '..', 'core', 'backtest'));
        const s = b.computeStats([]);
        if (s.count !== 0) throw new Error('count should be 0');
        if (s.sharpe !== null) throw new Error('sharpe should be null');
    });
    test('computeStats: 3 winning trades', () => {
        const b = require(path.join(__dirname, '..', 'core', 'backtest'));
        const trades = [
            { entryTime: 1000, exitTime: 2000, pnlPct: 5 },
            { entryTime: 3000, exitTime: 4000, pnlPct: 3 },
            { entryTime: 5000, exitTime: 6000, pnlPct: 4 }
        ];
        const s = b.computeStats(trades);
        if (s.count !== 3) throw new Error(`count=${s.count}, expected 3`);
        if (s.winRate !== 100) throw new Error(`winRate=${s.winRate}, expected 100`);
        if (!Number.isFinite(s.maxWin)) throw new Error(`maxWin=${s.maxWin}, not finite`);
        if (s.maxWin !== 5) throw new Error(`maxWin=${s.maxWin}, expected 5`);
    });
    test('computeStats: mixed win/loss', () => {
        const b = require(path.join(__dirname, '..', 'core', 'backtest'));
        const trades = [
            { entryTime: 1000, exitTime: 2000, pnlPct: 10 },
            { entryTime: 3000, exitTime: 4000, pnlPct: -5 },
            { entryTime: 5000, exitTime: 6000, pnlPct: 8 }
        ];
        const s = b.computeStats(trades);
        if (Math.round(s.winRate) !== 67) throw new Error(`winRate=${s.winRate}`);
        if (s.profitFactor <= 1) throw new Error('PF should be > 1');
    });

    // 4. Black-Scholes
    console.log('\n── Black-Scholes ──');
    test('bsCall: ATM 1y standard', () => {
        const o = require(path.join(__dirname, '..', 'core', 'options'));
        // رفرنس: 10.4506
        const c = o.bsCall(100, 100, 1, 0.05, 0.2);
        if (Math.abs(c.price - 10.45) > 0.05) throw new Error(`price=${c.price}`);
        if (Math.abs(c.delta - 0.6368) > 0.01) throw new Error(`delta=${c.delta}`);
    });
    test('impliedVol: inverse check', () => {
        const o = require(path.join(__dirname, '..', 'core', 'options'));
        const price = 10.4505835722;
        const iv = o.impliedVol(price, 100, 100, 1, 0.05);
        if (iv === null) throw new Error('iv is null');
        if (Math.abs(iv - 0.2) > 0.01) throw new Error(`iv=${iv}, expected ~0.2`);
    });

    // 5. Strategies registry
    console.log('\n── Strategies Registry ──');
    test('all strategies have required fields', () => {
        const s = require(path.join(__dirname, '..', 'strategies'));
        for (const [id, def] of Object.entries(s.STRATEGIES)) {
            if (!def.id) throw new Error(`${id}: missing id`);
            if (!def.name) throw new Error(`${id}: missing name`);
            if (!def.defaultTimeframe) throw new Error(`${id}: missing defaultTimeframe`);
            if (!def.defaultParams) throw new Error(`${id}: missing defaultParams`);
            if (typeof def.run !== 'function') throw new Error(`${id}: run not a function`);
        }
    });

    // 6. Cache key generation
    console.log('\n── Cache Key ──');
    test('buildSignature consistency', () => {
        const b = require(path.join(__dirname, '..', 'core', 'backtest'));
        const cfg = { symbol: 'فملی', strategyId: 'smc_unicorn', timeframe: '1h', params: {} };
        const sig1 = b.buildSignature(cfg, 'stock');
        const sig2 = b.buildSignature(cfg, 'stock');
        if (JSON.stringify(sig1) !== JSON.stringify(sig2)) throw new Error('not consistent');
    });
    test('makeCacheKey stable', () => {
        const b = require(path.join(__dirname, '..', 'core', 'backtest'));
        const k1 = b.makeCacheKey({ a: 1, b: 2 });
        const k2 = b.makeCacheKey({ a: 1, b: 2 });
        const k3 = b.makeCacheKey({ a: 2, b: 1 });
        if (k1 !== k2) throw new Error('not stable');
        if (k1 === k3) throw new Error('different keys collide');
    });

    // نتیجه
    console.log('\n══════════════════════════════════════');
    console.log(`  ${passed} passed, ${failed} failed`);
    if (failed > 0) {
        console.log('\n  Failures:');
        failures.forEach(f => console.log(`    - ${f.name}: ${f.error}`));
        process.exit(1);
    }
    console.log('══════════════════════════════════════');
})();