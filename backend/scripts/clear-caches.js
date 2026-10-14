'use strict';
// clear-caches.js — clears backtest result caches (used after logic version bumps)
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

    const r1 = await db.collection('backtest_result_cache').deleteMany({});
    const r2 = await db.collection('meta').deleteMany({ _id: { $regex: '^backtest_result_' } });
    const r3 = await db.collection('backtest_compare_details').deleteMany({});

    console.log(JSON.stringify({
        result_cache_deleted: r1.deletedCount,
        meta_result_deleted: r2.deletedCount,
        compare_details_deleted: r3.deletedCount
    }));
    await client.close();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
