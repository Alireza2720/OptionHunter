#!/usr/bin/env node
'use strict';
// ============================================================
// diagnose-options.js — تشخیص جامع مشکل backtest آپشن
// ============================================================
// بررسی می‌کند چرا backtest آپشن تعداد کمی معامله تولید می‌کند.
// تمام کوئری‌ها و شماره‌ها را چاپ می‌کند تا دقیقاً بفهمیم کجا گیر است.
//
// Usage:
//   node backend/scripts/diagnose-options.js
//   node backend/scripts/diagnose-options.js --symbol اهرم
//   node backend/scripts/diagnose-options.js --json > report.json
// ============================================================

const fs = require('fs');
const path = require('path');

// ---- .env loader (بدون dotenv) ----
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
    const i = ARGV.indexOf('--symbol');
    if (i >= 0 && ARGV[i + 1]) return ARGV[i + 1];
    return null;
})();
const AS_JSON = ARGV.includes('--json');

const R = {
    startedAt: new Date().toISOString(),
    symbol: SYMBOL || 'ALL',
    sections: {},
    summary: {},
    rootCauses: [],
};

function log(...a) { if (!AS_JSON) console.log(...a); }
function section(name) { log('\n' + '═'.repeat(70)); log('  ' + name); log('═'.repeat(70)); }
function kv(k, v) { log('  ' + String(k).padEnd(45) + ' : ' + v); }

(async () => {
    const uri = envVars.MONGO_URI;
    if (!uri) { console.error('MONGO_URI not found in .env'); process.exit(1); }

    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
    await client.connect();
    const db = client.db('trading_bot');
    const col = db.collection('option_history');

    // ══════════════════════════════════════════════════════════
    // S1: وضعیت کلی collection
    // ══════════════════════════════════════════════════════════
    section('S1: Collection overview');

    const total = await col.estimatedDocumentCount();
    kv('Total option_history docs', total.toLocaleString());

    const earliestDoc = await col.findOne({}, { sort: { time: 1 }, projection: { time: 1 } });
    const latestDoc = await col.findOne({}, { sort: { time: -1 }, projection: { time: 1 } });
    kv('Earliest time', earliestDoc ? earliestDoc.time.toISOString() : 'none');
    kv('Latest time', latestDoc ? latestDoc.time.toISOString() : 'none');
    if (earliestDoc && latestDoc) {
        const days = Math.floor((latestDoc.time - earliestDoc.time) / 86400000);
        kv('Total span (days)', days);
    }

    R.sections.s1_overview = {
        total,
        earliest: earliestDoc ? earliestDoc.time : null,
        latest: latestDoc ? latestDoc.time : null,
    };

    // ══════════════════════════════════════════════════════════
    // S2: توزیع source
    // ══════════════════════════════════════════════════════════
    section('S2: Source distribution');

    const sources = await col.aggregate([
        { $group: { _id: '$source', n: { $sum: 1 } } },
        { $sort: { n: -1 } }
    ]).toArray();
    for (const s of sources) kv('  source=' + (s._id || 'null'), s.n.toLocaleString());
    R.sections.s2_sources = sources;

    // ══════════════════════════════════════════════════════════
    // S3: توزیع dataQuality
    // ══════════════════════════════════════════════════════════
    section('S3: dataQuality distribution');

    const dq = await col.aggregate([
        { $group: { _id: '$dataQuality', n: { $sum: 1 } } },
        { $sort: { n: -1 } }
    ]).toArray();
    for (const s of dq) kv('  dataQuality=' + (s._id || 'null'), s.n.toLocaleString());
    R.sections.s3_dataQuality = dq;

    // ══════════════════════════════════════════════════════════
    // S4: فیلترهای اصلی backtest آپشن
    // ══════════════════════════════════════════════════════════
    section('S4: Backtest filter funnel (per option filter)');

    const baseQ = SYMBOL ? { underlying: SYMBOL } : {};
    kv('Filter base', JSON.stringify(baseQ));

    const funnel = {};

    funnel.total_for_symbol = await col.countDocuments(baseQ);
    kv('1) total', funnel.total_for_symbol.toLocaleString());

    funnel.with_bid_ask = await col.countDocuments({ ...baseQ, bid: { $gt: 0 }, ask: { $gt: 0 } });
    kv('2) + bid>0 AND ask>0', funnel.with_bid_ask.toLocaleString());

    funnel.with_daysLeft_7_90 = await col.countDocuments({
        ...baseQ, bid: { $gt: 0 }, ask: { $gt: 0 },
        daysLeft: { $gte: 7, $lte: 90 }
    });
    kv('3) + daysLeft 7..90', funnel.with_daysLeft_7_90.toLocaleString());

    funnel.with_delta = await col.countDocuments({
        ...baseQ, bid: { $gt: 0 }, ask: { $gt: 0 },
        daysLeft: { $gte: 7, $lte: 90 },
        deltaApi: { $gte: 0.30, $lte: 0.98 }
    });
    kv('4) + deltaApi 0.30..0.98', funnel.with_delta.toLocaleString());

    funnel.with_dq_real = await col.countDocuments({
        ...baseQ, bid: { $gt: 0 }, ask: { $gt: 0 },
        daysLeft: { $gte: 7, $lte: 90 },
        deltaApi: { $gte: 0.30, $lte: 0.98 },
        dataQuality: 'real'
    });
    kv('5a) + dataQuality=real', funnel.with_dq_real.toLocaleString());

    funnel.with_dq_real_or_missing = await col.countDocuments({
        ...baseQ, bid: { $gt: 0 }, ask: { $gt: 0 },
        daysLeft: { $gte: 7, $lte: 90 },
        deltaApi: { $gte: 0.30, $lte: 0.98 },
        $or: [{ dataQuality: 'real' }, { dataQuality: { $exists: false } }]
    });
    kv('5b) + dataQuality IN(real, missing)', funnel.with_dq_real_or_missing.toLocaleString());

    funnel.with_dq_real_enriched_or_missing = await col.countDocuments({
        ...baseQ, bid: { $gt: 0 }, ask: { $gt: 0 },
        daysLeft: { $gte: 7, $lte: 90 },
        deltaApi: { $gte: 0.30, $lte: 0.98 },
        $or: [
            { dataQuality: { $in: ['real', 'enriched'] } },
            { dataQuality: { $exists: false } }
        ]
    });
    kv('5c) + dataQuality IN(real,enriched,missing)', funnel.with_dq_real_enriched_or_missing.toLocaleString());

    R.sections.s4_funnel = funnel;

    // ══════════════════════════════════════════════════════════
    // S5: توزیع رکوردها در ساعات روز
    // ══════════════════════════════════════════════════════════
    section('S5: Hour-of-day distribution (with bid/ask)');

    const hours = await col.aggregate([
        { $match: { ...baseQ, bid: { $gt: 0 }, ask: { $gt: 0 } } },
        { $group: { _id: { $hour: '$time' }, n: { $sum: 1 } } },
        { $sort: { _id: 1 } }
    ]).toArray();
    for (const h of hours) kv('  hour=' + h._id, h.n.toLocaleString());
    R.sections.s5_hours = hours;

    // ══════════════════════════════════════════════════════════
    // S6: توزیع رکوردها در روزهای هفته
    // ============================================================
    section('S6: Day-of-week distribution');

    const dow = await col.aggregate([
        { $match: { ...baseQ, bid: { $gt: 0 }, ask: { $gt: 0 } } },
        { $group: { _id: { $dayOfWeek: '$time' }, n: { $sum: 1 } } },
        { $sort: { _id: 1 } }
    ]).toArray();
    const dowNames = ['', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    for (const d of dow) kv('  ' + dowNames[d._id] + ' (' + d._id + ')', d.n.toLocaleString());
    R.sections.s6_dow = dow;

    // ══════════════════════════════════════════════════════════
    // S7: میانگین فاصله‌ی زمانی بین رکوردها برای یک قرارداد
    // ============================================================
    section('S7: Time interval between records per contract');

    const sampleContract = await col.findOne({
        ...baseQ, bid: { $gt: 0 }, ask: { $gt: 0 }
    }, { sort: { time: -1 } });

    if (sampleContract) {
        kv('Sample symbol', sampleContract.symbol);
        kv('Sample underlying', sampleContract.underlying);

        const times = await col.find(
            { symbol: sampleContract.symbol },
            { projection: { time: 1, _id: 0 } }
        ).sort({ time: 1 }).toArray();

        kv('  Total records', times.length);

        if (times.length >= 2) {
            const gaps = [];
            for (let i = 1; i < Math.min(times.length, 200); i++) {
                gaps.push((times[i].time - times[i-1].time) / 1000);
            }
            gaps.sort((a, b) => a - b);
            const stats = {
                min: gaps[0],
                p50: gaps[Math.floor(gaps.length * 0.5)],
                p90: gaps[Math.floor(gaps.length * 0.9)],
                max: gaps[gaps.length - 1],
                avg: Math.round(gaps.reduce((s, x) => s + x, 0) / gaps.length),
            };
            kv('  Gap min/p50/p90/max/avg (sec)', JSON.stringify(stats));
            R.sections.s7_gaps = stats;
        }
    } else {
        kv('No contract with bid/ask found', '');
        R.sections.s7_gaps = { error: 'no sample' };
    }

    // ══════════════════════════════════════════════════════════
    // S8: رکوردهای بدون dataQuality — چندتاشون bid/ask دارن؟
    // ============================================================
    section('S8: Records without dataQuality field');

    const noDq = await col.aggregate([
        { $match: { dataQuality: { $exists: false } } },
        { $group: {
            _id: {
                hasBidAsk: { $cond: [
                    { $and: [{ $gt: ['$bid', 0] }, { $gt: ['$ask', 0] }] },
                    'yes', 'no'
                ]},
            },
            n: { $sum: 1 }
        }}
    ]).toArray();
    for (const d of noDq) kv('  hasBidAsk=' + d._id.hasBidAsk, d.n.toLocaleString());
    R.sections.s8_no_dq = noDq;

    // ══════════════════════════════════════════════════════════
    // S9: نمونه‌های اخیر با تمام فیلدهای کلیدی
    // ============================================================
    section('S9: Sample recent records (bid/ask/delta/daysLeft)');

    const samples = await col.find(
        { ...baseQ, bid: { $gt: 0 }, ask: { $gt: 0 } },
        {
            projection: {
                symbol: 1, underlying: 1, time: 1,
                bid: 1, ask: 1, deltaApi: 1, daysLeft: 1,
                dataQuality: 1, source: 1, S: 1, strike: 1
            }
        }
    ).sort({ time: -1 }).limit(5).toArray();

    for (const s of samples) {
        log('  ─── ' + s.symbol + ' (' + s.underlying + ')');
        log('      time: ' + s.time.toISOString());
        log('      S=' + s.S + ' strike=' + s.strike);
        log('      bid=' + s.bid + ' ask=' + s.ask + ' deltaApi=' + s.deltaApi + ' daysLeft=' + s.daysLeft);
        log('      dataQuality=' + (s.dataQuality || 'undefined') + ' source=' + (s.source || 'undefined'));
    }
    R.sections.s9_samples = samples;

    // ══════════════════════════════════════════════════════════
    // S10: چند underlying مختلف داریم؟
    // ============================================================
    section('S10: Per-underlying coverage');

    const perUnderlying = await col.aggregate([
        { $match: { bid: { $gt: 0 }, ask: { $gt: 0 } } },
        { $group: {
            _id: '$underlying',
            total: { $sum: 1 },
            withDelta: {
                $sum: { $cond: [
                    { $and: [
                        { $gte: ['$deltaApi', 0.30] },
                        { $lte: ['$deltaApi', 0.98] }
                    ]},
                    1, 0
                ]}
            },
            earliest: { $min: '$time' },
            latest: { $max: '$time' },
        }},
        { $sort: { total: -1 } }
    ]).toArray();

    log('  underlying'.padEnd(15) + ' total'.padEnd(12) + ' withDelta'.padEnd(12) + ' span');
    for (const u of perUnderlying.slice(0, 30)) {
        const days = Math.round((u.latest - u.earliest) / 86400000);
        log('  ' + String(u._id || 'null').padEnd(15) +
            String(u.total).padEnd(12) +
            String(u.withDelta).padEnd(12) +
            days + 'd');
    }
    R.sections.s10_per_underlying = perUnderlying.slice(0, 30);

    // ══════════════════════════════════════════════════════════
    // S11: چند روز متمایز داریم؟ (intraday یا فقط daily?)
    // ============================================================
    section('S11: Distinct days with data (intraday vs daily)');

    const distinctDays = await col.aggregate([
        { $match: { ...baseQ, bid: { $gt: 0 }, ask: { $gt: 0 } } },
        { $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$time', timezone: 'Asia/Tehran' } },
            n: { $sum: 1 },
            uniqueHours: { $addToSet: { $hour: '$time' } }
        }},
        { $sort: { _id: -1 } },
        { $limit: 20 }
    ]).toArray();

    log('  date'.padEnd(14) + 'records'.padEnd(12) + 'uniqueHours');
    for (const d of distinctDays) {
        log('  ' + d._id.padEnd(14) + String(d.n).padEnd(12) + d.uniqueHours.length);
    }
    R.sections.s11_distinct_days = distinctDays;

    // ══════════════════════════════════════════════════════════
    // S12: آخرین 10 روزی که data داریم — توزیع روزانه
    // ============================================================
    section('S12: Last 30 days — records/day trend');

    const last30 = await col.aggregate([
        { $match: { bid: { $gt: 0 }, ask: { $gt: 0 } } },
        { $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$time', timezone: 'Asia/Tehran' } },
            n: { $sum: 1 },
        }},
        { $sort: { _id: -1 } },
        { $limit: 30 }
    ]).toArray();
    for (const d of last30) kv('  ' + d._id, d.n.toLocaleString());
    R.sections.s12_last30 = last30;

    // ══════════════════════════════════════════════════════════
    // S13: جمع‌بندی و ریشه‌یابی
    // ══════════════════════════════════════════════════════════
    section('S13: SUMMARY & ROOT CAUSE HINTS');

    const totalWithBidAsk = funnel.with_bid_ask;
    const totalWithAll = funnel.with_delta;
    const totalWithDqReal = funnel.with_dq_real;
    const ratio = funnel.total_for_symbol ? (totalWithAll / funnel.total_for_symbol) : 0;

    kv('total option docs', totalWithBidAsk ? funnel.total_for_symbol.toLocaleString() : '0');
    kv('with bid/ask', totalWithBidAsk.toLocaleString());
    kv('with delta+days filter', totalWithAll.toLocaleString());
    kv('  ratio of total', (ratio * 100).toFixed(1) + '%');
    kv('with dataQuality=real', totalWithDqReal.toLocaleString());

    if (funnel.total_for_symbol > 0 && totalWithAll / funnel.total_for_symbol < 0.1) {
        R.rootCauses.push('CRITICAL: fewer than 10% of records pass bid/ask+delta+days filter. Backtest has almost no tradeable options.');
    }
    if (totalWithDqReal < totalWithAll * 0.1) {
        R.rootCauses.push('dataQuality=real is very rare. If minDataQuality is set to real, most records get filtered out.');
    }
    if (sources.find(s => s._id === 'live_snapshot' && s.n > total * 0.4)) {
        R.rootCauses.push('Majority of data is from live_snapshot. Historical intraday records may be scarce.');
    }
    if (hours.length <= 3) {
        R.rootCauses.push('Records exist in only ' + hours.length + ' distinct hour(s). Likely daily records, not intraday.');
    }
    if (distinctDays.length > 0 && distinctDays[0].uniqueHours.length <= 2) {
        R.rootCauses.push('Recent days have <3 unique hours. Records are daily, not intraday.');
    }

    kv('rootCauseHints count', R.rootCauses.length);
    for (const rc of R.rootCauses) log('  ⚠️  ' + rc);

    R.summary = {
        total: funnel.total_for_symbol,
        withBidAsk: totalWithBidAsk,
        withDelta: totalWithAll,
        withDqReal: totalWithDqReal,
        ratio: ratio,
        hints: R.rootCauses,
    };

    if (AS_JSON) {
        console.log(JSON.stringify(R, null, 2));
    } else {
        log('\n' + '═'.repeat(70));
        log('  DONE');
        log('═'.repeat(70));
    }

    await client.close();
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
