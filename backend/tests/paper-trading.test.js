'use strict';
// paper-trading.test.js — Integration test for Stage 11 (paper hook idempotency + orphan guard)
// Run: node backend/tests/paper-trading.test.js
// Approach: pure logic tests with mocked DB. No live server needed.

const assert = require('assert');

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

console.log('\u2500\u2500 Paper Trading Integration Test Suite (Stage 11) \u2500\u2500\n');

// ═══════════════════════════════════════════════════════════
// Mock DB — records updateOne/insertOne/findOne calls
// ═══════════════════════════════════════════════════════════
function makeMockDB() {
    const positions = [];      // option_positions
    const calls = { inserts: [], updates: [], findOnes: [] };
    return {
        positions, calls,
        collection(name) {
            return {
                async insertOne(doc) {
                    calls.inserts.push({ coll: name, doc });
                    const _id = 'mock_' + positions.length;
                    positions.push(Object.assign({ _id }, doc));
                    return { insertedId: _id };
                },
                async findOne(q) {
                    calls.findOnes.push({ coll: name, q });
                    for (const p of positions) {
                        if (q.underlying && p.underlying !== q.underlying) continue;
                        if (q.status && p.status !== q.status) continue;
                        if (q.paper !== undefined && p.paper !== q.paper) continue;
                        return p;
                    }
                    return null;
                },
                async updateOne(q, u) {
                    calls.updates.push({ coll: name, q, u });
                    for (const p of positions) {
                        if (q._id && p._id === q._id) {
                            Object.assign(p, u.$set || {});
                            return { modifiedCount: 1 };
                        }
                    }
                    return { modifiedCount: 0 };
                }
            };
        }
    };
}

// ═══════════════════════════════════════════════════════════
// Test 1: EXIT_LONG with no open paper BUY → skipped (Stage 11.5)
// ═══════════════════════════════════════════════════════════
(async () => {
    const paperTrading = require('/home/deploy/apps/OptionHunter/backend/services/paper-trading.service.js');

    await testAsync('EXIT_LONG with no open BUY → skipped orphan (Stage 11.5)', async () => {
        const db = makeMockDB();
        paperTrading.init({
            getDB: () => db,
            logger: { info: () => {}, warn: () => {}, error: () => {} },
            options: {
                fetchChain: async () => [],
                getNames: (s) => [s],
                DEFAULT_SETTINGS: {},
                buildScenario: async () => ({}),
                selectCalls: () => ({ picks: [] })
            }
        });

        const r = await paperTrading.recordSignal({
            symbol: 'TEST1',
            strategyId: 'smc_unicorn',
            signalType: 'EXIT_LONG',
            price: 10000,
            time: Math.floor(Date.now() / 1000),
            reason: 'test',
            indicators: {},
            htfTrend: null,
            timeframe: '1h'
        });

        assert.strictEqual(r.status, 'skipped', 'should be skipped');
        assert.strictEqual(r.skipReason, 'no open paper position', 'reason must mention no open position');
        assert.strictEqual(db.calls.inserts.length, 0, 'should NOT insert any doc');
    });

    // Test 2: BUY with empty chain → status=skipped with reason
    await testAsync('BUY with no matching contract → skipped with reason', async () => {
        const db = makeMockDB();
        paperTrading.init({
            getDB: () => db,
            logger: { info: () => {}, warn: () => {}, error: () => {} },
            options: {
                fetchChain: async () => [],
                getNames: (s) => [s],
                DEFAULT_SETTINGS: {},
                buildScenario: async () => ({ S: 10000 }),
                selectCalls: () => ({ picks: [], rejected: [{ symbol: 'X', reason: 'delta too high' }] })
            }
        });

        const r = await paperTrading.recordSignal({
            symbol: 'TEST2',
            strategyId: 'smc_unicorn',
            signalType: 'BUY',
            price: 10000,
            time: Math.floor(Date.now() / 1000),
            reason: 'test',
            indicators: {},
            htfTrend: null,
            timeframe: '1h'
        });

        assert.strictEqual(r.status, 'skipped', 'should be skipped');
        assert.ok(db.calls.inserts.length === 1, 'should insert ONE record');
        const doc = db.calls.inserts[0].doc;
        assert.strictEqual(doc.paper, true, 'should be marked as paper');
    });

    // Test 3: EXIT_LONG with open BUY → closes it
    await testAsync('EXIT_LONG with open BUY → closes position', async () => {
        const db = makeMockDB();
        // Pre-seed an open paper position
        db.positions.push({
            _id: 'p1',
            underlying: 'TEST3',
            symbol: 'ضتست3000',
            status: 'open',
            paper: true,
            entryAsk: 100,
            size: 1000
        });

        paperTrading.init({
            getDB: () => db,
            logger: { info: () => {}, warn: () => {}, error: () => {} },
            options: {
                fetchChain: async () => [{ symbol: 'ضتست3000', bid: 150 }],
                getNames: (s) => [s],
                DEFAULT_SETTINGS: {},
                buildScenario: async () => ({}),
                selectCalls: () => ({ picks: [] })
            }
        });

        const r = await paperTrading.recordSignal({
            symbol: 'TEST3',
            strategyId: 'smc_unicorn',
            signalType: 'EXIT_LONG',
            price: 10500,
            time: Math.floor(Date.now() / 1000),
            reason: 'test exit',
            indicators: {},
            htfTrend: null,
            timeframe: '1h'
        });

        assert.strictEqual(r.status, 'closed', 'should be closed');
        // Should have updated the position
        const upd = db.calls.updates.find(u => u.q._id === 'p1');
        assert.ok(upd, 'position should be updated');
        assert.strictEqual(upd.u.$set.status, 'closed');
        assert.ok(upd.u.$set.exitBid === 150, 'exitBid should be 150');
    });

    // Test 4: getReport on empty DB → no crash
    await testAsync('getReport on empty DB → zero stats', async () => {
        const db = makeMockDB();
        db.collection = (name) => ({
            find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => [] }) }) })
        });
        paperTrading.init({
            getDB: () => db,
            logger: { info: () => {}, warn: () => {}, error: () => {} },
            options: {}
        });
        const r = await paperTrading.getReport();
        assert.strictEqual(r.total, 0, 'total should be 0');
        assert.strictEqual(r.open, 0, 'open should be 0');
        assert.strictEqual(r.closed, 0, 'closed should be 0');
    });

    // Summary
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
