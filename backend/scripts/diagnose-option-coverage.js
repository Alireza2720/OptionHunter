'use strict';
// diagnose-option-coverage.js — funnel check for option_history filters
// Usage: node backend/scripts/diagnose-option-coverage.js --symbol=شپنا --from-jalali=1402/07/23 --to-jalali=1405/07/23
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

const MONGO_URI = process.env.MONGO_URI;
const { MongoClient } = require(path.join(__dirname, '..', '..', 'node_modules', 'mongodb'));

function _arg(name, fallback) {
    const pref = '--' + name + '=';
    const a = process.argv.find(x => x.startsWith(pref));
    return a ? a.slice(pref.length) : fallback;
}

const SYMBOL = _arg('symbol', 'شپنا');
const FROM_J = _arg('from-jalali', '1402/07/23');
const TO_J = _arg('to-jalali', '1405/07/23');

function _jalaliToGreg(jStr) {
    const p = String(jStr).split(/[\/\-]/).map(Number);
    const [jy, jm, jd] = p;
    let jyA = jy + 1595;
    let days = -355668 + (365 * jyA) + (Math.floor(jyA / 33) * 8) + Math.floor(((jyA % 33) + 3) / 4) + jd + ((jm < 7) ? (jm - 1) * 31 : ((jm - 7) * 30) + 186);
    let gy = 400 * Math.floor(days / 146097); days %= 146097;
    if (days > 36524) { gy += 100 * Math.floor(--days / 36524); days %= 36524; if (days >= 365) days++; }
    gy += 4 * Math.floor(days / 1461); days %= 1461;
    if (days > 365) { gy += Math.floor((days - 1) / 365); days = (days - 1) % 365; }
    let gd = days + 1;
    const leap = (gy % 4 === 0 && gy % 100 !== 0) || (gy % 400 === 0);
    const sm = [0, 31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let gm; for (gm = 0; gm < 13; gm++) { if (gd <= sm[gm]) break; gd -= sm[gm]; }
    return new Date(Date.UTC(gy, gm - 1, gd));
}

(async () => {
    const fromD = _jalaliToGreg(FROM_J);
    const toD = _jalaliToGreg(TO_J);
    console.log('Symbol : ' + SYMBOL);
    console.log('From   : ' + fromD.toISOString().slice(0, 10) + ' (' + FROM_J + ')');
    console.log('To     : ' + toD.toISOString().slice(0, 10) + ' (' + TO_J + ')');
    console.log('');

    const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 8000 });
    await client.connect();
    const col = client.db('trading_bot').collection('option_history');

    const baseQ = { underlying: SYMBOL, time: { $gte: fromD, $lte: toD } };

    const funnel = {};
    funnel.total = await col.countDocuments(baseQ);
    funnel.withBidAsk = await col.countDocuments({ ...baseQ, bid: { $gt: 0 }, ask: { $gt: 0 } });
    funnel.withDelta = await col.countDocuments({ ...baseQ, bid: { $gt: 0 }, ask: { $gt: 0 }, deltaApi: { $gte: 0.30, $lte: 0.98 } });
    funnel.withDays7_70 = await col.countDocuments({ ...baseQ, bid: { $gt: 0 }, ask: { $gt: 0 }, deltaApi: { $gte: 0.30, $lte: 0.98 }, daysLeft: { $gte: 7, $lte: 70 } });
    funnel.withSpread15 = await col.countDocuments({ ...baseQ, bid: { $gt: 0 }, ask: { $gt: 0 }, deltaApi: { $gte: 0.30, $lte: 0.98 }, daysLeft: { $gte: 7, $lte: 70 }, $expr: { $lte: [{ $divide: [{ $subtract: ['$ask', '$bid'] }, { $divide: [{ $add: ['$bid', '$ask'] }, 2] }] }, 0.15] } });
    funnel.onlyCalls = await col.countDocuments({ ...baseQ, bid: { $gt: 0 }, ask: { $gt: 0 }, deltaApi: { $gte: 0.30, $lte: 0.98 }, daysLeft: { $gte: 7, $lte: 70 }, isCall: true });

    console.log('── Funnel ──');
    console.log('  total (raw)                : ' + funnel.total.toLocaleString());
    console.log('  + bid>0 AND ask>0          : ' + funnel.withBidAsk.toLocaleString());
    console.log('  + deltaApi 0.30..0.98      : ' + funnel.withDelta.toLocaleString());
    console.log('  + daysLeft 7..70           : ' + funnel.withDays7_70.toLocaleString());
    console.log('  + spread <= 15%            : ' + funnel.withSpread15.toLocaleString());
    console.log('  + isCall=true              : ' + funnel.onlyCalls.toLocaleString());
    console.log('');

    // Date range of what exists
    console.log('── Date range (option_history) ──');
    const earliest = await col.find(baseQ).sort({ time: 1 }).limit(1).toArray();
    const latest = await col.find(baseQ).sort({ time: -1 }).limit(1).toArray();
    if (earliest[0]) console.log('  earliest : ' + earliest[0].time.toISOString().slice(0, 10));
    if (latest[0]) console.log('  latest   : ' + latest[0].time.toISOString().slice(0, 10));

    // Counts by dataQuality
    console.log('');
    console.log('── dataQuality distribution ──');
    const dqAgg = await col.aggregate([
        { $match: baseQ },
        { $group: { _id: '$dataQuality', n: { $sum: 1 } } },
        { $sort: { n: -1 } }
    ]).toArray();
    for (const d of dqAgg) console.log('  ' + (d._id || 'null').padEnd(20) + ' : ' + d.n.toLocaleString());

    // Counts by source
    console.log('');
    console.log('── source distribution ──');
    const srcAgg = await col.aggregate([
        { $match: baseQ },
        { $group: { _id: '$source', n: { $sum: 1 } } },
        { $sort: { n: -1 } }
    ]).toArray();
    for (const d of srcAgg) console.log('  ' + (d._id || 'null').padEnd(25) + ' : ' + d.n.toLocaleString());

    // Sample rows
    console.log('');
    console.log('── sample rows (with bid/ask) ──');
    const samples = await col.find({ ...baseQ, bid: { $gt: 0 }, ask: { $gt: 0 } }).limit(5).toArray();
    for (const s of samples) {
        console.log('  ' + s.symbol + ' ' + (s.time ? s.time.toISOString().slice(0, 10) : '?') +
            ' isCall=' + s.isCall + ' S=' + s.S + ' strike=' + s.strike +
            ' bid=' + s.bid + ' ask=' + s.ask + ' delta=' + s.deltaApi +
            ' daysLeft=' + s.daysLeft + ' dq=' + (s.dataQuality || 'null'));
    }

    // Histograms
    console.log('');
    console.log('── daysLeft histogram (with bid/ask) ──');
    const dlAgg = await col.aggregate([
        { $match: { ...baseQ, bid: { $gt: 0 }, ask: { $gt: 0 } } },
        { $bucket: { groupBy: '$daysLeft', boundaries: [-1, 0, 3, 7, 14, 30, 60, 90, 180, 365, 10000], default: 'null' } },
        { $group: { _id: '$_id', n: { $sum: 1 } } },
        { $sort: { _id: 1 } }
    ]).toArray();
    for (const d of dlAgg) console.log('  ' + String(d._id).padEnd(10) + ' : ' + d.n.toLocaleString());

    console.log('');
    console.log('── delta histogram (with bid/ask) ──');
    const deltaAgg = await col.aggregate([
        { $match: { ...baseQ, bid: { $gt: 0 }, ask: { $gt: 0 } } },
        { $bucket: { groupBy: '$deltaApi', boundaries: [-1, 0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.01, 2], default: 'null' } },
        { $group: { _id: '$_id', n: { $sum: 1 } } },
        { $sort: { _id: 1 } }
    ]).toArray();
    for (const d of deltaAgg) console.log('  ' + String(d._id).padEnd(10) + ' : ' + d.n.toLocaleString());

    await client.close();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
