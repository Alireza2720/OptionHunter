'use strict';
// diagnose-portfolio.js — Stage 10a.0
// Analyzes the latest backtest-compare job's portfolio rejection reasons.
// Usage:
//   node backend/scripts/diagnose-portfolio.js
//   node backend/scripts/diagnose-portfolio.js --jobId <id>
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
const { MongoClient, ObjectId } = require(path.join(__dirname, '..', '..', 'node_modules', 'mongodb'));

const ARGV = process.argv.slice(2);
const JOB_ID_ARG = (() => {
    const a = ARGV.find(x => x.startsWith('--jobId='));
    return a ? a.split('=')[1] : null;
})();

function _line(k, v) { console.log('  ' + String(k).padEnd(35) + ' : ' + v); }
function _sec(t) { console.log(''); console.log('\u2500\u2500 ' + t + ' \u2500\u2500'); }

(async () => {
    const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 8000 });
    await client.connect();
    const db = client.db('trading_bot');

    // Find latest compare job (or use arg)
    let job;
    if (JOB_ID_ARG) {
        job = await db.collection('backtest_jobs').findOne({ _id: new ObjectId(JOB_ID_ARG) });
    } else {
        job = await db.collection('backtest_jobs').findOne(
            { type: 'backtest-compare', status: 'DONE' },
            { sort: { finishedAt: -1 } }
        );
    }
    if (!job) { console.log('NO_JOB: no backtest-compare DONE job found'); await client.close(); return; }
    console.log('jobId      : ' + String(job._id));
    console.log('createdAt  : ' + (job.createdAt ? job.createdAt.toISOString() : '?'));
    console.log('finishedAt : ' + (job.finishedAt ? job.finishedAt.toISOString() : '?'));

    // Load cached result
    const cacheId = 'backtest_result_' + String(job._id);
    const cache = await db.collection('meta').findOne({ _id: cacheId });
    if (!cache || !cache.result) { console.log('NO_CACHED_RESULT: ' + cacheId); await client.close(); return; }
    const R = cache.result;

    // ── Portfolio block ──
    _sec('Portfolio summary');
    const p = R.portfolio || {};
    _line('acceptedTrades', p.acceptedTrades || 0);
    _line('totalTrades', p.totalTrades || 0);
    _line('rejectedTrades', p.rejectedTrades || 0);
    _line('error', p.error || 'none');
    _line('rejectionReasons', JSON.stringify(p.rejectionReasons || {}));

    _sec('Limits used');
    const lim = p.limits || {};
    _line('capital', lim.capital);
    _line('riskPct', lim.riskPct);
    _line('maxSymPct', lim.maxSymPct);
    _line('maxTotalPct', lim.maxTotalPct);
    _line('maxClusterPct', lim.maxClusterPct);
    _line('maxSectorPct', lim.maxSectorPct);
    _line('useDuplicateGuard', lim.useDuplicateGuard);
    _line('useKelly', lim.useKelly);
    _line('useCorrelation', lim.useCorrelation);
    _line('useSectors', lim.useSectors);
    _line('useRegime', lim.useRegime);
    _line('useSignalScore', lim.useSignalScore);
    _line('useSignalFilter', lim.useSignalFilter);

    _sec('Signal filter');
    const sf = p.signalFilter || {};
    _line('applied', sf.applied);
    _line('mode', sf.mode);
    _line('originalCount', sf.originalCount);
    _line('keptCount', sf.keptCount);
    _line('droppedCount', sf.droppedCount);
    _line('allowedPairs.length', (sf.allowedPairs || []).length);
    _line('allowedStrategies', JSON.stringify(sf.allowedStrategies || []));
    _line('allowedSymbols', JSON.stringify(sf.allowedSymbols || []));
    _line('first 5 allowedPairs', JSON.stringify((sf.allowedPairs || []).slice(0, 5)));

    // ── signal_whitelist in meta ──
    _sec('signal_whitelist (meta)');
    const wl = await db.collection('meta').findOne({ _id: 'signal_whitelist' });
    if (!wl) {
        console.log('  (empty — signalFilterService cleared whitelist)');
    } else {
        _line('jobId', wl.jobId);
        _line('filterMode', wl.filterMode);
        _line('pairs.length', (wl.pairs || []).length);
        _line('strategies.length', (wl.strategies || []).length);
        _line('symbols.length', (wl.symbols || []).length);
        _line('first 5 pairs', JSON.stringify((wl.pairs || []).slice(0, 5)));
    }

    // ── Details ──
    _sec('Per-detail trades');
    const details = R.details || [];
    for (const d of details) {
        const s = d.stockStats || {}, o = d.optionStats || {};
        const tr = d.trades || [];
        const sTr = d.stockTrades || [];
        console.log('  ' + d.symbol + '/' + d.strategyId +
            ' | stockN=' + (s.count || 0) + ' optN=' + (o.count || 0) +
            ' trades=' + tr.length + ' stockTrades=' + sTr.length);
        const t0 = tr[0];
        if (t0) {
            console.log('    opt trade[0]: entryT=' + t0.entryTime +
                ' optEntry=' + (t0.optionEntry || '-') +
                ' size=' + (t0.size || '-') +
                ' symbol=' + (t0.symbol || '-'));
        }
        const st0 = sTr[0];
        if (st0) {
            console.log('    stock trade[0]: entryTime=' + st0.entryTime +
                ' entryPrice=' + (st0.entryPrice || '-') +
                ' exitTime=' + (st0.exitTime || '-'));
        }
    }

    // ── Latest portfolio_sim result (from latest simulate run, if any) ──
    _sec('Recent portfolio_sim results in meta');
    const simResults = await db.collection('meta')
        .find({ _id: { $regex: '^portfolio_sim_' } })
        .sort({ _id: -1 }).limit(3).toArray();
    if (!simResults.length) {
        console.log('  (none)');
    } else {
        for (const s of simResults) {
            console.log('  ' + s._id + ' @ ' + (s.computedAt || s.createdAt || '?'));
        }
    }

    // ── Stock trade structure sample (for fix #1 check) ──
    _sec('Stock trade field sample (verify fix #1 fields)');
    const anyTrade = details.flatMap(d => d.stockTrades || []).find(t => t);
    if (anyTrade) {
        console.log('  sample stock trade keys: ' + Object.keys(anyTrade).join(', '));
        console.log('  entryFillTime=' + anyTrade.entryFillTime +
            ' entryTime=' + anyTrade.entryTime +
            ' exitFillTime=' + anyTrade.exitFillTime +
            ' exitTime=' + anyTrade.exitTime);
        if (anyTrade.entryFillTime && anyTrade.entryTime) {
            console.log('  fillDelay = ' + (anyTrade.entryFillTime - anyTrade.entryTime) + 's');
        }
    } else {
        console.log('  (no stockTrades found in any detail)');
    }

    // ── Contract value check (why 0 accepted?) ──
    _sec('Sizing sanity check');
    const capital = lim.capital || 100000000;
    const riskPct = lim.riskPct || 1.5;
    const riskAmt = capital * riskPct / 100;
    console.log('  capital * riskPct = ' + riskAmt.toLocaleString() + ' (per-trade risk budget)');
    const anyOptT = details.flatMap(d => d.trades || []).find(t => t && t.optionEntry);
    if (anyOptT) {
        const cv = (anyOptT.optionEntry || 0) * (anyOptT.size || 1000);
        console.log('  sample optionEntry = ' + anyOptT.optionEntry);
        console.log('  sample size        = ' + (anyOptT.size || 1000));
        console.log('  sample contractV   = ' + cv.toLocaleString());
        console.log('  riskAmt / contractV = ' + (riskAmt / cv).toFixed(3));
        if (cv > riskAmt) {
            console.log('  \u26a0\ufe0f  contract value > per-trade risk budget → baseSize=0');
        } else {
            console.log('  ok contract value fits risk budget');
        }
    } else {
        console.log('  (no option trades with optionEntry)');
    }

    await client.close();
    console.log('');
    console.log('\u2550'.repeat(55));
    console.log('  diagnose-portfolio DONE');
    console.log('\u2550'.repeat(55));
})().catch(e => { console.error('FATAL: ' + e.message); console.error(e.stack); process.exit(1); });
