'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
process.chdir(ROOT);

const env = {};
const envPath = path.join(ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 1) continue;
    let v = t.slice(eq + 1).trim();
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) v = v.slice(1, -1);
    env[t.slice(0, eq).trim()] = v;
  }
}
const MONGO_URI = env.MONGO_URI;
const TOKEN = env.ADMIN_TOKEN || '';
if (!MONGO_URI) { console.error('MONGO_URI missing'); process.exit(1); }

const { MongoClient } = require(path.join(ROOT, 'node_modules', 'mongodb'));
const args = process.argv.slice(2);
const CHECK_ONLY = args.includes('--check');
const FORCE = args.includes('--force');
const log = (m) => console.log('[' + new Date().toISOString() + '] ' + m);

const fetchJ = (url) => new Promise((resolve, reject) => {
  const q = http.get(url, { timeout: 10000, headers: { 'x-admin-token': TOKEN, 'Accept': 'application/json' } }, (r) => {
    let b = ''; r.on('data', d => b += d);
    r.on('end', () => { try { resolve(JSON.parse(b)); } catch (_) { reject(new Error('badjson')); } });
  });
  q.on('timeout', () => { q.destroy(); reject(new Error('timeout')); });
  q.on('error', reject);
});

const postJ = (urlPath, body) => new Promise((resolve, reject) => {
  const data = JSON.stringify(body);
  const req = http.request({
    host: '127.0.0.1', port: 3000, path: urlPath, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': TOKEN, 'Content-Length': Buffer.byteLength(data) }
  }, (r) => {
    let b = ''; r.on('data', d => b += d);
    r.on('end', () => { try { resolve({ status: r.statusCode, json: JSON.parse(b) }); } catch (_) { resolve({ status: r.statusCode, text: b }); } });
  });
  req.on('error', reject); req.write(data); req.end();
});

(async () => {
  log('auto-backtest start (check=' + CHECK_ONLY + ', force=' + FORCE + ')');
  const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  const db = client.db('trading_bot');

  const holiday = await db.collection('meta').findOne({ _id: 'holiday' });
  const today = new Date(Date.now() + 3.5 * 3600 * 1000).toISOString().slice(0, 10);
  if (holiday && holiday.date === today) { log('skip: holiday ' + today); await client.close(); return; }

  if (!FORCE) {
    const lastPF = await db.collection('meta').findOne({ _id: 'last_backtest_pf' });
    if (lastPF && lastPF.recordedAt) {
      const ageH = (Date.now() - new Date(lastPF.recordedAt).getTime()) / 3600000;
      if (ageH < 12) { log('skip: last PF only ' + ageH.toFixed(1) + 'h old (use --force to override)'); await client.close(); return; }
    }
  }

  const activeCount = await db.collection('backtest_jobs').countDocuments({
    status: { $in: ['QUEUED', 'RUNNING'] },
    type: { $in: ['backtest-compare', 'backtest', 'pipeline', 'auto-config'] }
  });
  if (activeCount > 0) { log('skip: ' + activeCount + ' active jobs'); await client.close(); return; }

  await client.close();

  let strats, syms;
  try {
    strats = await fetchJ('http://127.0.0.1:3000/api/strategies');
    syms = await fetchJ('http://127.0.0.1:3000/api/monitored-symbols');
  } catch (e) { log('fetch error: ' + e.message); process.exit(1); }
  if (!Array.isArray(strats) || !Array.isArray(syms)) { log('bad response from API'); process.exit(1); }

  const strategies = strats.filter(s => !s.deprecated).map(s => ({ id: s.id }));
  const symbols = syms.map(s => s.symbol);
  if (!strategies.length || !symbols.length) { log('no strategies or symbols'); process.exit(1); }

  const fromTs = Math.floor(new Date('2026-06-09T00:00:00Z').getTime() / 1000);
  const toTs = Math.floor(Date.now() / 1000);
  const body = {
    mode: 'option', symbols, strategies, dateFrom: fromTs, dateTo: toTs,
    optionType: 'call', qualityLevel: 'B',
    panels: {
      analysis: { enabled: true, minTrades: 5, iterations: 5000 },
      portfolio: { enabled: true, capital: 100000000, riskPct: 1.5 },
      wf: { enabled: false }, regime: { enabled: false }
    }
  };
  log('plan: ' + symbols.length + ' sym x ' + strategies.length + ' strat = ' + (symbols.length * strategies.length) + ' combos');

  if (CHECK_ONLY) { log('CHECK_ONLY: would start now (dry-run, not started)'); return; }

  try {
    const r = await postJ('/api/backtest/run', body);
    if (r.json && r.json.jobId) log('STARTED jobId=' + r.json.jobId + ' status=' + r.json.status);
    else log('FAILED response: ' + JSON.stringify(r).slice(0, 300));
  } catch (e) { log('post error: ' + e.message); process.exit(1); }
})().catch(e => { log('FATAL: ' + e.message); process.exit(1); });