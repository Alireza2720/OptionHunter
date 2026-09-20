'use strict';
// تست‌های PIT Enforcer
// اجرا: node backend/tests/pit.test.js

const assert = require('assert');
const path = require('path');
const { PITContext, checkTrainTestOverlap, rangeFromPayload } =
    require(path.join(__dirname, '..', 'core', 'pit'));

let passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); console.log(`✅ ${name}`); passed++; }
    catch (e) { console.error(`❌ ${name}: ${e.message}`); failed++; }
}

// ---- PITContext ----
test('allows past events', () => {
    const pit = new PITContext(new Date('2024-06-01'));
    assert.strictEqual(pit.allows(new Date('2024-05-31')), true);
    assert.strictEqual(pit.allows(new Date('2024-06-01')), true);
});

test('rejects future events', () => {
    const pit = new PITContext(new Date('2024-06-01'));
    assert.strictEqual(pit.allows(new Date('2024-06-02')), false);
});

test('allows unix timestamps', () => {
    const pit = new PITContext('2024-06-01');
    const past = Math.floor(new Date('2024-05-01').getTime() / 1000);
    const future = Math.floor(new Date('2024-07-01').getTime() / 1000);
    assert.strictEqual(pit.allows(past), true);
    assert.strictEqual(pit.allows(future), false);
});

test('filter removes future docs and counts violations', () => {
    const pit = new PITContext('2024-06-01');
    const docs = [
        { time: new Date('2024-05-01'), v: 'a' },
        { time: new Date('2024-06-02'), v: 'b' },
        { time: new Date('2024-05-15'), v: 'c' },
    ];
    const filtered = pit.filter(docs);
    assert.strictEqual(filtered.length, 2);
    assert.strictEqual(pit.violations.length, 1);
    assert.strictEqual(filtered[0].v, 'a');
    assert.strictEqual(filtered[1].v, 'c');
});

test('throws without asOfTime', () => {
    assert.throws(() => new PITContext(null), /requires asOfTime/);
    assert.throws(() => new PITContext(undefined), /requires asOfTime/);
});

test('handles null/undefined time gracefully', () => {
    const pit = new PITContext('2024-06-01');
    assert.strictEqual(pit.allows(null), true);
    assert.strictEqual(pit.allows(undefined), true);
});

// ---- checkTrainTestOverlap ----
test('clean walk-forward (test after train)', () => {
    const r = checkTrainTestOverlap([1000, 2000], [2001, 3000]);
    assert.strictEqual(r.overlap, false);
    assert.strictEqual(r.severity, 'ok');
});

test('overlap detected', () => {
    const r = checkTrainTestOverlap([1000, 2500], [2000, 3000]);
    assert.strictEqual(r.overlap, true);
    assert.strictEqual(r.severity, 'critical');
});

test('train on all data → critical', () => {
    const r = checkTrainTestOverlap([null, null], [1000, 2000]);
    assert.strictEqual(r.overlap, true);
    assert.strictEqual(r.severity, 'critical');
});

test('test completely before train (clean)', () => {
    const r = checkTrainTestOverlap([2001, 3000], [1000, 2000]);
    assert.strictEqual(r.overlap, false);
    assert.strictEqual(r.severity, 'ok');
});

test('missing range → warning', () => {
    const r = checkTrainTestOverlap(null, [1000, 2000]);
    assert.strictEqual(r.severity, 'warning');
});

// ---- rangeFromPayload ----
test('extracts range from dateFrom/dateTo', () => {
    const r = rangeFromPayload({ dateFrom: '1700000000', dateTo: '1800000000' });
    assert.deepStrictEqual(r, [1700000000, 1800000000]);
});

test('extracts range from from/to', () => {
    const r = rangeFromPayload({ from: 1700000000, to: 1800000000 });
    assert.deepStrictEqual(r, [1700000000, 1800000000]);
});

test('returns nulls for missing range', () => {
    const r = rangeFromPayload({});
    assert.deepStrictEqual(r, [null, null]);
});

// ---- نتیجه ----
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);