'use strict';
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');
const cron = require('node-cron');
const os = require('os');
const fs = require('fs');
const { execSync } = require('child_process');
const { ObjectId } = require('mongodb');
const { connectDB, getDB } = require('./db');
const Strat = require('./strategies.js');
const { STRATEGIES, aggregateCandles, getRequiredCandles } = Strat;
const Options = require('./option.js');
const Tsetmc = require('./tsetmc.js');
const AlgotikClient = require('./algotik_client.js');
const BtService = require('./backtest_service.js');
const Log = require('./log.js');
const Settings = require('./settings.js');

Log.patchConsole();
const STARTED_AT = new Date();

const app = express();
app.disable('x-powered-by');
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const SERVER_VERSION = 'v10.0-chunked';
let holidayDate = null, inactiveTicks = 0;

const API_KEYS = [process.env.BRSAPI_KEY_1 || process.env.BRSAPI_KEY, process.env.BRSAPI_KEY_2, process.env.BRSAPI_KEY_3].filter(Boolean);
const PER_KEY_LIMIT = 90;
const HISTORY_PER_KEY_LIMIT = 10;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TELEGRAM_API_BASE = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const TF = Object.fromEntries(Object.entries(Strat.TIMEFRAME_MINUTES).filter(([k]) => k !== '4h'));
const ALL_CHART_TF = { ...TF, '1w': 10080, '1M': 43200, '1Y': 525600 };

const SESSION_START = 9 * 60, SESSION_END = 12 * 60 + 30;
const toMin = s => { const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0); };
const fmtMin = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

let ENTRY_START = toMin(process.env.ENTRY_START || '09:30');
let ENTRY_END = toMin(process.env.ENTRY_END || '12:00');

app.use(cors());
app.use(express.json({ limit: '5mb' }));

app.use((req, res, next) => {
    if (req.path.startsWith('/api/backtest') || req.path.startsWith('/api/auto-configure') || req.path.startsWith('/api/algotik') || req.path.startsWith('/api/jobs')) {
        req.setTimeout(30 * 60 * 1000);
        res.setTimeout(30 * 60 * 1000);
    }
    next();
});

app.use((req, res, next) => {
    if (!['POST', 'PUT', 'DELETE'].includes(req.method)) return next();
    if (!ADMIN_TOKEN) return next();
    if (req.headers['x-admin-token'] === ADMIN_TOKEN) return next();
    res.status(401).json({ error: 'توکن ادمین نامعتبر است' });
});
app.get('/api/auth/check', (req, res) => res.json({ required: !!ADMIN_TOKEN, ok: !ADMIN_TOKEN || req.headers['x-admin-token'] === ADMIN_TOKEN }));

// ==================== Trading Settings ====================
app.get('/api/trading-settings', async (req, res, next) => { try { res.json({ values: Settings.get(), defaults: Settings.DEFAULTS }); } catch (e) { next(e); } });
app.put('/api/trading-settings', async (req, res, next) => {
    try {
        await Settings.save(req.body || {});
        await reloadEntryWindow();
        if (typeof Options.reloadFromSettings === 'function') Options.reloadFromSettings();
        res.json({ success: true, values: Settings.get() });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// ==================== Strategy Defaults ====================
app.get('/api/strategy-defaults', (req, res) => {
    const overrides = Settings.getAllStrategyDefaults();
    const all = {};
    Object.values(STRATEGIES).forEach(s => { all[s.id] = { ...s.defaultParams, ...(overrides[s.id] || {}) }; });
    res.json({ defaults: all, overrides });
});
app.put('/api/strategy-defaults', async (req, res, next) => {
    try {
        const { overrides } = req.body || {};
        if (!overrides || typeof overrides !== 'object') return res.status(400).json({ error: 'ساختار نامعتبر' });
        const clean = {};
        for (const [sid, params] of Object.entries(overrides)) {
            if (!STRATEGIES[sid]) continue;
            clean[sid] = {};
            for (const [k, v] of Object.entries(params || {})) if (STRATEGIES[sid].defaultParams[k] !== undefined && Number.isFinite(+v)) clean[sid][k] = +v;
        }
        await Settings.saveStrategyDefaults(clean);
        res.json({ success: true, overrides: clean });
    } catch (e) { next(e); }
});
app.delete('/api/strategy-defaults/:strategyId?', async (req, res, next) => { try { await Settings.resetStrategyDefaults(req.params.strategyId || null); res.json({ success: true }); } catch (e) { next(e); } });

app.get('/ping', (req, res) => res.json({ pong: true, time: new Date().toISOString() }));
app.get('/strategies.js', (req, res) => { res.setHeader('Cache-Control', 'no-store'); res.sendFile(path.join(__dirname, 'strategies.js')); });

// ==================== Tehran Time Helpers ====================
function getTehranParts(date = new Date()) {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, weekday: 'short' });
    const map = {}; fmt.formatToParts(date).forEach(p => { map[p.type] = p.value; });
    return { year: +map.year, month: +map.month, day: +map.day, hour: (+map.hour) % 24, minute: +map.minute, second: +map.second, weekday: map.weekday };
}
const tehranPartsToUTCDate = (y, mo, d, h, mi) => new Date(Date.UTC(y, mo - 1, d, h, mi, 0) - 3.5 * 3600 * 1000);
const minuteOfDay = t => t.hour * 60 + t.minute;
const todayDateString = t => `${t.year}-${String(t.month).padStart(2, '0')}-${String(t.day).padStart(2, '0')}`;
const isTradingDay = t => ['Sat', 'Sun', 'Mon', 'Tue', 'Wed'].includes(t.weekday);
const isMarketOpen = t => isTradingDay(t) && minuteOfDay(t) >= SESSION_START && minuteOfDay(t) <= SESSION_END;
function getBucketTime(t, size) { const b = Math.floor(minuteOfDay(t) / size) * size; return tehranPartsToUTCDate(t.year, t.month, t.day, Math.floor(b / 60), b % 60); }
const dayStartUTC = t => tehranPartsToUTCDate(t.year, t.month, t.day, 0, 0);

// ==================== API Keys Management ====================
const usageId = (i, prefix = 'allsymbols') => `${prefix}_usage_key${i + 1}`;
async function getKeyUsage(i, prefix = 'allsymbols') {
    const db = getDB(), today = todayDateString(getTehranParts());
    let doc = await db.collection('meta').findOne({ _id: usageId(i, prefix) });
    if (!doc || doc.date !== today) { await db.collection('meta').updateOne({ _id: usageId(i, prefix) }, { $set: { date: today, count: 0 } }, { upsert: true }); doc = { date: today, count: 0 }; }
    return doc;
}
async function acquireApiKey(prefix = 'allsymbols', limit = PER_KEY_LIMIT) {
    for (let i = 0; i < API_KEYS.length; i++) {
        const u = await getKeyUsage(i, prefix);
        if (u.count < limit) { await getDB().collection('meta').updateOne({ _id: usageId(i, prefix) }, { $inc: { count: 1 } }); return { key: API_KEYS[i], index: i }; }
    }
    return null;
}
async function getAllUsage() {
    const keys = []; for (let i = 0; i < API_KEYS.length; i++) { const u = await getKeyUsage(i); keys.push({ index: i + 1, count: u.count, limit: PER_KEY_LIMIT }); }
    const hist = []; for (let i = 0; i < API_KEYS.length; i++) { const u = await getKeyUsage(i, 'history'); hist.push({ index: i + 1, count: u.count, limit: HISTORY_PER_KEY_LIMIT }); }
    return { date: todayDateString(getTehranParts()), keys, total: keys.reduce((s, k) => s + k.count, 0), totalLimit: API_KEYS.length * PER_KEY_LIMIT, history: { keys: hist, total: hist.reduce((s, k) => s + k.count, 0), totalLimit: API_KEYS.length * HISTORY_PER_KEY_LIMIT } };
}
app.get('/api/usage', async (req, res, next) => { try { res.json(await getAllUsage()); } catch (e) { next(e); } });

// ==================== Symbols Cache ====================
let symbolsCache = [];
async function fetchAllSymbolsRaw() {
    if (!API_KEYS.length) throw new Error('هیچ کلید BrsApi تنظیم نشده است.');
    const picked = await acquireApiKey();
    if (!picked) throw new Error('سهمیه روزانه همه کلیدها تمام شده است.');
    const r = await fetch(`https://Api.BrsApi.ir/Tsetmc/AllSymbols.php?key=${picked.key}&type=1`, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, timeout: 20000 });
    if (!r.ok) throw new Error(`HTTP ${r.status} (کلید ${picked.index + 1})`);
    const data = await r.json();
    if (!Array.isArray(data)) throw new Error('پاسخ نامعتبر از BrsApi');
    return data;
}
async function updateSymbolsCacheFromRaw(raw) {
    symbolsCache = raw.filter(s => s.l18).map(s => ({ symbol: s.l18, name: s.l30, price: s.pl }));
    await getDB().collection('meta').updateOne({ _id: 'symbols_cache' }, { $set: { symbols: symbolsCache, updatedAt: new Date() } }, { upsert: true }).catch(() => {});
}
async function loadSymbolsCacheFromDB() {
    const doc = await getDB().collection('meta').findOne({ _id: 'symbols_cache' });
    if (doc && doc.symbols && doc.symbols.length) { symbolsCache = doc.symbols; return true; }
    return false;
}
app.get('/api/symbols/search', (req, res) => {
    const q = (req.query.q || '').trim(); if (!q) return res.json([]);
    res.json(symbolsCache.filter(s => s.symbol.includes(q) || (s.name && s.name.includes(q))).slice(0, 20));
});
function getUnderlyingNames(symbol) {
    const names = new Set([Options.norm(symbol)]);
    const found = symbolsCache.find(s => s.symbol === symbol);
    if (found && found.name) names.add(Options.norm(found.name));
    return Array.from(names);
}

// ==================== Quotes ====================
const lastQuotes = new Map();
let rawSymbolsCache = { at: 0, data: null };
async function fetchAllSymbolsRawCached(maxAgeMs = 15000) {
    if (rawSymbolsCache.data && Date.now() - rawSymbolsCache.at < maxAgeMs) return rawSymbolsCache.data;
    const data = await fetchAllSymbolsRaw();
    rawSymbolsCache = { at: Date.now(), data };
    return data;
}
app.get('/api/quotes', (req, res) => {
    const out = {};
    for (const [sym, q] of lastQuotes) out[sym] = { price: q.price, queue: q.queue, at: q.at };
    res.json(out);
});
async function refreshSymbolData(symbol) {
    try {
        const raw = await fetchAllSymbolsRawCached(60000);
        await updateSymbolsCacheFromRaw(raw);
        const rawMap = new Map();
        raw.forEach(s => { if (s.l18) rawMap.set(s.l18, s); });
        const s = rawMap.get(symbol);
        if (!s) return false;
        const price = +s.pl;
        if (!price) return false;
        const tmax = +s.tmax || 0, tmin = +s.tmin || 0;
        const queue = tmax > 0 && price >= tmax ? 'buy' : (tmin > 0 && price <= tmin ? 'sell' : null);
        lastQuotes.set(symbol, { price, queue, at: new Date() });
        const tehran = getTehranParts();
        const bucket1 = getBucketTime(tehran, 1);
        const dayTime = dayStartUTC(tehran);
        await upsertLiveCandle(symbol, bucket1, price, 0);
        await upsertDailyCandle(symbol, dayTime, s);
        return true;
    } catch (e) { console.error('refreshSymbolData:', e.message); return false; }
}

// ==================== Telegram ====================
async function telegramSend(text) {
    if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) throw new Error('تلگرام تنظیم نشده است');
    const r = await fetch(`${TELEGRAM_API_BASE}/bot${TELEGRAM_TOKEN}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text }), timeout: 15000 });
    const d = await r.json(); if (!d.ok) throw new Error(d.description || 'خطای تلگرام');
}
let flushing = false;
async function flushOutbox() {
    if (flushing) return; flushing = true;
    try {
        const col = getDB().collection('telegram_outbox');
        const pending = await col.find({ sentAt: null, attempts: { $lt: 120 } }).sort({ createdAt: 1 }).limit(10).toArray();
        for (const p of pending) {
            try { await telegramSend(p.text); await col.updateOne({ _id: p._id }, { $set: { sentAt: new Date() } }); }
            catch (e) { await col.updateOne({ _id: p._id }, { $inc: { attempts: 1 }, $set: { lastError: e.message } }); console.error('تلگرام:', e.message); break; }
        }
    } finally { flushing = false; }
}
async function notify(text) { await getDB().collection('telegram_outbox').insertOne({ text, createdAt: new Date(), attempts: 0, sentAt: null }); flushOutbox().catch(() => {}); }
app.post('/api/telegram/test', async (req, res, next) => { try { await notify('پیام تست'); await flushOutbox(); res.json({ success: true }); } catch (e) { next(e); } });

// ==================== AlgoTik Collector Endpoints ====================
app.get('/api/algotik/health', async (req, res, next) => {
    try { const online = await AlgotikClient.isOnline(); res.json({ online }); }
    catch (e) { res.json({ online: false, error: e.message }); }
});
app.get('/api/algotik/status', async (req, res, next) => { try { res.json(await AlgotikClient.getStatus()); } catch (e) { next(e); } });
app.get('/api/algotik/logs', async (req, res, next) => {
    try { const limit = Math.min(+req.query.limit || 50, 500); res.json(await AlgotikClient.getLogs(limit)); }
    catch (e) { next(e); }
});
app.post('/api/algotik/fetch-stocks', async (req, res, next) => {
    try {
        const { symbols, months, startDate, wait, skipExisting } = req.body || {};
        let list;
        if (symbols && symbols.length) list = symbols;
        else {
            const ms = await getDB().collection('monitored_symbols').find({ collectEnabled: { $ne: false } }).toArray();
            list = ms.map(s => s.symbol);
        }
        if (!list.length) return res.status(400).json({ error: 'لیست نمادها خالی است' });
        const result = await AlgotikClient.fetchStocks(list, months || 24, { wait: !!wait, startDate, skipExisting });
        res.json(result);
    } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/algotik/fetch-options', async (req, res, next) => {
    try {
        const { underlyings, skipExisting } = req.body || {};
        let list;
        if (underlyings && underlyings.length) list = underlyings;
        else {
            const ms = await getDB().collection('monitored_symbols').find({ collectEnabled: { $ne: false } }).toArray();
            list = ms.map(s => s.symbol);
        }
        res.json(await AlgotikClient.fetchOptions(list, { skipExisting }));
    } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/algotik/fetch-options-daily', async (req, res, next) => {
    try {
        const { underlyings } = req.body || {};
        let list;
        if (underlyings && underlyings.length) list = underlyings;
        else {
            const ms = await getDB().collection('monitored_symbols').find({ collectEnabled: { $ne: false } }).toArray();
            list = ms.map(s => s.symbol);
        }
        res.json(await AlgotikClient.fetchOptionsDaily(list));
    } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/algotik/backfill-all', async (req, res, next) => {
    try { const { months, withOptions } = req.body || {}; res.json(await AlgotikClient.backfillAll(months || 24, withOptions !== false)); }
    catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/algotik/options-daily-job', async (req, res, next) => {
    try {
        const { underlyings, force } = req.body || {};
        let list;
        if (underlyings && underlyings.length) list = underlyings;
        else {
            const ms = await getDB().collection('monitored_symbols').find({ collectEnabled: { $ne: false } }).toArray();
            list = ms.map(s => s.symbol);
        }
        res.json(await AlgotikClient.startOptionsDailyJob(list, !!force));
    } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/algotik/job/:id', async (req, res, next) => { try { res.json(await AlgotikClient.getJobStatus(req.params.id)); } catch (e) { next(e); } });
app.get('/api/algotik/jobs', async (req, res, next) => { try { res.json(await AlgotikClient.listJobs(+req.query.limit || 20)); } catch (e) { next(e); } });
app.post('/api/algotik/job/:id/cancel', async (req, res, next) => {
    try { res.json(await AlgotikClient.cancelJob(req.params.id)); }
    catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/algotik/options-history', async (req, res, next) => {
    try {
        const { symbol, months } = req.body || {};
        if (!symbol) return res.status(400).json({ error: 'symbol الزامی' });
        res.json(await AlgotikClient.fetchOptionsHistoryBulk(symbol, months || 24));
    } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/algotik/stats', async (req, res, next) => {
    try {
        const db = getDB();
        const stockCount = await db.collection('candles_base').countDocuments({ source: 'algotik' });
        const symbols = await db.collection('candles_base').distinct('symbol', { source: 'algotik' });
        const optSnap = await db.collection('option_snapshots_algotik').countDocuments({});
        const optDaily = await db.collection('option_daily_algotik').countDocuments({});
        const lastSnap = await db.collection('option_snapshots_algotik').find({}).sort({ timestamp: -1 }).limit(1).toArray();
        const lastDaily = await db.collection('option_daily_algotik').find({}).sort({ date: -1 }).limit(1).toArray();
        res.json({
            stocks: { candles: stockCount, symbols: symbols.length },
            options: { snapshots: optSnap, dailyRecords: optDaily, lastSnapshotAt: lastSnap[0]?.timestamp || null, lastDailyDate: lastDaily[0]?.date || null }
        });
    } catch (e) { next(e); }
});

// ==================== System Stats ====================
app.get('/api/system/stats', async (req, res, next) => {
    try {
        // RAM
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const usedMem = totalMem - freeMem;

        // CPU (load average)
        const loadAvg = os.loadavg();
        const cpuCount = os.cpus().length;
        const cpuPercent = Math.min(100, Math.round((loadAvg[0] / cpuCount) * 100));

        // Disk
        let diskTotal = 0, diskUsed = 0, diskFree = 0;
        try {
            const out = execSync("df -B1 / | tail -1 | awk '{print $2, $3, $4}'").toString().trim();
            [diskTotal, diskUsed, diskFree] = out.split(/\s+/).map(Number);
        } catch (e) { /* ignore */ }

        // Per-process stats
        const procs = [];
        try {
            // node processes via pm2
            const pm2Raw = execSync('pm2 jlist 2>/dev/null || echo "[]"').toString();
            const pm2List = JSON.parse(pm2Raw);
            for (const p of pm2List) {
                procs.push({
                    name: p.name,
                    type: 'node',
                    pid: p.pid,
                    status: p.pm2_env?.status,
                    cpu: p.monit?.cpu || 0,
                    memoryMB: Math.round((p.monit?.memory || 0) / 1048576),
                    restarts: p.pm2_env?.restart_time || 0
                });
            }
        } catch (e) { /* ignore */ }

        try {
            // Collector (systemd)
            const collOut = execSync("systemctl show collector -p MainPID,MemoryCurrent,CPUUsageNSec,ActiveState --no-pager 2>/dev/null || true").toString();
            const coll = {};
            collOut.split('\n').forEach(l => { const i = l.indexOf('='); if (i > 0) coll[l.slice(0, i)] = l.slice(i + 1); });
            if (coll.ActiveState === 'active') {
                procs.push({
                    name: 'collector',
                    type: 'python',
                    pid: +coll.MainPID || null,
                    status: 'online',
                    memoryMB: coll.MemoryCurrent && coll.MemoryCurrent !== '[not set]' ? Math.round(+coll.MemoryCurrent / 1048576) : null,
                    cpuMsTotal: coll.CPUUsageNSec && coll.CPUUsageNSec !== '[not set]' ? Math.round(+coll.CPUUsageNSec / 1e6) : null
                });
            }
        } catch (e) { /* ignore */ }

        try {
            // MongoDB container
            const mongoRaw = execSync('docker stats mongodb --no-stream --format "{{.MemUsage}}|{{.CPUPerc}}" 2>/dev/null || echo "-"').toString().trim();
            if (mongoRaw && mongoRaw !== '-') {
                const [memStr, cpuStr] = mongoRaw.split('|');
                const memMatch = memStr.match(/([\d.]+)([KMG]iB)/);
                let memoryMB = null;
                if (memMatch) {
                    const v = parseFloat(memMatch[1]);
                    memoryMB = Math.round(memMatch[2] === 'GiB' ? v * 1024 : (memMatch[2] === 'KiB' ? v / 1024 : v));
                }
                procs.push({
                    name: 'mongodb', type: 'docker',
                    status: 'running', memoryMB,
                    cpu: parseFloat(cpuStr) || 0
                });
            }
        } catch (e) { /* ignore */ }

        // MongoDB collections size
        let dbStats = {};
        try {
            const d = getDB();
            const s = await d.command({ dbStats: 1 });
            dbStats = {
                sizeMB: Math.round(s.dataSize / 1048576),
                storageMB: Math.round((s.storageSize + s.indexSize) / 1048576),
                collections: s.collections,
                objects: s.objects
            };
        } catch (e) { /* ignore */ }

        // Docker disk
        let dockerDisk = {};
        try {
            const dOut = execSync('docker system df --format "{{.Type}}|{{.Size}}|{{.Reclaimable}}"').toString();
            dOut.split('\n').filter(Boolean).forEach(l => {
                const [t, s, r] = l.split('|');
                dockerDisk[t] = { size: s, reclaimable: r };
            });
        } catch (e) { /* ignore */ }

        res.json({
            ram: { totalMB: Math.round(totalMem / 1048576), usedMB: Math.round(usedMem / 1048576), freeMB: Math.round(freeMem / 1048576), usedPct: Math.round((usedMem / totalMem) * 100) },
            cpu: { loadAvg: loadAvg.map(x => +x.toFixed(2)), cores: cpuCount, usedPct: cpuPercent },
            disk: { totalGB: +(diskTotal / 1073741824).toFixed(1), usedGB: +(diskUsed / 1073741824).toFixed(1), freeGB: +(diskFree / 1073741824).toFixed(1), usedPct: diskTotal ? Math.round((diskUsed / diskTotal) * 100) : 0 },
            processes: procs,
            database: dbStats,
            docker: dockerDisk,
            uptime: Math.round(process.uptime()),
            serverStartedAt: STARTED_AT
        });
    } catch (e) { next(e); }
});

// ==================== Aggregated Jobs ====================
app.get('/api/system/jobs', async (req, res, next) => {
    try {
        const db = getDB();
        // Backend jobs
        const backendJobs = await db.collection('backtest_jobs')
            .find({ status: { $in: ['QUEUED', 'RUNNING'] } })
            .sort({ createdAt: -1 }).limit(50).toArray();

        // Collector jobs
        let collectorJobs = [];
        try {
            const r = await AlgotikClient.listJobs(20);
            collectorJobs = (r.jobs || []).filter(j => j.status === 'RUNNING' || j.status === 'QUEUED');
        } catch (e) { /* collector offline */ }

        res.json({
            backend: backendJobs.map(j => ({
                id: String(j._id), source: 'backend', type: j.type, status: j.status,
                progress: j.progress, resourceStats: j.resourceStats,
                createdAt: j.createdAt, startedAt: j.startedAt,
                cancelRequested: j.cancelRequested,
                symbolCount: (j.payload && j.payload.symbols) ? j.payload.symbols.length : 1
            })),
            collector: collectorJobs.map(j => ({
                id: j.job_id, source: 'collector', type: 'collector-job', status: j.status,
                processed: j.processed, total: j.total, records: j.records, errors: j.errors,
                message: j.message, underlyingCount: (j.underlyings || []).length,
                createdAt: j.created_at, startedAt: j.started_at
            }))
        });
    } catch (e) { next(e); }
});

// ==================== Health Tracking ====================
const health = { consecutiveFailures: 0, alerted: false, lastError: null, lastTickAt: null };
async function bumpDayStat(field, n = 1) {
    const today = todayDateString(getTehranParts());
    await getDB().collection('meta').updateOne({ _id: `daystats_${today}` }, { $inc: { [field]: n }, $set: { date: today } }, { upsert: true }).catch(() => {});
}
async function recordTickFailure(msg) {
    health.consecutiveFailures++; health.lastError = msg; await bumpDayStat('ticksFail');
    console.error('تیک ناموفق:', msg);
    if (health.consecutiveFailures === 5 && !health.alerted) { health.alerted = true; await notify(`پنج تیک پیاپی ناموفق!\n${msg}`); }
}
async function recordTickSuccess() {
    if (health.alerted) { health.alerted = false; await notify('سیستم به حالت عادی برگشت.'); }
    health.consecutiveFailures = 0; health.lastTickAt = new Date(); await bumpDayStat('ticksOk');
}
async function sendDailySummary() {
    const today = todayDateString(getTehranParts());
    const st = await getDB().collection('meta').findOne({ _id: `daystats_${today}` }) || {};
    const usage = await getAllUsage();
    let optLine = '', storLine = '', portfolioLine = '';
    try { const list = await getDB().collection('option_positions').find({}).toArray(); const s = Options.positionStats(list); optLine = `\nآپشن: باز ${s.open} | بسته ${s.closed} | وین ریت ${s.winRate.toFixed(0)}% | بازده کل ${s.totalPnl.toFixed(0)}%`; } catch (e) {}
    try { const sg = await Options.storageStats(); storLine = `\nدیتابیس: ${sg.storageMB} MB`; } catch (e) {}
    try {
        const open = await getDB().collection('option_positions').find({ status: 'open' }).toArray();
        let totalExposure = 0;
        for (const p of open) totalExposure += (p.entryAsk || 0) * (p.positionSize || 1) * (p.size || 1000);
        const capital = Settings.capital();
        portfolioLine = `\nسرمایه: ${Math.round(capital).toLocaleString()} | درگیری: ${Math.round(totalExposure).toLocaleString()} (${capital > 0 ? (totalExposure / capital * 100).toFixed(1) : 0}%)`;
    } catch (e) {}
    await notify(`خلاصه روز ${today}\nتیک: موفق ${st.ticksOk || 0} | ناموفق ${st.ticksFail || 0}\nسیگنال: ${st.signals || 0} | لغو: ${st.cancels || 0}${optLine}${portfolioLine}\nAPI: ${usage.total}/${usage.totalLimit}${storLine}`);
}

async function telegramSendBackup(filename, jsonObj) {
    if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) throw new Error('تلگرام تنظیم نشده است');
    const blob = new Blob([JSON.stringify(jsonObj, null, 2)], { type: 'application/json' });
    const form = new FormData();
    form.append('chat_id', TELEGRAM_CHAT_ID);
    form.append('caption', `بکاپ (${todayDateString(getTehranParts())})`);
    form.append('document', blob, filename);
    const r = await globalThis.fetch(`${TELEGRAM_API_BASE}/bot${TELEGRAM_TOKEN}/sendDocument`, { method: 'POST', body: form });
    const d = await r.json(); if (!d.ok) throw new Error(d.description || 'خطای بکاپ');
}
async function sendWeeklyBackup() {
    const db = getDB();
    const [symbols, configs, optSettings, stratDefaults] = await Promise.all([
        db.collection('monitored_symbols').find({}).toArray(),
        db.collection('strategy_configs').find({}).toArray(),
        db.collection('meta').findOne({ _id: 'option_settings' }),
        db.collection('meta').findOne({ _id: 'strategy_defaults' })
    ]);
    await telegramSendBackup(`backup_${todayDateString(getTehranParts())}.json`, { exportedAt: new Date(), monitoredSymbols: symbols, strategyConfigs: configs, optionSettings: optSettings || null, strategyDefaults: stratDefaults || null });
}
app.post('/api/backup/run', async (req, res, next) => { try { await sendWeeklyBackup(); res.json({ success: true }); } catch (e) { next(e); } });

async function markHoliday(t) {
    holidayDate = todayDateString(t);
    await getDB().collection('meta').updateOne({ _id: 'holiday' }, { $set: { date: holidayDate } }, { upsert: true });
    await notify(`امروز (${holidayDate}) احتمالا تعطیل است.`);
}
app.delete('/api/holiday', async (req, res, next) => { try { holidayDate = null; inactiveTicks = 0; await getDB().collection('meta').deleteOne({ _id: 'holiday' }); res.json({ success: true }); } catch (e) { next(e); } });

// ==================== Candle Helpers ====================
async function getBaseCandles(symbol) {
    const base = await getDB().collection('candles_base').find({ symbol }).sort({ time: 1 }).toArray();
    return base.map(c => ({ time: Math.floor(c.time.getTime() / 1000), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0 }));
}
function mergeSessionTail(candles, tfMin) {
    if (tfMin !== 60) return candles;
    const out = [];
    for (const c of candles) {
        const t = getTehranParts(new Date(c.time * 1000)), prev = out[out.length - 1];
        if (t.hour === 12 && prev) {
            const pt = getTehranParts(new Date(prev.time * 1000));
            if (pt.day === t.day && pt.month === t.month && pt.hour === 11) {
                prev.high = Math.max(prev.high, c.high); prev.low = Math.min(prev.low, c.low); prev.close = c.close;
                prev.barCount = (prev.barCount || 0) + (c.barCount || 0); prev.expectedBars = (prev.expectedBars || 0) + (c.expectedBars || 0);
                prev.complete = prev.barCount >= Math.max(1, prev.expectedBars) * 0.6;
                continue;
            }
        }
        out.push({ ...c });
    }
    return out;
}
function buildTfCandles(permanentRows, baseCandles, tfMin) {
    const live = mergeSessionTail(aggregateCandles(baseCandles, tfMin), tfMin);
    const map = new Map(permanentRows.map(c => [Math.floor(c.time.getTime() / 1000), { time: Math.floor(c.time.getTime() / 1000), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0, complete: c.complete }]));
    for (const c of live) map.set(c.time, c);
    return Array.from(map.values()).sort((a, b) => a.time - b.time);
}
async function getCandles(symbol, tf) {
    if (tf === '1d') {
        const d = await getDB().collection('candles_daily').find({ symbol }).sort({ time: 1 }).toArray();
        return d.map(c => ({ time: Math.floor(c.time.getTime() / 1000), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0 }));
    }
    const permanent = await getDB().collection('candles_tf').find({ symbol, tf }).sort({ time: 1 }).toArray();
    return buildTfCandles(permanent, await getBaseCandles(symbol), TF[tf]);
}
async function getCandlesFull(symbol, tf) { return getCandles(symbol, tf); }
async function activeConfigTimeframes() {
    const configs = await getDB().collection('strategy_configs').find({}).toArray();
    const set = new Set();
    configs.forEach(c => { if (TF[c.timeframe] && c.timeframe !== '1d') set.add(c.timeframe); if (TF[c.htfTimeframe] && c.htfTimeframe !== '1d') set.add(c.htfTimeframe); });
    return set;
}
function isCandleClosed(timeSec, tfMin, now = new Date()) {
    const t = getTehranParts(new Date(timeSec * 1000));
    const sessionEnd = tehranPartsToUTCDate(t.year, t.month, t.day, 12, 31);
    if (tfMin >= 1440 || (tfMin === 60 && t.hour === 11)) return now >= sessionEnd;
    const natural = new Date(timeSec * 1000 + tfMin * 60000);
    return now >= (natural < sessionEnd ? natural : sessionEnd);
}
const closedOnly = (candles, tf) => { const now = new Date(); return candles.filter(c => isCandleClosed(c.time, TF[tf], now)); };

async function upsertLiveCandle(symbol, time, price, volDelta) {
    await getDB().collection('candles_base').updateOne({ symbol, time },
        { $setOnInsert: { symbol, time, open: price }, $set: { close: price }, $max: { high: price }, $min: { low: price }, $inc: { volume: volDelta || 0 } }, { upsert: true });
}
async function upsertDailyCandle(symbol, time, s) {
    const pl = +s.pl; const num = v => (+v > 0 ? +v : pl);
    await getDB().collection('candles_daily').updateOne({ symbol, time },
        { $set: { symbol, time, open: num(s.pf), high: num(s.pmax), low: num(s.pmin), close: pl, volume: +s.tvol || 0, trades: +s.tno || 0, source: 'live' } }, { upsert: true });
}

// ==================== Routes ====================
app.get('/api/timeframes', (req, res) => res.json(Object.keys(TF)));
app.get('/api/strategies', (req, res) => {
    const overrides = Settings.getAllStrategyDefaults();
    res.json(Object.values(STRATEGIES).map(s => ({ id: s.id, name: s.name, defaultTimeframe: s.defaultTimeframe, htfTimeframe: s.htfTimeframe || '1d', defaultParams: { ...s.defaultParams, ...(overrides[s.id] || {}) }, baseDefaults: s.defaultParams, overrides: overrides[s.id] || {}, indicators: s.indicators })));
});
app.get('/api/candles/:symbol/:timeframe', async (req, res, next) => {
    const { symbol, timeframe } = req.params; if (!TF[timeframe]) return res.status(400).json({ error: 'تایم فریم نامعتبر' });
    try { res.json(await getCandles(symbol, timeframe)); } catch (e) { next(e); }
});

// Chart endpoint
app.get('/api/chart/:symbol/:timeframe', async (req, res, next) => {
    const { symbol, timeframe } = req.params;
    if (!ALL_CHART_TF[timeframe]) return res.status(400).json({ error: 'تایم فریم نامعتبر' });
    try {
        const db = getDB();
        const isDailyPlus = ['1d', '1w', '1M', '1Y'].includes(timeframe);

        if (!isDailyPlus) {
            const localCount = await db.collection('candles_base').countDocuments({ symbol });
            if (localCount < 100) {
                try {
                    const akInterval = ['1m', '3m', '5m', '10m', '15m', '30m', '1h'].includes(timeframe) ? timeframe : '1m';
                    const ak = await AlgotikClient.fetchChart(symbol, akInterval, 24);
                    if (ak && ak.candles && ak.candles.length > 0) {
                        return res.json({ symbol, timeframe, candles: ak.candles, count: ak.candles.length, source: 'algotik-online' });
                    }
                } catch (e) { console.error('AlgoTik chart online:', e.message); }
            }
        }

        if (isDailyPlus) {
            let daily = await db.collection('candles_daily').find({ symbol }).sort({ time: 1 }).toArray();
            if (daily.length < 50) {
                try {
                    const found = await Tsetmc.searchInstrument(symbol);
                    if (found && found.length) {
                        const hist = await Tsetmc.getDailyHistory(found[0].insCode);
                        for (const r of hist) {
                            await db.collection('candles_daily').updateOne(
                                { symbol, time: r.time },
                                { $setOnInsert: { symbol, time: r.time, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume, trades: r.trades, source: 'tsetmc-chart' } },
                                { upsert: true }
                            );
                        }
                        daily = await db.collection('candles_daily').find({ symbol }).sort({ time: 1 }).toArray();
                    }
                } catch (e) { console.error('chart fetch:', e.message); }
            }
            const rows = daily.map(c => ({ time: Math.floor(new Date(c.time).getTime() / 1000), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0 }));
            const candles = aggregateDailyForChart(rows, timeframe);
            return res.json({ symbol, timeframe, candles, count: candles.length });
        }

        let candles = await getCandles(symbol, timeframe);
        if (candles.length < 50) {
            try {
                await AlgotikClient.fetchStocks([symbol], 24);
                candles = await getCandles(symbol, timeframe);
            } catch (e) { console.error('AlgoTik chart fallback:', e.message); }
        }
        res.json({ symbol, timeframe, candles, count: candles.length, source: candles.length >= 50 ? 'local' : 'limited' });
    } catch (e) { next(e); }
});

app.get('/api/chart/search', async (req, res, next) => {
    try {
        const q = (req.query.q || '').trim();
        if (!q) return res.json({ results: [] });
        const results = [];
        for (const s of symbolsCache) {
            if (s.symbol.includes(q) || (s.name && s.name.includes(q))) {
                results.push({ symbol: s.symbol, name: s.name, source: 'local' });
                if (results.length >= 15) break;
            }
        }
        if (results.length < 10) {
            try {
                const list = await Tsetmc.searchInstrument(q);
                for (const x of list) {
                    if (!results.find(r => r.symbol === x.lVal18AFC)) {
                        results.push({ symbol: x.lVal18AFC, name: x.lVal30, source: 'tsetmc' });
                    }
                    if (results.length >= 20) break;
                }
            } catch (e) {}
        }
        res.json({ results });
    } catch (e) { next(e); }
});
app.get('/api/chart-data/:configId', async (req, res, next) => {
    try {
        const cfg = await getDB().collection('strategy_configs').findOne({ _id: new ObjectId(req.params.configId) });
        if (!cfg) return res.status(404).json({ error: 'تنظیم یافت نشد' });
        const htfTf = cfg.htfTimeframe || '1d';
        const candles = await getCandlesFull(cfg.symbol, cfg.timeframe);
        const htf = closedOnly(await getCandlesFull(cfg.symbol, htfTf), htfTf);
        res.json({ config: cfg, candles, closedCount: closedOnly(candles, cfg.timeframe).length, htfCandles: htf, htfTimeframe: htfTf, entryWindow: { start: ENTRY_START, end: ENTRY_END } });
    } catch (e) { next(e); }
});

app.get('/api/data-coverage', async (req, res, next) => {
    try {
        const db = getDB();
        const monitored = await db.collection('monitored_symbols').find({}).toArray();
        const symbols = [];
        for (const m of monitored) {
            const row = { symbol: m.symbol, timeframes: {}, optionHistory: 0, optionDaily: 0, requirements: {}, backfill: null };
            const tfs = Object.keys(TF).filter(t => t !== '1d');
            for (const tf of tfs) {
                const count = await db.collection('candles_tf').countDocuments({ symbol: m.symbol, tf });
                const oldest = await db.collection('candles_tf').find({ symbol: m.symbol, tf }).sort({ time: 1 }).limit(1).toArray();
                const newest = await db.collection('candles_tf').find({ symbol: m.symbol, tf }).sort({ time: -1 }).limit(1).toArray();
                row.timeframes[tf] = { count, from: oldest[0] ? oldest[0].time : null, to: newest[0] ? newest[0].time : null };
            }
            const dailyCount = await db.collection('candles_daily').countDocuments({ symbol: m.symbol });
            const dOld = await db.collection('candles_daily').find({ symbol: m.symbol }).sort({ time: 1 }).limit(1).toArray();
            const dNew = await db.collection('candles_daily').find({ symbol: m.symbol }).sort({ time: -1 }).limit(1).toArray();
            row.timeframes['1d'] = { count: dailyCount, from: dOld[0]?.time || null, to: dNew[0]?.time || null };
            row.optionHistory = await db.collection('option_history').countDocuments({ underlying: Options.norm(m.symbol) });
            row.optionDaily = await db.collection('option_daily').countDocuments({ underlying: Options.norm(m.symbol) });

            const stockJob = await db.collection('tsetmc_backfill').findOne({ type: 'stock', symbol: m.symbol });
            if (stockJob) {
                row.backfill = { status: stockJob.status, stats: stockJob.stats, startDate: stockJob.startDate, endDate: stockJob.endDate, lookbackMonths: stockJob.lookbackMonths };
            }

            for (const sid of Object.keys(STRATEGIES)) {
                const def = STRATEGIES[sid];
                const tf = def.defaultTimeframe;
                const req = getRequiredCandles(sid, def.defaultParams);
                const have = row.timeframes[tf]?.count || 0;
                row.requirements[sid] = { tf, required: req, have, ok: have >= req, name: def.name };
            }
            symbols.push(row);
        }
        res.json({ symbols, generatedAt: new Date() });
    } catch (e) { next(e); }
});

function jalaliToGregorian(jy, jm, jd) {
    let gy; jy += 1595;
    let days = -355668 + (365 * jy) + (Math.floor(jy / 33) * 8) + Math.floor(((jy % 33) + 3) / 4) + jd + ((jm < 7) ? (jm - 1) * 31 : ((jm - 7) * 30) + 186);
    gy = 400 * Math.floor(days / 146097); days %= 146097;
    if (days > 36524) { gy += 100 * Math.floor(--days / 36524); days %= 36524; if (days >= 365) days++; }
    gy += 4 * Math.floor(days / 1461); days %= 1461;
    if (days > 365) { gy += Math.floor((days - 1) / 365); days = (days - 1) % 365; }
    let gd = days + 1;
    const sal_a = [0, 31, ((gy % 4 === 0 && gy % 100 !== 0) || (gy % 400 === 0)) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let gm; for (gm = 0; gm < 13; gm++) { const v = sal_a[gm]; if (gd <= v) break; gd -= v; }
    return { gy, gm, gd };
}
function parseJalaliDate(s) {
    const [jy, jm, jd] = String(s || '').split('-').map(Number);
    if (!jy || !jm || !jd) return null;
    const { gy, gm, gd } = jalaliToGregorian(jy, jm, jd);
    return tehranPartsToUTCDate(gy, gm, gd, 0, 0);
}
async function importDailyHistory(symbol) {
    if (!API_KEYS.length) throw new Error('هیچ کلید BrsApi تنظیم نشده است.');
    const picked = await acquireApiKey('history', HISTORY_PER_KEY_LIMIT);
    if (!picked) throw new Error('سهمیه دیتای تاریخی تمام شده است.');
    const r = await fetch(`https://Api.BrsApi.ir/Tsetmc/History.php?key=${picked.key}&type=0&l18=${encodeURIComponent(symbol)}`, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, timeout: 20000 });
    if (!r.ok) throw new Error(`HTTP ${r.status} (کلید ${picked.index + 1})`);
    const data = await r.json();
    if (!Array.isArray(data) || !data.length) throw new Error('داده ای برای این نماد یافت نشد');
    const col = getDB().collection('candles_daily'); let added = 0;
    for (const row of data) {
        const time = parseJalaliDate(row.date); if (!time) continue;
        const close = +row.pl || +row.pc || 0; if (!(close > 0)) continue;
        const doc = { symbol, time, open: +row.pf || close, high: +row.pmax || close, low: +row.pmin || close, close, volume: +row.tvol || 0, trades: +row.tno || 0, source: 'brsapi-history' };
        const res = await col.updateOne({ symbol, time }, { $setOnInsert: doc }, { upsert: true });
        if (res.upsertedCount) added++;
    }
    return { added, total: data.length };
}
app.post('/api/import-daily/:symbol', async (req, res) => {
    try { res.json({ success: true, ...(await importDailyHistory(req.params.symbol)) }); }
    catch (e) { console.error('import-daily:', e.message); res.status(400).json({ error: e.message }); }
});

// ==================== Monitored Symbols ====================
app.get('/api/monitored-symbols', async (req, res, next) => {
    try {
        const db = getDB();
        const [symbols, counts, dcounts] = await Promise.all([
            db.collection('monitored_symbols').find({}).sort({ addedAt: 1 }).toArray(),
            db.collection('candles_base').aggregate([{ $group: { _id: '$symbol', c: { $sum: 1 } } }]).toArray(),
            db.collection('candles_daily').aggregate([{ $group: { _id: '$symbol', c: { $sum: 1 } } }]).toArray()
        ]);
        const cm = new Map(counts.map(c => [c._id, c.c])), dm = new Map(dcounts.map(c => [c._id, c.c]));
        res.json(symbols.map(s => ({ ...s, candleCount: cm.get(s.symbol) || 0, dailyCount: dm.get(s.symbol) || 0 })));
    } catch (e) { next(e); }
});
app.post('/api/monitored-symbols', async (req, res, next) => {
    try {
        const { symbol } = req.body; if (!symbol) return res.status(400).json({ error: 'symbol الزامی است' });
        const db = getDB();
        if (await db.collection('monitored_symbols').findOne({ symbol })) return res.status(400).json({ error: 'این نماد قبلا اضافه شده است' });
        const doc = { symbol, addedAt: new Date(), collectEnabled: true };
        const r = await db.collection('monitored_symbols').insertOne(doc);
        await refreshSymbolData(symbol).catch(() => {});
        res.json({ _id: r.insertedId, ...doc });
    } catch (e) { next(e); }
});
app.put('/api/monitored-symbols/:id', async (req, res, next) => {
    try {
        const upd = {};
        if (typeof req.body.collectEnabled === 'boolean') upd.collectEnabled = req.body.collectEnabled;
        if (req.body.notes !== undefined) upd.notes = String(req.body.notes || '');
        if (!Object.keys(upd).length) return res.status(400).json({ error: 'فیلدی مشخص نشد' });
        await getDB().collection('monitored_symbols').updateOne({ _id: new ObjectId(req.params.id) }, { $set: upd });
        res.json({ success: true });
    } catch (e) { next(e); }
});
app.post('/api/monitored-symbols/bulk-collect', async (req, res, next) => {
    try {
        const { ids, collectEnabled } = req.body || {};
        if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'لیست خالی' });
        if (typeof collectEnabled !== 'boolean') return res.status(400).json({ error: 'collectEnabled باید boolean باشد' });
        const objectIds = ids.map(id => new ObjectId(id));
        const r = await getDB().collection('monitored_symbols').updateMany({ _id: { $in: objectIds } }, { $set: { collectEnabled } });
        res.json({ success: true, updated: r.modifiedCount });
    } catch (e) { next(e); }
});
app.delete('/api/monitored-symbols/:id', async (req, res, next) => {
    try {
        const db = getDB(); const doc = await db.collection('monitored_symbols').findOne({ _id: new ObjectId(req.params.id) });
        if (!doc) return res.status(404).json({ error: 'یافت نشد' });
        const n = await db.collection('strategy_configs').countDocuments({ symbol: doc.symbol });
        if (n) return res.status(400).json({ error: `این نماد در ${n} تنظیم استفاده شده است.` });
        await db.collection('monitored_symbols').deleteOne({ _id: doc._id }); res.json({ success: true });
    } catch (e) { next(e); }
});

// ==================== Strategy Configs ====================
app.get('/api/strategy-configs', async (req, res, next) => { try { res.json(await getDB().collection('strategy_configs').find({}).sort({ createdAt: 1 }).toArray()); } catch (e) { next(e); } });
app.post('/api/strategy-configs', async (req, res, next) => {
    try {
        const { symbol, strategyId, timeframe, htfTimeframe, candleType, params, enabled, role } = req.body;
        if (!symbol || !STRATEGIES[strategyId]) return res.status(400).json({ error: 'نماد یا استراتژی نامعتبر' });
        if (!TF[timeframe]) return res.status(400).json({ error: 'تایم فریم نامعتبر' });
        const htf = htfTimeframe || STRATEGIES[strategyId].htfTimeframe || '1d';
        if (!TF[htf] || TF[htf] <= TF[timeframe]) return res.status(400).json({ error: 'تایم فریم بالا باید بزرگتر باشد' });
        const db = getDB();
        if (!await db.collection('monitored_symbols').findOne({ symbol })) return res.status(400).json({ error: 'ابتدا نماد را اضافه کنید.' });
        const overrides = Settings.getStrategyDefaults(strategyId);
        const defaultParams = { ...STRATEGIES[strategyId].defaultParams, ...overrides, ...(params || {}) };
        const finalRole = (role === 'confirmer') ? 'confirmer' : 'leader';
        const doc = { symbol, strategyId, timeframe, htfTimeframe: htf, candleType: candleType === 'simple' ? 'simple' : 'heikin', params: defaultParams, enabled: enabled !== false, role: finalRole, createdAt: new Date() };
        const r = await db.collection('strategy_configs').insertOne(doc);
        const fullDoc = { _id: r.insertedId, ...doc };
        await evaluateStrategyConfig(fullDoc, null).catch(e => console.error('ارزیابی آنی:', e.message));
        res.json(fullDoc);
    } catch (e) { next(e); }
});
app.put('/api/strategy-configs/:id', async (req, res, next) => {
    try {
        const upd = {};
        if (req.body.params !== undefined) upd.params = req.body.params;
        if (req.body.enabled !== undefined) upd.enabled = req.body.enabled;
        if (req.body.role === 'leader' || req.body.role === 'confirmer') upd.role = req.body.role;
        await getDB().collection('strategy_configs').updateOne({ _id: new ObjectId(req.params.id) }, { $set: upd });
        // Invalidate trade cache since params may have changed
        await BtService.invalidateCacheForConfig(req.params.id).catch(() => {});
        res.json({ success: true });
    } catch (e) { next(e); }
});
app.delete('/api/strategy-configs/:id', async (req, res, next) => {
    try {
        const db = getDB();
        await db.collection('strategy_configs').deleteOne({ _id: new ObjectId(req.params.id) });
        await db.collection('signals_state').deleteOne({ configId: req.params.id });
        await BtService.invalidateCacheForConfig(req.params.id).catch(() => {});
        res.json({ success: true });
    } catch (e) { next(e); }
});
app.post('/api/strategy-configs/bulk-delete', async (req, res, next) => {
    try {
        const { ids } = req.body || {};
        if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'لیست خالی است' });
        const db = getDB();
        const objectIds = ids.map(id => new ObjectId(id));
        const del = await db.collection('strategy_configs').deleteMany({ _id: { $in: objectIds } });
        await db.collection('signals_state').deleteMany({ configId: { $in: ids } });
        res.json({ success: true, deleted: del.deletedCount });
    } catch (e) { next(e); }
});
app.post('/api/strategy-configs/bulk-update', async (req, res, next) => {
    try {
        const { ids, enabled, role } = req.body || {};
        if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'لیست خالی است' });
        const upd = {};
        if (typeof enabled === 'boolean') upd.enabled = enabled;
        if (role === 'leader' || role === 'confirmer') upd.role = role;
        if (!Object.keys(upd).length) return res.status(400).json({ error: 'فیلدی مشخص نشد' });
        const db = getDB();
        const objectIds = ids.map(id => new ObjectId(id));
        const r = await db.collection('strategy_configs').updateMany({ _id: { $in: objectIds } }, { $set: upd });
        res.json({ success: true, updated: r.modifiedCount });
    } catch (e) { next(e); }
});

app.get('/api/status', async (req, res, next) => { try { res.json(await getDB().collection('signals_state').find({}).toArray()); } catch (e) { next(e); } });
app.get('/api/signal-history', async (req, res, next) => { try { res.json(await getDB().collection('signal_history').find({}).sort({ createdAt: -1 }).limit(300).toArray()); } catch (e) { next(e); } });
app.delete('/api/signal-history', async (req, res, next) => { try { await getDB().collection('signal_history').deleteMany({}); res.json({ success: true }); } catch (e) { next(e); } });

app.get('/api/portfolio', async (req, res, next) => {
    try {
        const s = Settings.get();
        const open = await getDB().collection('option_positions').find({ status: 'open' }).toArray();
        const bySymbol = {};
        let totalExposure = 0;
        for (const p of open) {
            const value = (p.entryAsk || 0) * (p.positionSize || 1) * (p.size || 1000);
            bySymbol[p.underlying] = (bySymbol[p.underlying] || 0) + value;
            totalExposure += value;
        }
        const capital = s.TOTAL_CAPITAL || 0;
        res.json({ totalCapital: capital, riskPerTrade: capital * (s.RISK_PER_TRADE_PCT / 100), maxSymbolExposure: capital * (s.MAX_SYMBOL_EXPOSURE_PCT / 100), maxTotalExposure: capital * (s.MAX_TOTAL_EXPOSURE_PCT / 100), minCashReserve: capital * (s.MIN_CASH_RESERVE_PCT / 100), totalExposure, availableCash: capital - totalExposure, exposurePct: capital > 0 ? (totalExposure / capital * 100) : 0, openCount: open.length, bySymbol });
    } catch (e) { next(e); }
});

// ==================== Chart Aggregation ====================
function aggregateDailyForChart(rows, tf) {
    if (tf === '1d') return rows;
    const groups = new Map();
    for (const r of rows) {
        const d = new Date(r.time * 1000);
        let key;
        if (tf === '1w') {
            const day = d.getUTCDay();
            const daysFromSat = (day + 1) % 7;
            const sat = new Date(d.getTime() - daysFromSat * 86400000);
            key = sat.getUTCFullYear() + '-' + sat.getUTCMonth() + '-' + sat.getUTCDate();
        } else if (tf === '1M') {
            key = d.getUTCFullYear() + '-' + d.getUTCMonth();
        } else {
            key = '' + d.getUTCFullYear();
        }
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(r);
    }
    const result = [];
    for (const arr of groups.values()) {
        const first = arr[0], last = arr[arr.length - 1];
        result.push({
            time: first.time,
            open: first.open,
            high: Math.max.apply(null, arr.map(x => x.high)),
            low: Math.min.apply(null, arr.map(x => x.low)),
            close: last.close,
            volume: arr.reduce((s, x) => s + (x.volume || 0), 0)
        });
    }
    return result.sort((a, b) => a.time - b.time);
}

// ==================== Backtest Job Handlers ====================
async function computeStockBacktestTradesChunk(cfg, dateFrom, dateTo, onProgress) {
    const def = STRATEGIES[cfg.strategyId]; const htfTf = cfg.htfTimeframe || '1d';
    let candles = closedOnly(await getCandlesFull(cfg.symbol, cfg.timeframe), cfg.timeframe);
    let htf = closedOnly(await getCandlesFull(cfg.symbol, htfTf), htfTf);

    const WARMUP_SEC = 90 * 86400;
    if (dateFrom) {
        const fromWithWarmup = dateFrom - WARMUP_SEC;
        candles = candles.filter(c => c.time >= fromWithWarmup);
        htf = htf.filter(c => c.time >= fromWithWarmup);
    }
    if (dateTo) {
        candles = candles.filter(c => c.time <= dateTo);
        htf = htf.filter(c => c.time <= dateTo);
    }

    if (onProgress) onProgress({ phase: 'candles-loaded', candleCount: candles.length, htfCount: htf.length });

    const result = def.run(candles, { ...cfg.params, candleType: cfg.candleType }, { htfCandles: htf, htfTimeframe: htfTf, entryWindow: { start: ENTRY_START, end: ENTRY_END } });

    const signals = result.signals.filter(s => {
        if (dateFrom && s.time < dateFrom) return false;
        if (dateTo && s.time > dateTo) return false;
        return true;
    });

    const closeAt = new Map(candles.map((c, i) => [c.time, { close: c.close, i }]));
    const trades = []; let open = null;
    for (const s of signals) {
        const c = closeAt.get(s.time); if (!c) continue;
        if (s.signalType === 'BUY' && !open) open = { entryTime: s.time, entryPrice: c.close, entryIdx: c.i, reason: s.reason, status: 'open', signalInfo: s.indicators || {} };
        else if (s.signalType === 'EXIT_LONG' && open) {
            trades.push({ ...open, exitTime: s.time, exitPrice: c.close, pnlPct: (c.close / open.entryPrice - 1) * 100, bars: c.i - open.entryIdx, exitReason: s.reason, status: 'closed' });
            open = null;
        }
    }
    if (open) trades.push(open);
    return { trades, candles };
}

async function runBacktestJob(job) {
    const { configId, from, to, useRealOption, useOnlineData } = job.payload;
    const db = getDB();
    const cfg = await db.collection('strategy_configs').findOne({ _id: new ObjectId(configId) });
    if (!cfg) throw new Error('config یافت نشد');

    const dateFrom = from ? parseInt(from) : null;
    const dateTo = to ? parseInt(to) : null;
    const mode = useRealOption ? 'real' : 'hybrid';

    await BtService.updateProgress(job._id, 0, 100, 'شروع محاسبه');

    // Progressive fill: initially 100ms for first chunk, ~500ms-1s per chunk after
    const computeFn = async (c, f, t) => {
        const r = await computeStockBacktestTradesChunk(c, f, t, async (info) => {
            if (await BtService.isCancelled(job._id)) throw new Error('CANCELLED_BY_USER');
        });
        return r.trades.filter(x => x.status === 'closed');
    };

    // Check cancellation periodically via onProgress
    const result = await BtService.getOrComputeTrades(cfg, dateFrom, dateTo, mode, computeFn, async (info) => {
        if (await BtService.isCancelled(job._id)) throw new Error('CANCELLED_BY_USER');
        await BtService.updateProgress(job._id, 30, 100, `فاز: ${info.phase}`);
    });

    await BtService.updateProgress(job._id, 70, 100, `محاسبه آپشن روی ${result.trades.length} معامله`);

    if (await BtService.isCancelled(job._id)) throw new Error('CANCELLED_BY_USER');

    const optionResult = await Options.runHybridOptionBacktest(cfg.symbol, result.trades, { realEnabled: !!useRealOption });

    // Option backtest compute can be long; check cancel again after
    if (await BtService.isCancelled(job._id)) throw new Error('CANCELLED_BY_USER');

    await BtService.updateProgress(job._id, 100, 100, 'تکمیل');

    return {
        stockTradesCount: result.trades.length,
        stockClosedCount: result.trades.length,
        dateRange: { from: dateFrom, to: dateTo },
        cached: result.cached,
        reusedFromCache: result.reusedFromCache || 0,
        computedRanges: result.computedRanges || [],
        cacheSignature: result.signature,
        ...optionResult
    };
}

async function runAutoConfigJob(job) {
    const { symbols, maxConfirmers, from, to, dryRun } = job.payload;
    const fromTs = from ? parseInt(from) : null;
    const toTs = to ? parseInt(to) : null;

    const plans = [];
    const chunks = job.progress.chunks || [];

    for (let i = 0; i < symbols.length; i++) {
        if (await BtService.isCancelled(job._id)) throw new Error('CANCELLED_BY_USER');
        const sym = symbols[i];
        await BtService.updateChunk(job._id, i, { status: 'RUNNING', startedAt: new Date() });
        await BtService.updateProgress(job._id, i, symbols.length, `پردازش ${sym}`);

        try {
            const p = await autoConfigureSingle(sym, maxConfirmers || 2, fromTs, toTs, job._id);
            plans.push(p);
            await BtService.updateChunk(job._id, i, { status: 'DONE', finishedAt: new Date(), tradesCount: (p.leader && p.leader.stats && p.leader.stats.stock && p.leader.stats.stock.closed) || 0 });
        } catch (e) {
            if (String(e.message).includes('CANCELLED_BY_USER')) throw e;
            plans.push({ symbol: sym, error: e.message });
            await BtService.updateChunk(job._id, i, { status: 'FAILED', finishedAt: new Date(), error: e.message });
        }
        // Yield to event loop
        await new Promise(r => setImmediate(r));
    }

    await BtService.updateProgress(job._id, symbols.length, symbols.length, 'اعمال');

    if (dryRun) return { plans, applied: false };

    const db = getDB();
    const applied = [];
    for (const p of plans) {
        if (p.error || !p.leader) {
            applied.push({ symbol: p.symbol, error: p.error || 'بدون leader', rejectionReasons: p.rejectionReasons });
            continue;
        }
        const old = await db.collection('strategy_configs').find({ symbol: p.symbol }).toArray();
        const oldIds = old.map(o => o._id.toString());
        await db.collection('strategy_configs').deleteMany({ symbol: p.symbol });
        await db.collection('signals_state').deleteMany({ configId: { $in: oldIds } });
        await BtService.invalidateCacheForConfig(oldIds).catch(() => {});

        const leaderDoc = {
            symbol: p.symbol, strategyId: p.leader.strategyId, timeframe: p.leader.timeframe,
            htfTimeframe: p.leader.htfTimeframe, candleType: 'heikin',
            params: { ...STRATEGIES[p.leader.strategyId].defaultParams, ...Settings.getStrategyDefaults(p.leader.strategyId) },
            enabled: true, role: 'leader', autoConfigured: true, createdAt: new Date()
        };
        const r1 = await db.collection('strategy_configs').insertOne(leaderDoc);
        const created = [r1.insertedId.toString()];
        for (const c of p.confirmers) {
            const cDoc = {
                symbol: p.symbol, strategyId: c.strategyId, timeframe: c.timeframe,
                htfTimeframe: c.htfTimeframe, candleType: 'heikin',
                params: { ...STRATEGIES[c.strategyId].defaultParams, ...Settings.getStrategyDefaults(c.strategyId) },
                enabled: true, role: 'confirmer', autoConfigured: true, createdAt: new Date()
            };
            const r2 = await db.collection('strategy_configs').insertOne(cDoc);
            created.push(r2.insertedId.toString());
        }
        applied.push({
            symbol: p.symbol, leader: p.leader.strategyId, leaderName: p.leader.strategyName,
            leaderScore: p.leader.score,
            confirmers: p.confirmers.map(c => ({ id: c.strategyId, name: c.strategyName, score: c.score })),
            created: created.length
        });
    }

    await notify(`تنظیم خودکار انجام شد\n${applied.filter(a => !a.error).map(a => `- ${a.symbol}: لیدر ${a.leaderName}`).join('\n')}`).catch(() => {});
    return { plans, applied: true, results: applied };
}

// ==================== Auto Configure ====================
function scoreStrategyForAuto(res) {
    if (!res || res.error || res.insufficientData) return -Infinity;
    const s = res.stock || {};
    const o = res.option || {};
    const tradeCount = s.closed || 0;
    if (tradeCount < 7) return -Infinity;
    const optCount = o.count || 0;
    if (optCount < 3) return -Infinity;
    const optPF = (o.profitFactor !== null && o.profitFactor !== undefined && isFinite(o.profitFactor)) ? o.profitFactor : 0;
    if (optPF < 1.1) return -Infinity;
    const winRate = (s.winRate || 0) / 100;
    const optAvg = o.avgPnl || 0;
    let score = optPF * 0.4 + winRate * 0.3 + Math.min(tradeCount, 20) / 20 * 0.1 + Math.max(-1, Math.min(2, optAvg / 50)) * 0.2;
    if (tradeCount >= 20) score *= 1.2;
    return score;
}

async function autoConfigureSingle(symbol, maxConfirmers, dateFrom, dateTo, jobId) {
    const db = getDB();
    const monitored = await db.collection('monitored_symbols').findOne({ symbol });
    if (!monitored) return { symbol, error: 'نماد در لیست پایش نیست' };

    const strategies = Object.values(STRATEGIES).filter(s => s.id !== 'ensemble');
    const results = [];

    for (const def of strategies) {
        if (jobId && await BtService.isCancelled(jobId)) throw new Error('CANCELLED_BY_USER');
        const cfg = { symbol, strategyId: def.id, timeframe: def.defaultTimeframe, htfTimeframe: def.htfTimeframe || '1d', candleType: 'heikin', params: { ...def.defaultParams, ...Settings.getStrategyDefaults(def.id) } };
        try {
            const tf = cfg.timeframe, htf = cfg.htfTimeframe;
            let closedCandles = closedOnly(await getCandles(symbol, tf), tf);
            let closedHtf = closedOnly(await getCandles(symbol, htf), htf);
            if (dateFrom) { closedCandles = closedCandles.filter(c => c.time >= dateFrom); closedHtf = closedHtf.filter(c => c.time >= dateFrom); }
            if (dateTo) { closedCandles = closedCandles.filter(c => c.time <= dateTo); closedHtf = closedHtf.filter(c => c.time <= dateTo); }

            const required = getRequiredCandles(cfg.strategyId, cfg.params);
            const requiredHtf = Strat.getRequiredHtfCandles ? Strat.getRequiredHtfCandles(cfg.strategyId, cfg.params) : 0;

            const MIN_CANDLES = Math.max(5, Math.floor(required * 0.3));
            const MIN_HTF = Math.max(3, Math.floor(requiredHtf * 0.3));
            if (closedCandles.length < MIN_CANDLES || closedHtf.length < MIN_HTF) {
                results.push({ strategyId: def.id, strategyName: def.name, timeframe: cfg.timeframe, error: `داده ناکافی (${closedCandles.length}/${required})`, insufficientData: true, score: -Infinity });
                continue;
            }

            const dataWarning = (closedCandles.length < required || closedHtf.length < requiredHtf)
                ? `داده محدود (${closedCandles.length}/${required} ورودی، ${closedHtf.length}/${requiredHtf} روند)`
                : null;

            const computeFn = async (c, f, t) => {
                const r = await computeStockBacktestTradesChunk(c, f, t);
                return r.trades.filter(x => x.status === 'closed');
            };

            const tradeRes = await BtService.getOrComputeTrades(cfg, dateFrom, dateTo, 'hybrid', computeFn, null);
            const closedTrades = tradeRes.trades;
            const stockWins = closedTrades.filter(t => t.pnlPct > 0);
            const stockSum = closedTrades.reduce((acc, t) => acc + t.pnlPct, 0);
            const h = await Options.runHybridOptionBacktest(symbol, closedTrades, { realEnabled: true });

            const r = {
                strategyId: def.id, strategyName: def.name, timeframe: cfg.timeframe, htfTimeframe: cfg.htfTimeframe,
                stock: { total: closedTrades.length, closed: closedTrades.length, winRate: closedTrades.length ? stockWins.length / closedTrades.length * 100 : 0, avgPnl: closedTrades.length ? stockSum / closedTrades.length : 0, totalPnl: stockSum },
                option: { ...h.stats, realUsed: h.realUsed, approxUsed: h.approxUsed, diagnostic: h.diagnostic },
                warning: dataWarning
            };
            r.score = scoreStrategyForAuto(r);
            results.push(r);
        } catch (e) {
            if (String(e.message).includes('CANCELLED_BY_USER')) throw e;
            results.push({ strategyId: def.id, strategyName: def.name, error: e.message, score: -Infinity });
        }
        await new Promise(r => setImmediate(r));
    }

    const valid = results.filter(r => isFinite(r.score) && r.score > -Infinity).sort((a, b) => b.score - a.score);
    if (!valid.length) {
        const rejectionReasons = results.map(r => {
            const reasons = [];
            if (r.insufficientData) reasons.push('داده ناکافی');
            else if (r.error) reasons.push(r.error);
            else {
                const s = r.stock || {}, o = r.option || {};
                if ((s.closed || 0) < 7) reasons.push(`معامله سهم ${s.closed || 0} < 7`);
                else if ((o.count || 0) < 3) reasons.push(`معامله آپشن ${o.count || 0} < 3`);
                else if ((o.profitFactor || 0) < 1.1) reasons.push(`PF ${(o.profitFactor || 0).toFixed(2)} < 1.1`);
            }
            return { strategyId: r.strategyId, strategyName: r.strategyName, reasons };
        });
        return { symbol, error: 'هیچ استراتژی معتبری پیدا نشد (معیار: 7 معامله سهم + 3 معامله آپشن + PF>1.1)', results, rejectionReasons };
    }

    const leader = valid[0];
    const confirmers = valid.slice(1, 1 + maxConfirmers);
    return {
        symbol,
        leader: { strategyId: leader.strategyId, strategyName: leader.strategyName, timeframe: leader.timeframe, htfTimeframe: leader.htfTimeframe, score: Math.round(leader.score * 100) / 100, stats: leader },
        confirmers: confirmers.map(c => ({ strategyId: c.strategyId, strategyName: c.strategyName, timeframe: c.timeframe, htfTimeframe: c.htfTimeframe, score: Math.round(c.score * 100) / 100, stats: c })),
        allResults: valid.map(v => ({ strategyId: v.strategyId, strategyName: v.strategyName, score: Math.round(v.score * 100) / 100, trades: v.stock.closed, winRate: v.stock.winRate, optTrades: v.option.count, optAvg: v.option.avgPnl, optPF: v.option.profitFactor })),
        rejected: results.filter(r => !isFinite(r.score) || r.score === -Infinity).map(r => ({ strategyId: r.strategyId, strategyName: r.strategyName, reason: r.insufficientData ? 'داده ناکافی' : (r.error || `سهم ${r.stock?.closed || 0} / آپشن ${r.option?.count || 0} / PF ${(r.option?.profitFactor || 0).toFixed(2)}`) }))
    };
}

app.post('/api/auto-configure', async (req, res, next) => {
    try {
        const { symbol, symbols, maxConfirmers = 2, dryRun = false, dateFrom, dateTo } = req.body || {};
        let targetSymbols = [];
        if (symbol) targetSymbols = [symbol];
        else if (Array.isArray(symbols)) targetSymbols = symbols;
        if (!targetSymbols.length) return res.status(400).json({ error: 'حداقل یک نماد انتخاب کنید' });

        const fromTs = dateFrom ? parseInt(dateFrom) : null;
        const toTs = dateTo ? parseInt(dateTo) : null;

        const plans = [];
        for (const sym of targetSymbols) plans.push(await autoConfigureSingle(sym, maxConfirmers, fromTs, toTs, null));

        if (dryRun) return res.json({ plans, applied: false });

        const db = getDB();
        const applied = [];
        for (const p of plans) {
            if (p.error || !p.leader) { applied.push({ symbol: p.symbol, error: p.error || 'بدون leader', rejectionReasons: p.rejectionReasons }); continue; }
            const old = await db.collection('strategy_configs').find({ symbol: p.symbol }).toArray();
            const oldIds = old.map(o => o._id.toString());
            await db.collection('strategy_configs').deleteMany({ symbol: p.symbol });
            await db.collection('signals_state').deleteMany({ configId: { $in: oldIds } });
            await BtService.invalidateCacheForConfig(oldIds).catch(() => {});

            const leaderDoc = { symbol: p.symbol, strategyId: p.leader.strategyId, timeframe: p.leader.timeframe, htfTimeframe: p.leader.htfTimeframe, candleType: 'heikin', params: { ...STRATEGIES[p.leader.strategyId].defaultParams, ...Settings.getStrategyDefaults(p.leader.strategyId) }, enabled: true, role: 'leader', autoConfigured: true, createdAt: new Date() };
            const r1 = await db.collection('strategy_configs').insertOne(leaderDoc);
            const created = [r1.insertedId.toString()];
            for (const c of p.confirmers) {
                const cDoc = { symbol: p.symbol, strategyId: c.strategyId, timeframe: c.timeframe, htfTimeframe: c.htfTimeframe, candleType: 'heikin', params: { ...STRATEGIES[c.strategyId].defaultParams, ...Settings.getStrategyDefaults(c.strategyId) }, enabled: true, role: 'confirmer', autoConfigured: true, createdAt: new Date() };
                const r2 = await db.collection('strategy_configs').insertOne(cDoc);
                created.push(r2.insertedId.toString());
            }
            applied.push({ symbol: p.symbol, leader: p.leader.strategyId, leaderName: p.leader.strategyName, leaderScore: p.leader.score, confirmers: p.confirmers.map(c => ({ id: c.strategyId, name: c.strategyName, score: c.score })), created: created.length });
        }

        await notify(`تنظیم خودکار انجام شد\n${applied.filter(a => !a.error).map(a => `- ${a.symbol}: لیدر ${a.leaderName} (${a.leaderScore}) + ${a.confirmers.length} تاییدکننده`).join('\n')}`).catch(() => {});
        res.json({ plans, applied: true, results: applied });
    } catch (e) { next(e); }
});

app.post('/api/auto-configure/preview', async (req, res, next) => {
    try {
        const { symbol, symbols, maxConfirmers = 2, dateFrom, dateTo } = req.body || {};
        let targetSymbols = [];
        if (symbol) targetSymbols = [symbol];
        else if (Array.isArray(symbols)) targetSymbols = symbols;
        if (!targetSymbols.length) return res.status(400).json({ error: 'حداقل یک نماد' });

        const fromTs = dateFrom ? parseInt(dateFrom) : null;
        const toTs = dateTo ? parseInt(dateTo) : null;

        const plans = [];
        for (const sym of targetSymbols) plans.push(await autoConfigureSingle(sym, maxConfirmers, fromTs, toTs, null));
        res.json({ plans });
    } catch (e) { next(e); }
});

// ==================== Strategy Evaluation (Signal Engine) ====================
async function evaluateStrategyConfig(config, marketInfo) {
    const def = STRATEGIES[config.strategyId]; if (!def) return;
    const isConfirmer = config.role === 'confirmer';
    const db = getDB(), stateColl = db.collection('signals_state'), configId = config._id.toString();
    const htfTf = config.htfTimeframe || def.htfTimeframe || '1d';
    const candles = closedOnly(await getCandles(config.symbol, config.timeframe), config.timeframe);
    const htfCandles = closedOnly(await getCandles(config.symbol, htfTf), htfTf);
    const required = getRequiredCandles(config.strategyId, config.params);
    const requiredHtf = Strat.getRequiredHtfCandles ? Strat.getRequiredHtfCandles(config.strategyId, config.params) : 0;
    const info = marketInfo && marketInfo.get(config.symbol);
    const base = { configId, symbol: config.symbol, strategyId: config.strategyId, timeframe: config.timeframe, htfTimeframe: htfTf, candleCount: candles.length, requiredCandles: required, htfCandleCount: htfCandles.length, requiredHtfCandles: requiredHtf, updatedAt: new Date(), queue: info ? info.queue : null, livePrice: info ? info.price : null };

    if (candles.length < required || htfCandles.length < requiredHtf) {
        await stateColl.updateOne({ configId }, { $set: { ...base, insufficientData: true, position: null } }, { upsert: true }); return;
    }
    let result;
    try { result = def.run(candles, { ...config.params, candleType: config.candleType }, { htfCandles, htfTimeframe: htfTf, entryWindow: { start: ENTRY_START, end: ENTRY_END } }); }
    catch (e) { console.error(`استراتژی ${config.symbol}:`, e.message); return; }
    const prev = await stateColl.findOne({ configId });
    const latest = result.signals[result.signals.length - 1]; if (!latest) return;

    if (!prev) {
        await stateColl.updateOne({ configId }, { $set: {
            ...base, insufficientData: false,
            position: latest.position, indicators: latest.indicators,
            price: candles[candles.length - 1].close,
            lastCandleTime: latest.time,
            htfTrend: result.htfTrend || null,
            reason: latest.reason || null,
            lastNotifiedTime: latest.time,
            lastNotifiedType: latest.signalType || null,
            warmup: true
        }}, { upsert: true });
        console.log(`warm-up: ${config.symbol} | ${config.strategyId} | position=${latest.position}`);
        return;
    }

    const prevNotified = prev.lastNotifiedTime || 0;
    let last = latest;
    for (let i = result.signals.length - 1, k = 0; i >= 0 && k < 5; i--, k--) {
        const s = result.signals[i];
        if ((s.signalType === 'BUY' || s.signalType === 'EXIT_LONG') && s.time > prevNotified) { last = s; break; }
    }
    const late = last !== latest;
    const lastPrice = candles[candles.length - 1].close;
    await stateColl.updateOne({ configId }, { $set: { ...base, insufficientData: false, position: latest.position, indicators: latest.indicators, price: lastPrice, lastCandleTime: latest.time, htfTrend: result.htfTrend || null, reason: latest.reason || null } }, { upsert: true });
    const label = `${config.symbol} | ${def.name} | ${config.timeframe} -> ${htfTf}`;
    const lastHa = result.ha.find(h => h.time === last.time);

    const tfMin = TF[config.timeframe] || 30;
    const isFormingNow = lastHa && (lastHa.time + tfMin * 60) > (Date.now() / 1000);
    const isIncomplete = isFormingNow && !!(lastHa && lastHa.complete === false);
    const incompleteTag = isIncomplete ? '\nکندل در حال تشکیل' : '';

    if (prev && prev.position === 'LONG' && latest.position !== 'LONG' && last.signalType !== 'EXIT_LONG') {
        if (!isConfirmer) { await notify(`لغو سیگنال\n${label}\nموقعیت خرید قبلی وجود ندارد.`); await bumpDayStat('cancels'); }
    }
    const actionable = last.signalType === 'BUY' || last.signalType === 'EXIT_LONG';
    const already = prev && prev.lastNotifiedTime === last.time && prev.lastNotifiedType === last.signalType;
    if (!actionable || already) return;

    const signalT = getTehranParts(new Date(last.time * 1000));
    const signalMin = signalT.hour * 60 + signalT.minute;
    const inWindow = signalMin >= ENTRY_START && signalMin <= ENTRY_END;

    const queueTag = info && info.queue === 'buy' ? '\nصف خرید' : info && info.queue === 'sell' ? '\nصف فروش' : '';
    const windowTag = last.signalType === 'BUY' && !inWindow ? `\nخارج از بازه` : '';

    let confluence = 1, confirmersList = [];
    if (last.signalType === 'BUY') {
        try {
            const otherConfigs = await db.collection('strategy_configs').find({ symbol: config.symbol, _id: { $ne: config._id }, enabled: true }).toArray();
            const otherIds = otherConfigs.map(oc => oc._id.toString());
            const otherStates = await stateColl.find({ configId: { $in: otherIds } }).toArray();
            const stateMap = new Map(otherStates.map(s => [s.configId, s]));
            const timeWindowSec = Settings.confluenceTimeWindow();
            const nowSec = Math.floor(Date.now() / 1000);
            for (const oc of otherConfigs) {
                const ost = stateMap.get(oc._id.toString());
                if (!ost || ost.position !== 'LONG') continue;
                if (timeWindowSec > 0) { const diff = Math.abs(nowSec - (ost.updatedAt ? Math.floor(new Date(ost.updatedAt).getTime() / 1000) : 0)); if (diff > timeWindowSec) continue; }
                confluence++;
                if (oc.role === 'confirmer') { const cfDef = STRATEGIES[oc.strategyId]; confirmersList.push(cfDef ? cfDef.name : oc.strategyId); }
            }
        } catch (e) {}
    }
    const confluenceTag = confluence > 1 ? `\nهم گرایی ${confluence} استراتژی` : '';
    const confirmersTag = confirmersList.length ? `\nتایید: ${confirmersList.join('، ')}` : '';

    await stateColl.updateOne({ configId }, { $set: { lastNotifiedTime: last.time, lastNotifiedType: last.signalType } });

    let shouldNotifyConfirmer = false;
    if (isConfirmer && last.signalType === 'BUY' && confirmersList.length >= Settings.multiConfirmerMin()) shouldNotifyConfirmer = true;

    if (isConfirmer && !shouldNotifyConfirmer) {
        await db.collection('signal_history').insertOne({ configId, symbol: config.symbol, strategyId: config.strategyId, strategyName: def.name, timeframe: config.timeframe, signalType: last.signalType, price: lastPrice, time: last.time, reason: last.reason || null, htfTrend: result.htfTrend || null, inWindow, queue: info ? info.queue : null, incomplete: isIncomplete, confluence, role: 'confirmer', createdAt: new Date() });
        return;
    }

    let title;
    if (isConfirmer) title = `سیگنال چند-تاییدکننده (${confirmersList.length} تایید)`;
    else title = (last.signalType === 'BUY' ? 'سیگنال خرید (کال)' : 'خروج از خرید (بستن کال)') + (late ? ' (تاخیری)' : '');
    const roleTag = isConfirmer ? '[چند-تایید]' : '[لیدر]';
    const text = `${title}\n${label} ${roleTag}\nروند ${htfTf}: ${result.htfTrend || '-'}\nقیمت: ${lastPrice.toLocaleString()}${info ? ` | لحظه ای: ${info.price.toLocaleString()}` : ''}\nدلیل: ${last.reason || '-'}${confluenceTag}${confirmersTag}${queueTag}${windowTag}${incompleteTag}`;
    await notify(text);
    await db.collection('signal_history').insertOne({ configId, symbol: config.symbol, strategyId: config.strategyId, strategyName: def.name, timeframe: config.timeframe, signalType: last.signalType, price: lastPrice, time: last.time, reason: last.reason || null, htfTrend: result.htfTrend || null, inWindow, queue: info ? info.queue : null, incomplete: isIncomplete, confluence, role: isConfirmer ? 'multi-confirmer' : 'leader', confirmers: confirmersList, createdAt: new Date() });
    await bumpDayStat('signals');

    if (last.signalType === 'BUY') {
        if (!inWindow || (info && info.queue === 'buy')) { await notify(`${config.symbol}: به دلیل ${!inWindow ? 'خارج از بازه' : 'صف خرید'} آپشن پیشنهاد نشد.`); return; }
        const stop = last.indicators && last.indicators.stop, atr = last.indicators && last.indicators.atr;
        const risk = stop && stop < lastPrice ? lastPrice - stop : (atr ? 2 * atr : lastPrice * 0.03);
        const targetPct = (risk * 3.0 / lastPrice) * 100;
        const minTarget = Settings.minTargetPct();
        if (targetPct < minTarget) { await notify(`${config.symbol}: هدف سهم فقط ${targetPct.toFixed(1)}% - کمتر از حداقل ${minTarget}%.`); return; }
        try { await Options.onBuySignal({ config, indicators: last.indicators, price: lastPrice, liveS: info ? info.price : null, tradeId: null, confluence, confirmers: confirmersList }); }
        catch (e) { console.error('انتخاب آپشن:', e.message); await notify(`انتخاب قرارداد ${config.symbol} ناموفق: ${e.message}`); }
    }
}
async function evaluateAll(marketInfo) {
    const configs = await getDB().collection('strategy_configs').find({ enabled: true }).toArray();
    const leaders = configs.filter(c => c.role !== 'confirmer');
    const confirmers = configs.filter(c => c.role === 'confirmer');
    for (const c of confirmers) await evaluateStrategyConfig(c, marketInfo);
    for (const c of leaders) await evaluateStrategyConfig(c, marketInfo);
    return configs.length;
}

// ==================== Tick ====================
const lastSnap = new Map(); let tickRunning = false;
async function tick() {
    if (tickRunning) return; tickRunning = true;
    try {
        const db = getDB();
        const monitored = await db.collection('monitored_symbols').find({}).toArray();
        if (!monitored.length) return;
        const tehran = getTehranParts();
        const bucket1 = getBucketTime(tehran, 1), dayTime = dayStartUTC(tehran);
        let raw; try { raw = await fetchAllSymbolsRaw(); rawSymbolsCache = { at: Date.now(), data: raw }; } catch (e) { await recordTickFailure(e.message); return; }
        await updateSymbolsCacheFromRaw(raw);
        const active = raw.filter(s => +s.tno > 0).length;
        if (minuteOfDay(tehran) >= SESSION_START + 10) { if (active < 20) { if (++inactiveTicks >= 12) { await markHoliday(tehran); return; } } else inactiveTicks = 0; }
        const rawMap = new Map(); raw.forEach(s => { if (s.l18) rawMap.set(s.l18, s); });
        const marketInfo = new Map();
        for (const m of monitored) {
            const s = rawMap.get(m.symbol); if (!s) continue;
            const price = +s.pl; if (!price) continue;
            const tno = +s.tno || 0, tvol = +s.tvol || 0, tmax = +s.tmax || 0, tmin = +s.tmin || 0;
            const atUpper = tmax > 0 && price >= tmax, atLower = tmin > 0 && price <= tmin;
            const prev = lastSnap.get(m.symbol);
            const traded = !prev || tno !== prev.tno;
            const volDelta = prev && tvol >= prev.tvol ? tvol - prev.tvol : 0;
            lastSnap.set(m.symbol, { tno, tvol });
            marketInfo.set(m.symbol, { price, queue: atUpper ? 'buy' : atLower ? 'sell' : null });
            lastQuotes.set(m.symbol, { price, queue: atUpper ? 'buy' : atLower ? 'sell' : null, at: new Date() });
            if (!traded && !atUpper && !atLower) continue;
            await upsertLiveCandle(m.symbol, bucket1, price, volDelta);
            await upsertDailyCandle(m.symbol, dayTime, s);
        }
        const n = await evaluateAll(marketInfo);
        try {
            const openOpt = await Options.openPositionsCount();
            if (tehran.minute % 5 === 0 || openOpt > 0) {
                const chain = await Options.fetchChain(30000);
                const mset = new Set(monitored.map(m => Options.norm(m.symbol)));
                if (tehran.minute % 5 === 0) { await Options.storeSnapshots(chain, mset); await Options.storeFullOptionHistory(chain, mset); }
                await Options.managePositions(chain);
            }
        } catch (e) { console.error('آپشن:', e.message); }
        await flushOutbox();
        await recordTickSuccess();
        console.log(`${tehran.hour}:${String(tehran.minute).padStart(2, '0')} | ${monitored.length} نماد | ${n} استراتژی | فعال: ${active}`);
    } catch (e) { await recordTickFailure(e.message); }
    finally { tickRunning = false; }
}
app.post('/api/evaluate-now', async (req, res, next) => { try { await tick(); res.json({ success: true, lastTickAt: health.lastTickAt, lastError: health.lastError, consecutiveFailures: health.consecutiveFailures }); } catch (e) { next(e); } });

// ==================== Root ====================
app.get('/', async (req, res) => {
    let pendingOutbox = 0;
    try { pendingOutbox = await getDB().collection('telegram_outbox').countDocuments({ sentAt: null, attempts: { $lt: 120 }, createdAt: { $lt: new Date(Date.now() - 120000) } }); } catch (e) {}
    const t = getTehranParts();
    res.json({ status: 'ok', version: SERVER_VERSION, startedAt: STARTED_AT, commit: process.env.RENDER_GIT_COMMIT || null, apiKeysConfigured: API_KEYS.length, adminRequired: !!ADMIN_TOKEN, telegramConfigured: !!(TELEGRAM_TOKEN && TELEGRAM_CHAT_ID), symbolsCached: symbolsCache.length, marketOpenNow: isMarketOpen(t), holidayToday: holidayDate === todayDateString(t), entryWindow: `${fmtMin(ENTRY_START)}-${fmtMin(ENTRY_END)}`, health: { ...health }, pendingOutbox });
});
app.get('/api/logs', async (req, res, next) => {
    try {
        if (ADMIN_TOKEN && req.headers['x-admin-token'] !== ADMIN_TOKEN) return res.status(401).json({ error: 'توکن ادمین نامعتبر' });
        const limit = Math.min(+req.query.limit || 200, 1000);
        if (req.query.source === 'db') return res.json({ logs: await getDB().collection('logs').find({}).sort({ at: -1 }).limit(limit).toArray() });
        res.json({ logs: Log.recent(limit, req.query.level || undefined) });
    } catch (e) { next(e); }
});

// ==================== Register External Routes ====================
Options.registerRoutes(app, ObjectId);
BtService.registerRoutes(app);

app.use((req, res) => { Log.push('warn', `404 ${req.method} ${req.originalUrl}`); res.status(404).json({ error: 'مسیر یافت نشد' }); });
app.use((err, req, res, next) => { console.error('خطا:', err.message); res.status(500).json({ error: err.message || 'خطای داخلی' }); });

// ==================== Startup ====================
async function ensureIndexes() {
    const db = getDB();
    await db.collection('candles_daily').createIndex({ symbol: 1, time: 1 }, { unique: true });
    await db.collection('telegram_outbox').createIndex({ sentAt: 1, createdAt: 1 });
    try { await db.collection('telegram_outbox').dropIndex('sentAt_1'); } catch (e) {}
    try { await db.collection('telegram_outbox').dropIndex('createdAt_1'); } catch (e) {}
    await db.collection('backtest_jobs').createIndex({ status: 1, createdAt: 1 });
    await db.collection('backtest_jobs').createIndex({ createdAt: -1 });
    await db.collection('backtest_trade_cache').createIndex({ computedAt: 1 });
    await Log.ensureIndexes(db);
}

async function cleanOrphanConfigs() {
    const db = getDB();
    const validIds = Object.keys(STRATEGIES);
    const orphans = await db.collection('strategy_configs').find({ strategyId: { $nin: validIds } }).toArray();
    if (orphans.length) {
        console.log(`حذف ${orphans.length} کانفیگ یتیم:`, orphans.map(o => `${o.symbol}/${o.strategyId}`).join(', '));
        await db.collection('strategy_configs').deleteMany({ _id: { $in: orphans.map(o => o._id) } });
        await db.collection('signals_state').deleteMany({ configId: { $in: orphans.map(o => o._id.toString()) } });
    }
}

// Resume stuck jobs on startup (mark RUNNING as QUEUED so they get re-processed)
async function resumeStuckJobs() {
    const db = getDB();
    const r = await db.collection('backtest_jobs').updateMany(
        { status: 'RUNNING' },
        { $set: { status: 'QUEUED', updatedAt: new Date(), 'progress.message': 'ادامه پس از ری استارت سرور' } }
    );
    if (r.modifiedCount) console.log(`از سرگیری ${r.modifiedCount} job نیمه کاره`);
}

async function reloadEntryWindow() { const w = Settings.entryWindow(); ENTRY_START = w.start; ENTRY_END = w.end; }

async function start() {
    await connectDB();
    Log.init(getDB);
    Settings.init({ getDB });
    await Settings.load();
    await reloadEntryWindow();
    if (typeof Options.reloadFromSettings === 'function') Options.reloadFromSettings();
    await ensureIndexes();

    BtService.init({ getDB, runBacktestJob, runAutoConfigJob });
    Options.init({
        getDB, notify,
        TIMEFRAME_MINUTES: Strat.TIMEFRAME_MINUTES,
        todayDateString: () => todayDateString(getTehranParts()),
        archiveStats: async () => [],
        getQuote: (sym) => lastQuotes.get(sym)
    });
    await Options.ensureIndexes();
    await cleanOrphanConfigs();
    await resumeStuckJobs();

    const hol = await getDB().collection('meta').findOne({ _id: 'holiday' }); if (hol) holidayDate = hol.date;
    if (!await loadSymbolsCacheFromDB()) { try { await updateSymbolsCacheFromRaw(await fetchAllSymbolsRaw()); } catch (e) { console.error('کش نمادها:', e.message); } }
    if (!ADMIN_TOKEN) console.warn('ADMIN_TOKEN تنظیم نشده.');

    // Process queue at startup (in case of resumed jobs)
    BtService.processQueue().catch(e => console.error('queue:', e.message));

    cron.schedule('* * * * *', async () => {
        const t = getTehranParts();
        flushOutbox().catch(() => {});
        if (!isMarketOpen(t)) return;
        if (holidayDate === todayDateString(t)) {
            if (t.minute % 5 !== 0) return;
            try { const raw = await fetchAllSymbolsRaw(); if (raw.filter(s => +s.tno > 0).length >= 20) { holidayDate = null; inactiveTicks = 0; await getDB().collection('meta').deleteOne({ _id: 'holiday' }); await notify('بازار فعال شد.'); } else return; }
            catch (e) { return; }
        }
        await tick();
    });

    cron.schedule('32 12 * * 6,0,1,2,3', async () => {
        if (holidayDate === todayDateString(getTehranParts())) return;
        try {
            await evaluateAll(null);
            const monitored = await getDB().collection('monitored_symbols').find({}).toArray();
            const mset = new Set(monitored.map(m => Options.norm(m.symbol)));
            const chain = await Options.fetchChain(0);
            await Options.storeEOD(chain, mset);
            await Options.managePositions(chain);
            await flushOutbox();
        } catch (e) { console.error('EOD:', e.message); }
    }, { timezone: 'Asia/Tehran' });

    cron.schedule('35 12 * * 6,0,1,2,3', () => { if (holidayDate !== todayDateString(getTehranParts())) sendDailySummary().catch(() => {}); }, { timezone: 'Asia/Tehran' });
    cron.schedule('0 10 * * 4', () => { sendWeeklyBackup().catch(e => console.error('بکاپ:', e.message)); }, { timezone: 'Asia/Tehran' });

    // AlgoTik snapshot during market
    cron.schedule('5,35 9-12 * * 6,0,1,2,3', async () => {
        try {
            if (holidayDate === todayDateString(getTehranParts())) return;
            const online = await AlgotikClient.isOnline();
            if (!online) return;
            const symbols = (await getDB().collection('monitored_symbols').find({ collectEnabled: { $ne: false } }).toArray()).map(s => s.symbol);
            if (!symbols.length) return;
            const r = await AlgotikClient.fetchOptions(symbols);
            console.log(`AlgoTik snapshot: ${r.total_contracts || 0} قرارداد`);
        } catch (e) { console.error('Cron AlgoTik Options:', e.message); }
    }, { timezone: 'Asia/Tehran' });

    cron.schedule('5 13 * * 6,0,1,2,3', async () => {
        try {
            if (holidayDate === todayDateString(getTehranParts())) return;
            const online = await AlgotikClient.isOnline();
            if (!online) return;
            const symbols = (await getDB().collection('monitored_symbols').find({ collectEnabled: { $ne: false } }).toArray()).map(s => s.symbol);
            if (!symbols.length) return;
            const r = await AlgotikClient.fetchOptionsDaily(symbols);
            console.log(`AlgoTik daily: ${r.total_saved || 0} رکورد`);
        } catch (e) { console.error('Cron AlgoTik Daily:', e.message); }
    }, { timezone: 'Asia/Tehran' });

    // Auto-clear old finished jobs (daily)
    cron.schedule('0 3 * * *', async () => {
        try {
            const cutoff = new Date(Date.now() - 7 * 86400 * 1000);
            const r = await getDB().collection('backtest_jobs').deleteMany({
                status: { $in: ['DONE', 'FAILED', 'CANCELLED'] },
                finishedAt: { $lt: cutoff }
            });
            if (r.deletedCount) console.log(`پاکسازی ${r.deletedCount} job قدیمی`);
        } catch (e) { console.error('cleanup jobs:', e.message); }
    }, { timezone: 'Asia/Tehran' });

    const server = app.listen(PORT, HOST, () => console.log(`${SERVER_VERSION} | port ${PORT} | host ${HOST} | keys ${API_KEYS.length}`));
    server.keepAliveTimeout = 10 * 60 * 1000;
    server.headersTimeout = 11 * 60 * 1000;
    server.requestTimeout = 10 * 60 * 1000;

    notify(`سرور ری استارت شد (${SERVER_VERSION})`).catch(() => {});
}
start().catch(e => { console.error('راه اندازی:', e); process.exit(1); });