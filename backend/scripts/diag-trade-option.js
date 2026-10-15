'use strict';
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
const { MongoClient } = require(path.join(__dirname, '..', '..', 'node_modules', 'mongodb'));

(async () => {
    const c = new MongoClient(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000 });
    await c.connect();
    const db = c.db('trading_bot');
    const job = await db.collection('backtest_jobs').findOne(
        { type: 'backtest-compare', status: 'DONE' },
        { sort: { finishedAt: -1 } }
    );
    if (!job) { console.log('no job'); await c.close(); return; }
    console.log('jobId=' + String(job._id));
    const cache = await db.collection('meta').findOne({ _id: 'backtest_result_' + String(job._id) });
    const details = (cache && cache.result && cache.result.details) || [];
    console.log('details=' + details.length);

    for (const d of details) {
        const stocks = (d.stockTrades || []);
        console.log('');
        console.log('=== ' + d.symbol + '/' + d.strategyId + ' | stockTrades=' + stocks.length + ' ===');
        if (!stocks.length) continue;

        const picks = [stocks[0], stocks[Math.floor(stocks.length / 2)], stocks[stocks.length - 1]];
        for (let i = 0; i < picks.length; i++) {
            const t = picks[i];
            const entrySec = t.entryFillTime || t.entryTime;
            const wLo = new Date((entrySec - 86400) * 1000);
            const wHi = new Date(entrySec * 1000);

            const _matchBase = { underlying: d.symbol, time: { $gte: wLo, $lte: wHi }, bid: { $gt: 0 }, ask: { $gt: 0 } };
            const n2 = await db.collection('option_history').countDocuments(_matchBase);
            const n1 = await db.collection('option_history').countDocuments({
                ..._matchBase, isCall: true, $or: [{ dataQuality: 'real' }, { dataQuality: { $exists: false } }]
            });
            const n3 = await db.collection('option_history').countDocuments({ ..._matchBase, isCall: true });
            const n4 = await db.collection('option_history').countDocuments({ ..._matchBase, deltaApi: { $gte: 0.30, $lte: 0.98 }, daysLeft: { $gte: 7, $lte: 70 }, isCall: true });

            console.log('  trade[' + i + '] entryFill=' + entrySec + ' (' + wLo.toISOString().slice(0, 10) + '..' + wHi.toISOString().slice(0, 10) + ')');
            console.log('    bid/ask          : ' + n2);
            console.log('    +isCall          : ' + n3);
            console.log('    +isCall+realDQ   : ' + n1);
            console.log('    +all-filters     : ' + n4);
        }
    }
    await c.close();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
