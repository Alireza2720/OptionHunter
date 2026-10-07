#!/usr/bin/env node
'use strict';
// ============================================================
// diagnose-backtest-funnel.js — تحلیل فانل فیلتر backtest آپشن
// ============================================================
// هدف: فهمیدن این که از کل رکوردهای option_history، چند درصد
// از فیلترهای tryGetRealTradeDataFast عبور می‌کنن و چرا.
//
// Usage:
//   node backend/scripts/diagnose-backtest-funnel.js
//   node backend/scripts/diagnose-backtest-funnel.js --symbol اهرم
// ============================================================

const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '..', '.env');
if (!fs.existsSync(envPath)) {
    console.error('ERROR: .env not found at ' + envPath);
    process.exit(1);
}
const envVars = {};
for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 1) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if (v.length >= 2 && v[0] === v[v.length - 1] && (v[0] === '"' || v[0] === "'")) v = v.slice(1, -1);
    envVars[k] = v;
}

const { MongoClient } = require(path.join(__dirname, '..', '..', 'node_modules', 'mongodb'));

const ARGV = process.argv.slice(2);
const SYMBOL = (() => {
    const a = ARGV.find(x => x.startsWith('--symbol='));
    if (a) return a.split('=')[1];
    return null;
})();

(async () => {
    const uri = envVars.MONGO_URI;
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
    await client.connect();
    const db = client.db('trading_bot');
    const col = db.collection('option_history');

    const baseQ = SYMBOL ? { underlying: SYMBOL } : {};
    const bar = '='.repeat(70);

    console.log(bar);
    console.log('  Backtest Funnel Deep Dive' + (SYMBOL ? ' (symbol=' + SYMBOL + ')' : ''));
    console.log(bar);

    // ─── S1: delta distribution ───
    console.log('\n[S1] Delta distribution (bid/ask + daysLeft 7-90):');
    const deltaBuckets = await col.aggregate([
        { $match: { ...baseQ, bid: { $gt: 0 }, ask: { $gt: 0 }, daysLeft: { $gte: 7, $lte: 90 } } },
        { $bucket: {
            groupBy: '$deltaApi',
            boundaries: [-1, 0, 0.1, 0.2, 0.25, 0.35, 0.5, 0.65, 0.75, 0.85, 0.95, 1.01, 2],
            default: 'missing'
        }},
        { $group: { _id: '$_id', n: { $sum: 1 } } },
        { $sort: { _id: 1 } }
    ]).toArray();
    let totalWithBase = 0;
    for (const b of deltaBuckets) {
        console.log('  delta in ' + String(b._id).padEnd(10) + ' : ' + b.n.toLocaleString());
        if (b._id !== 'missing') totalWithBase += b.n;
    }
    console.log('  ' + '-'.repeat(50));
    console.log('  total (with delta): ' + totalWithBase.toLocaleString());

    // ─── S2: current filter (0.35 - 0.85) vs relaxed (0.25 - 0.95) ───
    console.log('\n[S2] Impact of delta range:');
    const inCurrent = await col.countDocuments({
        ...baseQ, bid: { $gt: 0 }, ask: { $gt: 0 },
        daysLeft: { $gte: 7, $lte: 90 },
        deltaApi: { $gte: 0.35, $lte: 0.85 }
    });
    const inRelaxed = await col.countDocuments({
        ...baseQ, bid: { $gt: 0 }, ask: { $gt: 0 },
        daysLeft: { $gte: 7, $lte: 90 },
        deltaApi: { $gte: 0.25, $lte: 0.95 }
    });
    const inLoose = await col.countDocuments({
        ...baseQ, bid: { $gt: 0 }, ask: { $gt: 0 },
        daysLeft: { $gte: 7, $lte: 90 },
        deltaApi: { $gte: 0.20, $lte: 0.98 }
    });
    console.log('  current (0.35-0.85): ' + inCurrent.toLocaleString());
    console.log('  relaxed (0.25-0.95): ' + inRelaxed.toLocaleString() + '  (+' + (inRelaxed - inCurrent) + ')');
    console.log('  loose   (0.20-0.98): ' + inLoose.toLocaleString() + '  (+' + (inLoose - inCurrent) + ')');

    // ─── S3: daysLeft window ───
    console.log('\n[S3] Impact of daysLeft range:');
    const daysRange = await col.aggregate([
        { $match: { ...baseQ, bid: { $gt: 0 }, ask: { $gt: 0 }, deltaApi: { $gte: 0.35, $lte: 0.85 } } },
        { $bucket: {
            groupBy: '$daysLeft',
            boundaries: [0, 3, 7, 14, 30, 45, 60, 90, 180, 365, 10000],
            default: 'missing'
        }},
        { $group: { _id: '$_id', n: { $sum: 1 } } },
        { $sort: { _id: 1 } }
    ]).toArray();
    for (const b of daysRange) {
        console.log('  daysLeft ' + String(b._id).padEnd(10) + ' : ' + b.n.toLocaleString());
    }

    // ─── S4: dataQuality x bid/ask x delta ───
    console.log('\n[S4] dataQuality among fully-valid records (delta 0.35-0.85):');
    const dqBreakdown = await col.aggregate([
        { $match: {
            ...baseQ, bid: { $gt: 0 }, ask: { $gt: 0 },
            daysLeft: { $gte: 7, $lte: 90 },
            deltaApi: { $gte: 0.35, $lte: 0.85 }
        }},
        { $group: {
            _id: { $ifNull: ['$dataQuality', 'missing_field'] },
            n: { $sum: 1 }
        }},
        { $sort: { n: -1 } }
    ]).toArray();
    for (const b of dqBreakdown) {
        console.log('  dataQuality=' + String(b._id).padEnd(15) + ' : ' + b.n.toLocaleString());
    }

    // ─── S5: coverage from stock trades perspective ───
    console.log('\n[S5] Coverage: how many calendar days have option data?');
    const dayAgg = await col.aggregate([
        { $match: { ...baseQ, bid: { $gt: 0 }, ask: { $gt: 0 },
            deltaApi: { $gte: 0.35, $lte: 0.85 },
            daysLeft: { $gte: 7, $lte: 90 }
        }},
        { $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$time', timezone: 'Asia/Tehran' } },
            n: { $sum: 1 }
        }},
        { $sort: { _id: -1 } },
        { $limit: 60 }
    ]).toArray();
    console.log('  Last 60 days coverage (records per day):');
    let emptyDays = 0;
    for (const d of dayAgg) {
        console.log('    ' + d._id + ' : ' + d.n.toLocaleString());
    }

    // ─── S6: same-day intraday presence ───
    console.log('\n[S6] Intraday: unique hours per day (last 30 days):');
    const hourAgg = await col.aggregate([
        { $match: { ...baseQ, bid: { $gt: 0 }, ask: { $gt: 0 },
            deltaApi: { $gte: 0.35, $lte: 0.85 },
            daysLeft: { $gte: 7, $lte: 90 }
        }},
        { $group: {
            _id: {
                day: { $dateToString: { format: '%Y-%m-%d', date: '$time', timezone: 'Asia/Tehran' } },
                hour: { $hour: { date: '$time', timezone: 'Asia/Tehran' } }
            },
            n: { $sum: 1 }
        }},
        { $group: {
            _id: '$_id.day',
            hours: { $addToSet: '$_id.hour' },
            total: { $sum: '$n' }
        }},
        { $project: {
            day: '$_id',
            hoursCount: { $size: '$hours' },
            hours: '$hours',
            total: 1
        }},
        { $sort: { day: -1 } },
        { $limit: 30 }
    ]).toArray();
    console.log('  day         | records | unique hours');
    for (const d of hourAgg) {
        console.log('  ' + d.day + ' | ' + String(d.total).padEnd(8) + '| ' + d.hoursCount + '  ' + JSON.stringify(d.hours.sort()));
    }

    // ─── S7: a typical 3-day WINDOW test ───
    console.log('\n[S7] If backtest looks in a 3-day window, how many options match?');
    const sample = await col.findOne({
        ...baseQ, bid: { $gt: 0 }, ask: { $gt: 0 }
    }, { sort: { time: -1 } });

    if (sample) {
        const centreSec = Math.floor(sample.time.getTime() / 1000);
        for (const winDays of [1, 3, 5, 7]) {
            const lo = new Date((centreSec - winDays * 86400) * 1000);
            const hi = new Date((centreSec + winDays * 86400) * 1000);
            const cnt = await col.countDocuments({
                underlying: sample.underlying,
                time: { $gte: lo, $lte: hi },
                bid: { $gt: 0 }, ask: { $gt: 0 },
                deltaApi: { $gte: 0.35, $lte: 0.85 },
                daysLeft: { $gte: 7, $lte: 90 }
            });
            console.log('  window=' + winDays + 'd : ' + cnt + ' matching options (underlying=' + sample.underlying + ')');
        }
    }

    console.log('\n' + bar);
    console.log('  DONE');
    console.log(bar);

    await client.close();
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
