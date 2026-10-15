'use strict';
// Simulates tryGetRealTradeDataFast filter-by-filter for one specific trade
// Helps find WHERE the candidate gets rejected.
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
const { MongoClient, ObjectId } = require(path.join(__dirname, '..', '..', 'node_modules', 'mongodb'));

const JOB_ID = process.argv.find(x => x.startsWith('--job-id=')) ? process.argv.find(x => x.startsWith('--job-id=')).split('=')[1] : null;
const SYMBOL = process.argv.find(x => x.startsWith('--symbol=')) ? process.argv.find(x => x.startsWith('--symbol=')).split('=')[1] : null;
const ENTRY = process.argv.find(x => x.startsWith('--entry=')) ? +process.argv.find(x => x.startsWith('--entry=')).split('=')[1] : null;

(async () => {
    const c = new MongoClient(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000 });
    await c.connect();
    const db = c.db('trading_bot');

    let job;
    if (JOB_ID) job = await db.collection('backtest_jobs').findOne({ _id: new ObjectId(JOB_ID) });
    else job = await db.collection('backtest_jobs').findOne({ type: 'backtest-compare', status: 'DONE' }, { sort: { finishedAt: -1 } });

    const cache = await db.collection('meta').findOne({ _id: 'backtest_result_' + String(job._id) });
    const details = (cache && cache.result && cache.result.details) || [];

    const _qParams = {
        // Quality level B defaults (from option-selector.js)
        deltaMin: 0.25, deltaMax: 0.85,
        minDays: 7, maxDays: 70,
        maxSpreadPct: 15,
        minOI: 50,
        minPremium: 150,
        allowEnriched: true,
        timeWindowDays: 2,
        minTargetPct: 4.5,
        maxIvHv: 2.5
    };

    for (const d of details) {
        if (SYMBOL && d.symbol !== SYMBOL) continue;
        const stocks = (d.stockTrades || []);
        if (!stocks.length) continue;

        console.log('');
        console.log('=== ' + d.symbol + '/' + d.strategyId + ' | ' + stocks.length + ' trades ===');

        let target = stocks[stocks.length - 1]; // last trade
        if (ENTRY) {
            const f = stocks.find(x => (x.entryFillTime || x.entryTime) === ENTRY);
            if (f) target = f;
        }

        const entrySec = target.entryFillTime || target.entryTime;
        const WINDOW_SEC = (_qParams.timeWindowDays || 1) * 24 * 3600;
        const loSec = entrySec - WINDOW_SEC;
        const hiSec = entrySec;

        console.log('  trade entry=' + entrySec + ' (' + new Date(entrySec * 1000).toISOString().slice(0, 19) + ')');
        console.log('  window: ' + new Date(loSec * 1000).toISOString().slice(0, 19) + ' .. ' + new Date(hiSec * 1000).toISOString().slice(0, 19));
        console.log('  trade entryPrice=' + target.entryPrice + ' stop=' + target.stop + ' atr=' + target.atr);
        console.log('');

        // Step 1: raw candidates (as backtest bulk query)
        const allCands = await db.collection('option_history').find({
            underlying: d.symbol,
            time: { $gte: new Date(loSec * 1000), $lte: new Date(hiSec * 1000) },
            bid: { $gt: 0 }, ask: { $gt: 0 }
        }).project({
            symbol: 1, strike: 1, time: 1, bid: 1, ask: 1, last: 1, close: 1,
            deltaApi: 1, daysLeft: 1, oi: 1, isCall: 1, dataQuality: 1,
            ivApi: 1, hvApi: 1, volume: 1, S: 1, size: 1
        }).toArray();

        console.log('  Step 1: raw cands (bid/ask) = ' + allCands.length);
        const calls = allCands.filter(x => x.isCall === true);
        console.log('  Step 2: isCall=true = ' + calls.length);
        const callsDq = calls.filter(x => !x.dataQuality || x.dataQuality === 'real' || x.dataQuality === 'enriched');
        console.log('  Step 3: dataQuality OK = ' + callsDq.length);

        // Step 4: delta filter
        const allowMissingDelta = _qParams.allowMissingDelta !== false;
        const byDelta = callsDq.filter(x => {
            const dlt = Number(x.deltaApi);
            if (!Number.isFinite(dlt)) return allowMissingDelta;
            return dlt >= _qParams.deltaMin && dlt <= _qParams.deltaMax;
        });
        console.log('  Step 4: delta in [' + _qParams.deltaMin + ',' + _qParams.deltaMax + '] = ' + byDelta.length + ' (allowMissingDelta=' + allowMissingDelta + ')');

        // Step 5: spread
        const bySpread = byDelta.filter(x => {
            const mid = (x.bid + x.ask) / 2;
            const sp = mid > 0 ? (x.ask - x.bid) / mid * 100 : 100;
            return sp <= _qParams.maxSpreadPct;
        });
        console.log('  Step 5: spread <= ' + _qParams.maxSpreadPct + '% = ' + bySpread.length);

        // Step 6: OI
        const byOI = bySpread.filter(x => (x.oi || 0) >= _qParams.minOI);
        console.log('  Step 6: OI >= ' + _qParams.minOI + ' = ' + byOI.length);

        // Step 7: premium (ask)
        const byPrem = byOI.filter(x => x.ask >= _qParams.minPremium);
        console.log('  Step 7: ask >= ' + _qParams.minPremium + ' = ' + byPrem.length);

        // Step 8: daysLeft
        const byDays = byPrem.filter(x => x.daysLeft >= _qParams.minDays && x.daysLeft <= _qParams.maxDays);
        console.log('  Step 8: daysLeft in [' + _qParams.minDays + ',' + _qParams.maxDays + '] = ' + byDays.length);

        // Step 9: ivHv
        const byIvHv = byDays.filter(x => {
            const iv = Number(x.ivApi); const hv = Number(x.hvApi);
            if (!(iv > 0) || !(hv > 0)) return true;  // allow missing
            return (iv / hv) <= _qParams.maxIvHv;
        });
        console.log('  Step 9: iv/hv <= ' + _qParams.maxIvHv + ' = ' + byIvHv.length);

        // Final candidates — show them
        console.log('');
        console.log('  Final candidates: ' + byIvHv.length);
        for (const x of byIvHv.slice(0, 10)) {
            const mid = (x.bid + x.ask) / 2;
            const sp = mid > 0 ? (x.ask - x.bid) / mid * 100 : 0;
            console.log('    ' + x.symbol + ' K=' + x.strike + ' dlt=' + (x.deltaApi || '?') +
                ' days=' + x.daysLeft + ' spread=' + sp.toFixed(1) + '%' +
                ' oi=' + x.oi + ' ask=' + x.ask + ' iv=' + (x.ivApi || '?') +
                ' dq=' + (x.dataQuality || 'null'));
        }

        // Show rejected (first 5)
        console.log('');
        console.log('  Rejected examples (first 5 with reasons):');
        let shown = 0;
        for (const x of callsDq) {
            if (shown >= 5) break;
            const mid = (x.bid + x.ask) / 2;
            const sp = mid > 0 ? (x.ask - x.bid) / mid * 100 : 100;
            const dlt = Number(x.deltaApi);
            const reasons = [];
            if (Number.isFinite(dlt) && (dlt < _qParams.deltaMin || dlt > _qParams.deltaMax)) reasons.push('delta=' + dlt.toFixed(2));
            if (sp > _qParams.maxSpreadPct) reasons.push('spread=' + sp.toFixed(1) + '%');
            if ((x.oi || 0) < _qParams.minOI) reasons.push('oi=' + (x.oi || 0));
            if (x.ask < _qParams.minPremium) reasons.push('ask=' + x.ask);
            if (x.daysLeft < _qParams.minDays || x.daysLeft > _qParams.maxDays) reasons.push('days=' + x.daysLeft);
            if (!reasons.length) continue;
            console.log('    ' + x.symbol + ' K=' + x.strike + ' → ' + reasons.join(', '));
            shown++;
        }
    }

    await c.close();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
