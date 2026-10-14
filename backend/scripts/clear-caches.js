'use strict';
// clear-caches.js — v2 — clears backtest + GA caches (used after logic version bumps)
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '..', '.env');
if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const eq = t.indexOf('=');
        if (eq < 1) continue;
        const k = t.slice(0, eq).trim();
        let v = t.slice(eq + 1).trim();
        if (v.length >= 2 && v[0] === v[v.length - 1] && (v[0] === '"' || v[0] === "'")) v = v.slice(1, -1);
        if (process.env[k] === undefined) process.env[k] = v;
    }
}

const uri = process.env.MONGO_URI;
if (!uri) { console.error('MONGO_URI not found in .env'); process.exit(1); }

const { MongoClient } = require(path.join(__dirname, '..', '..', 'node_modules', 'mongodb'));

(async () => {
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
    await client.connect();
    const db = client.db('trading_bot');

    // v1 — result-level caches
    const r1 = await db.collection('backtest_result_cache').deleteMany({});
    const r2 = await db.collection('meta').deleteMany({ _id: { $regex: '^backtest_result_' } });
    const r3 = await db.collection('backtest_compare_details').deleteMany({});

    // v2 — trade cache + GA state (invalidated by Stage 9.2 logic-version bump)
    const r4 = await db.collection('backtest_trade_cache').deleteMany({});
    const r5 = await db.collection('meta').deleteMany({ _id: { $regex: '^ga_state_' } });
    const r6 = await db.collection('meta').deleteMany({ _id: 'ga_redundancy' });

    console.log(JSON.stringify({
        result_cache_deleted: r1.deletedCount,
        meta_result_deleted: r2.deletedCount,
        compare_details_deleted: r3.deletedCount,
        trade_cache_deleted: r4.deletedCount,
        ga_state_deleted: r5.deletedCount,
        ga_redundancy_deleted: r6.deletedCount
    }));
    await client.close();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
