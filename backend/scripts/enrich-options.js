#!/usr/bin/env node
'use strict';
// enrich-options.js — fill missing bid/ask for HISTORICAL option_history rows
//
// Usage:
//   node backend/scripts/enrich-options.js                    # dry-run (default)
//   node backend/scripts/enrich-options.js --apply            # write
//   node backend/scripts/enrich-options.js --apply --spread=20
//   node backend/scripts/enrich-options.js --apply --symbol=اهرم
//
// Rules:
//   - ONLY rows with time < todayStart (historical)
//   - ONLY rows missing bid or bid <= 0
//   - NEVER touch source live_snapshot or algotik_snapshot
//   - Synthetic rows get source = 'synthetic_daily'

const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '..', '.env');
if (!fs.existsSync(envPath)) { console.error('ERROR: .env not found: ' + envPath); process.exit(1); }

const envVars = {};
for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 1) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if (v.length >= 2 && v[0] === v[v.length-1] && (v[0] === '"' || v[0] === "'")) v = v.slice(1, -1);
    envVars[k] = v;
}

const { MongoClient } = require(path.join(__dirname, '..', '..', 'node_modules', 'mongodb'));

const ARGV = process.argv.slice(2);
const APPLY = ARGV.includes('--apply');
const DRY_RUN = !APPLY;
const SPREAD = (() => {
    const a = ARGV.find(x => x.startsWith('--spread='));
    return a ? parseFloat(a.split('=')[1]) : 20;
})();
const SYMBOL = (() => {
    const a = ARGV.find(x => x.startsWith('--symbol='));
    return a ? a.split('=')[1] : null;
})();

if (!Number.isFinite(SPREAD) || SPREAD <= 0 || SPREAD > 50) {
    console.error('ERROR: --spread must be between 0 and 50');
    process.exit(1);
}

(async () => {
    const client = new MongoClient(envVars.MONGO_URI, { serverSelectionTimeoutMS: 8000 });
    await client.connect();
    const db = client.db('trading_bot');
    const col = db.collection('option_history');

    const now = new Date();
    const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

    console.log('========================================================');
    console.log('  Enrich historical option_history with synthetic bid/ask');
    console.log('========================================================');
    console.log('  Mode:    ' + (DRY_RUN ? 'DRY-RUN (use --apply to write)' : 'APPLY (writing)'));
    console.log('  Spread:  ' + SPREAD + '% (' + (SPREAD/2) + '% each side)');
    console.log('  Cutoff:  time < ' + todayStart.toISOString());
    console.log('  Symbol:  ' + (SYMBOL || 'all'));
    console.log('========================================================');
    console.log('');

    const filter = {
        close: { $gt: 1 },
        time: { $lt: todayStart },
        $or: [{ bid: null }, { bid: { $exists: false } }, { bid: { $lte: 0 } }],
        source: { $nin: ['live_snapshot', 'algotik_snapshot'] },
    };
    if (SYMBOL) filter.underlying = SYMBOL;

    const total = await col.countDocuments(filter);
    console.log('Historical rows missing bid/ask: ' + total);

    if (total === 0) {
        console.log('');
        console.log('Nothing to do.');
        await client.close();
        return;
    }

    console.log('');
    console.log('Sample (first 5):');
    const samples = await col.find(filter).limit(5).toArray();
    for (const s of samples) {
        const bid = Math.round(s.close * (1 - SPREAD/200));
        const ask = Math.round(s.close * (1 + SPREAD/200));
        console.log('  ' + s.underlying + ' ' + s.symbol + ' ' + s.time.toISOString().slice(0,10) + ' close=' + s.close + ' -> bid=' + bid + ' ask=' + ask);
    }

    if (DRY_RUN) {
        console.log('');
        console.log('========================================================');
        console.log('DRY-RUN complete. To apply: --apply');
        console.log('========================================================');
        await client.close();
        return;
    }

    console.log('');
    console.log('Writing...');
    let processed = 0, updated = 0;
    let bulk = [];
    const nowTs = new Date();

    const cursor = col.find(filter);
    for await (const doc of cursor) {
        processed++;
        if (!doc.close || doc.close <= 1) continue;
        const bid = Math.round(doc.close * (1 - SPREAD/200));
        const ask = Math.round(doc.close * (1 + SPREAD/200));
        bulk.push({
            updateOne: {
                filter: { _id: doc._id },
                update: { $set: {
                    bid, ask,
                    source: 'synthetic_daily',
                    syntheticSpreadPct: SPREAD,
                    enrichedAt: nowTs,
                } },
            },
        });
        if (bulk.length >= 500) {
            const r = await col.bulkWrite(bulk, { ordered: false });
            updated += r.modifiedCount;
            bulk = [];
            console.log('  progress: ' + processed + '/' + total);
        }
    }
    if (bulk.length) {
        const r = await col.bulkWrite(bulk, { ordered: false });
        updated += r.modifiedCount;
    }

    console.log('');
    console.log('========================================================');
    console.log('DONE: ' + processed + ' processed, ' + updated + ' updated');
    console.log('========================================================');

    await client.close();
})().catch(e => { console.error('FATAL:', e); process.exit(1); });