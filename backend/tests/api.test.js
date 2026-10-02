'use strict';
// API Test — بررسی endpointهای اصلی backend
// اجرا: node backend/tests/api.test.js

const http = require('http');

const BASE = process.env.API_URL || 'http://127.0.0.1:3000';
const TOKEN = process.env.ADMIN_TOKEN || '';

let passed = 0, failed = 0;
const failures = [];

function fetchJson(path) {
    return new Promise((resolve, reject) => {
        const url = new URL(path, BASE);
        const opts = {
            method: 'GET',
            headers: { 'x-admin-token': TOKEN },
            timeout: 10000
        };
        const req = http.request(url, opts, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, json: JSON.parse(data) });
                } catch (e) {
                    reject(new Error(`invalid JSON (status ${res.statusCode}): ${data.slice(0, 200)}`));
                }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.end();
    });
}

async function test(name, fn) {
    try {
        await fn();
        console.log(`✅ ${name}`);
        passed++;
    } catch (e) {
        console.error(`❌ ${name}: ${e.message}`);
        failures.push({ name, error: e.message });
        failed++;
    }
}

(async () => {
    console.log('══════════════════════════════════════');
    console.log('  OptionHunter API Test');
    console.log(`  Target: ${BASE}`);
    console.log('══════════════════════════════════════\n');

    // 1. Ping
    console.log('── Basic ──');
    await test('GET /ping → 200', async () => {
        const r = await fetchJson('/ping');
        if (r.status !== 200) throw new Error(`status=${r.status}`);
        if (!r.json.pong) throw new Error('pong not true');
    });

    await test('GET / → has status', async () => {
        const r = await fetchJson('/');
        if (r.status !== 200) throw new Error(`status=${r.status}`);
        if (r.json.status !== 'ok') throw new Error(`status=${r.json.status}`);
    });

    // 2. Strategies
    console.log('\n── Strategies ──');
    await test('GET /api/strategies → array', async () => {
        const r = await fetchJson('/api/strategies');
        if (!Array.isArray(r.json)) throw new Error('not an array');
        if (r.json.length < 10) throw new Error(`only ${r.json.length} strategies`);
    });

    await test('GET /api/timeframes → array', async () => {
        const r = await fetchJson('/api/timeframes');
        if (!Array.isArray(r.json)) throw new Error('not an array');
    });

    // 3. Symbols
    console.log('\n── Symbols ──');
    await test('GET /api/monitored-symbols → array', async () => {
        const r = await fetchJson('/api/monitored-symbols');
        if (!Array.isArray(r.json)) throw new Error('not an array');
    });

    // 4. Pipeline
    console.log('\n── Pipeline ──');
    await test('GET /api/pipeline/dual-stage/preview', async () => {
        const r = await fetchJson('/api/pipeline/dual-stage/preview');
        if (r.status !== 200) throw new Error(`status=${r.status}, body=${JSON.stringify(r.json)}`);
        if (typeof r.json.totalConfigs !== 'number') throw new Error('totalConfigs missing');
    });

    await test('GET /api/pipeline/dual-stage/list', async () => {
        const r = await fetchJson('/api/pipeline/dual-stage/list?limit=5');
        if (r.status !== 200) throw new Error(`status=${r.status}`);
        if (!Array.isArray(r.json.jobs)) throw new Error('jobs not array');
    });

    // 5. Coverage
    console.log('\n── Coverage ──');
    await test('GET /api/algotik/coverage', async () => {
        const r = await fetchJson('/api/algotik/coverage');
        if (r.status !== 200) throw new Error(`status=${r.status}`);
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