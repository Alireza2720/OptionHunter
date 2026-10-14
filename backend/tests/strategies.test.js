'use strict';
// strategies.test.js — automated sanity + future-independence tests for all strategies
// Run: node backend/tests/strategies.test.js
//
// Groups (4):
//   1) runs       — every strategy executes on synthetic candles without crashing
//   2) empty      — empty input does not crash
//   3) future-indep — future candle mutations do NOT change past signals
//   4) schema     — every actionable signal has valid time/signalType
//
// Skipped strategies:
//   - pairs_spread, sector_momentum, ensemble (need extra context)
//   - deprecated (dual_thrust, rsi2_mr, orb_pro, gap_and_go, *_pro)

const assert = require('assert');
const path = require('path');
const STRAT_MODULE = require(path.join(__dirname, '..', 'strategies'));
const STRATEGIES = STRAT_MODULE.STRATEGIES;

const SKIP = new Set([
    'pairs_spread', 'sector_momentum', 'ensemble'
]);

// Deterministic synthetic 1h candles
function genCandles(n, opts) {
    opts = opts || {};
    const drift = opts.drift != null ? opts.drift : 1.0;
    const out = [];
    let price = 10000;
    const start = Math.floor(Date.UTC(2024, 0, 1) / 1000);
    for (let i = 0; i < n; i++) {
        const noise = Math.sin(i / 7) * 20 + Math.cos(i / 11) * 15;
        const open = price;
        const close = price + drift + noise;
        const high = Math.max(open, close) + Math.abs(noise) + 5;
        const low  = Math.min(open, close) - Math.abs(noise) - 5;
        out.push({
            time: start + i * 3600,
            open, high, low, close,
            volume: 100000 + (i % 100) * 1000
        });
        price = close;
    }
    return out;
}

function _ctx(def, candles) {
    return {
        htfCandles: candles.slice(),
        htfTimeframe: def.htfTimeframe || '1d',
        entryWindow: { start: 0, end: 1440 }
    };
}

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
    try {
        fn();
        console.log('\u2705 ' + name);
        passed++;
    } catch (e) {
        console.error('\u274c ' + name + ': ' + e.message);
        failures.push({ name, error: e.message });
        failed++;
    }
}

const ids = Object.keys(STRATEGIES)
    .filter(id => !SKIP.has(id) && !STRATEGIES[id].deprecated);

console.log('\u2500\u2500 Strategy test suite \u2500\u2500');
console.log('  total strategies in registry : ' + Object.keys(STRATEGIES).length);
console.log('  supported (tested)           : ' + ids.length);
console.log('  skipped (context-needing)    : ' + Array.from(SKIP).join(', '));
console.log('');

// ── Group 1: runs ──
for (const id of ids) {
    test('runs: ' + id, () => {
        const def = STRATEGIES[id];
        const c = genCandles(600, { drift: 1.5 });
        const r = def.run(c, def.defaultParams, _ctx(def, c));
        assert.ok(r, 'result is null');
        assert.ok(Array.isArray(r.signals), 'signals not array');
        assert.ok(r.signals.length === c.length,
            'signals length != candles length (' + r.signals.length + ' vs ' + c.length + ')');
    });
}

// ── Group 2: empty ──
for (const id of ids) {
    test('empty: ' + id, () => {
        const def = STRATEGIES[id];
        let r = null;
        try {
            r = def.run([], def.defaultParams, _ctx(def, []));
        } catch (e) {
            throw new Error('crashed on empty: ' + e.message);
        }
        assert.ok(r, 'result null on empty');
        assert.ok(Array.isArray(r.signals), 'signals not array on empty');
    });
}

// ── Group 3: future-independence ──
const CUT = 350;
for (const id of ids) {
    test('future-indep: ' + id, () => {
        const def = STRATEGIES[id];
        const c1 = genCandles(600, { drift: 1.5 });
        const c2 = JSON.parse(JSON.stringify(c1));
        // Wildly mutate future candles after CUT
        for (let i = CUT; i < c2.length; i++) {
            const base = 5000 + Math.sin(i) * 2000 + Math.cos(i * 1.7) * 1500;
            c2[i].open = base;
            c2[i].close = base + Math.sin(i * 2.3) * 800;
            c2[i].high = Math.max(c2[i].open, c2[i].close) + 900;
            c2[i].low  = Math.min(c2[i].open, c2[i].close) - 900;
            c2[i].volume = 1 + (i * 31) % 500;
        }
        const r1 = def.run(c1, def.defaultParams, _ctx(def, c1));
        const r2 = def.run(c2, def.defaultParams, _ctx(def, c2));
        const s1 = r1.signals.slice(0, CUT).filter(s => s.signalType);
        const s2 = r2.signals.slice(0, CUT).filter(s => s.signalType);
        assert.strictEqual(s1.length, s2.length,
            'signal count before cut differs (' + s1.length + ' vs ' + s2.length + ')');
        for (let i = 0; i < s1.length; i++) {
            assert.strictEqual(s1[i].time, s2[i].time, 'signal[' + i + '] time differs');
            assert.strictEqual(s1[i].signalType, s2[i].signalType, 'signal[' + i + '] type differs');
        }
    });
}

// ── Group 4: schema ──
for (const id of ids) {
    test('schema: ' + id, () => {
        const def = STRATEGIES[id];
        const c = genCandles(600, { drift: 1.5 });
        const r = def.run(c, def.defaultParams, _ctx(def, c));
        const act = r.signals.filter(s => s.signalType === 'BUY' || s.signalType === 'EXIT_LONG');
        const t0 = c[0].time;
        const tN = c[c.length - 1].time;
        for (const s of act) {
            assert.ok(Number.isFinite(s.time), 'signal time not finite');
            assert.ok(s.time >= t0 && s.time <= tN, 'signal time out of range: ' + s.time);
        }
    });
}

// ── Summary ──
console.log('');
console.log('\u2550'.repeat(45));
console.log('  ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) {
    console.log('  Failures:');
    for (const f of failures) console.log('    - ' + f.name + ': ' + f.error);
    process.exit(1);
}
console.log('\u2550'.repeat(45));
