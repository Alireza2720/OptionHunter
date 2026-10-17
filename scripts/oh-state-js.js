'use strict';
const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..');
const envPath = path.join(ROOT, '.env');
const env = {};
for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
  const t = line.trim();
  if (!t || t[0] === '#') continue;
  const e = t.indexOf('=');
  if (e < 0) continue;
  let v = t.slice(e + 1).trim();
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length-1] === v[0]) v = v.slice(1, -1);
  env[t.slice(0, e).trim()] = v;
}
const { MongoClient } = require(path.join(ROOT, 'node_modules', 'mongodb'));
(async () => {
  const c = new MongoClient(env.MONGO_URI, { serverSelectionTimeoutMS: 3000 });
  await c.connect();
  const db = c.db('trading_bot');
  const t24 = new Date(Date.now() - 24 * 3600 * 1000);
  const [sigs, rej, pOpen, pNew, jobsA, errs, pf, lastJ, dbs] = await Promise.all([
    db.collection('signal_history').countDocuments({ createdAt: { $gte: t24 } }),
    db.collection('signal_history').countDocuments({ createdAt: { $gte: t24 }, rejected: true }),
    db.collection('option_positions').countDocuments({ paper: true, status: 'open' }),
    db.collection('option_positions').countDocuments({ paper: true, createdAt: { $gte: t24 } }),
    db.collection('backtest_jobs').countDocuments({ status: { $in: ['QUEUED','RUNNING','COMPUTING'] } }),
    db.collection('logs').countDocuments({ at: { $gte: t24 }, level: 'error' }),
    db.collection('meta').findOne({ _id: 'last_backtest_pf' }),
    db.collection('backtest_jobs').find({ type: 'backtest-compare' }).sort({ createdAt: -1 }).limit(1).toArray(),
    db.command({ dbStats: 1 }),
  ]);
  console.log(`SIG24=${sigs} rej=${rej}`);
  console.log(`PAPER=${pOpen}open ${pNew}new24`);
  console.log(`JOBS=${jobsA}active`);
  console.log(`ERR24=${errs}`);
  if (pf) {
    const ageH = ((Date.now() - new Date(pf.recordedAt).getTime()) / 3600000).toFixed(1);
    console.log(`PF=${pf.pf}@${new Date(pf.recordedAt).toISOString().slice(5,16)} age=${ageH}h`);
  } else console.log('PF=none');
  if (lastJ[0]) {
    const j = lastJ[0];
    const min = ((Date.now() - new Date(j.finishedAt || j.createdAt).getTime()) / 60000).toFixed(0);
    console.log(`LASTJOB=${j.status}@${min}min ago (${j._id.toString().slice(0,8)})`);
  }
  console.log(`DB=${Math.round(dbs.dataSize / 1048576)}MB`);
  await c.close();
})().catch(e => console.log('DBERR:' + e.message));