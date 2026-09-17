'use strict';
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');
const cron = require('node-cron');
const { ObjectId } = require('mongodb');
const { connectDB, getDB } = require('./db');
const Strat = require('./strategies.js');
const { STRATEGIES, aggregateCandles, getRequiredCandles } = Strat;
const Options = require('./option.js');
const Tsetmc = require('./tsetmc.js');
const Log = require('./log.js');
const Settings = require('./settings.js');
Log.patchConsole();
const STARTED_AT = new Date();

const app = express();
app.disable('x-powered-by');
const PORT = process.env.PORT || 3000;
const SERVER_VERSION = 'v9.1-inWindow-fix';
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
const SESSION_START = 9 * 60, SESSION_END = 12 * 60 + 30;
const toMin = s => { const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0); };
const fmtMin = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

let ENTRY_START = toMin(process.env.ENTRY_START || '09:30');
let ENTRY_END = toMin(process.env.ENTRY_END || '12:00');

app.use(cors());
app.use(express.json({ limit: '5mb' }));

app.use((req, res, next) => {
    if (req.path.startsWith('/api/backtest') || req.path.startsWith('/api/auto-configure')) {
        req.setTimeout(10 * 60 * 1000);
        res.setTimeout(10 * 60 * 1000);
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

app.get('/api/trading-settings', async (req, res, next) => { try { res.json({ values: Settings.get(), defaults: Settings.DEFAULTS }); } catch (e) { next(e); } });
app.put('/api/trading-settings', async (req, res, next) => {
    try { await Settings.save(req.body || {}); await reloadEntryWindow(); if (typeof Options.reloadFromSettings === 'function') Options.reloadFromSettings(); res.json({ success: true, values: Settings.get() }); }
    catch (e) { res.status(400).json({ error: e.message }); }
});

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

let symbolsCache = [];
async function fetchAllSymbolsRaw() {
    if (!API_KEYS.length) throw new Error('هیچ کلید BrsApi تنظیم نشده است.');
    const picked = await acquireApiKey();
    if (!picked) throw new Error('سهمیه‌ی روزانه‌ی همه‌ی کلیدها تمام شده است.');
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
    } catch (e) { console.error('❌ refreshSymbolData:', e.message); return false; }
}

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
            catch (e) { await col.updateOne({ _id: p._id }, { $inc: { attempts: 1 }, $set: { lastError: e.message } }); console.error('❌ تلگرام:', e.message); break; }
        }
    } finally { flushing = false; }
}
async function notify(text) { await getDB().collection('telegram_outbox').insertOne({ text, createdAt: new Date(), attempts: 0, sentAt: null }); flushOutbox().catch(() => {}); }
app.post('/api/telegram/test', async (req, res, next) => { try { await notify('🔔 پیام تست'); await flushOutbox(); res.json({ success: true }); } catch (e) { next(e); } });

// ======================== TSETMC — دریافت ریزدیتا ========================
const TSETMC_MAX_FAILS_PER_DAY = 50;
let tsetmcFetchRunning = false;

async function tryFetchTsetmcIntraday(symbol, force) {
    const db = getDB();
    const today = todayDateString(getTehranParts());

    if (!force) {
        const successLog = await db.collection('tsetmc_fetch_log').findOne({ symbol, date: today, status: 'SUCCESS' });
        if (successLog) return { symbol, status: 'SKIP', reason: 'قبلاً موفق' };
        const failCount = await db.collection('tsetmc_fetch_log').countDocuments({ symbol, date: today, status: 'FAILED' });
        if (failCount >= TSETMC_MAX_FAILS_PER_DAY) return { symbol, status: 'SKIP', reason: 'بیش از حد مجاز ناموفق' };
    }

    const logDoc = { symbol, date: today, createdAt: new Date(), status: 'PENDING', insCode: null, candlesAdded: 0, candlesFetched: 0, trades: 0, error: null };

    try {
        const list = await Tsetmc.searchInstrument(symbol);
        const found = list.find(x => x.lVal18AFC === symbol) || list[0];
        if (!found || !found.insCode) {
            logDoc.status = 'FAILED';
            logDoc.error = 'insCode پیدا نشد';
            await db.collection('tsetmc_fetch_log').insertOne(logDoc);
            return { symbol, status: 'FAILED', reason: logDoc.error };
        }
        logDoc.insCode = String(found.insCode);

        const gregDate = Tsetmc.gregorianString(new Date());

        let trades;
        try {
            trades = await Tsetmc.getTradeHistory(found.insCode, gregDate, 1);
        } catch (e) {
            logDoc.status = 'FAILED';
            logDoc.error = 'TradeHistory: ' + e.message;
            await db.collection('tsetmc_fetch_log').insertOne(logDoc);
            return { symbol, status: 'FAILED', reason: logDoc.error };
        }

        if (!trades || !trades.length) {
            logDoc.status = 'FAILED';
            logDoc.error = 'TSETMC دیتای معاملات را برنگرداند';
            await db.collection('tsetmc_fetch_log').insertOne(logDoc);
            return { symbol, status: 'FAILED', reason: logDoc.error };
        }

        logDoc.trades = trades.length;
        const candles = Tsetmc.aggregateTo1m(trades);
        logDoc.candlesFetched = candles.length;

        let added = 0, updated = 0;
        for (const c of candles) {
            const r = await db.collection('candles_base').updateOne(
                { symbol, time: c.time },
                {
                    $set: { open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, trades: c.trades, source: 'tsetmc' },
                    $setOnInsert: { symbol, time: c.time }
                },
                { upsert: true }
            );
            if (r.upsertedCount) added++;
            else if (r.modifiedCount) updated++;
        }
        logDoc.candlesAdded = added + updated;
        logDoc.status = 'SUCCESS';
        await db.collection('tsetmc_fetch_log').insertOne(logDoc);
        console.log('✅ TSETMC ' + symbol + ': ' + added + ' جدید + ' + updated + ' آپدیت (' + trades.length + ' معامله)');
        return { symbol, status: 'SUCCESS', added, updated, trades: trades.length };
    } catch (e) {
        logDoc.status = 'FAILED';
        logDoc.error = e.message;
        await db.collection('tsetmc_fetch_log').insertOne(logDoc);
        console.error('❌ TSETMC ' + symbol + ':', e.message);
        return { symbol, status: 'FAILED', reason: e.message };
    }
}

async function tryFetchTsetmcAll(force) {
    if (tsetmcFetchRunning) return { error: 'در حال اجرا' };
    tsetmcFetchRunning = true;
    try {
        const db = getDB();
        const symbols = await db.collection('monitored_symbols').find({}).toArray();
        const results = [];
        for (const s of symbols) {
            const r = await tryFetchTsetmcIntraday(s.symbol, !!force);
            results.push(r);
            await new Promise(resolve => setTimeout(resolve, 800));
        }
        return { results };
    } finally {
        tsetmcFetchRunning = false;
    }
}

app.post('/api/tsetmc/fetch-intraday/:symbol', async (req, res, next) => {
    try { res.json(await tryFetchTsetmcIntraday(req.params.symbol, true)); } catch (e) { next(e); }
});

app.post('/api/tsetmc/fetch-all-intraday', async (req, res, next) => {
    try { res.json(await tryFetchTsetmcAll(true)); } catch (e) { next(e); }
});

app.get('/api/tsetmc/fetch-log', async (req, res, next) => {
    try {
        const db = getDB();
        const limit = Math.min(+req.query.limit || 100, 500);
        const filter = req.query.symbol ? { symbol: req.query.symbol } : {};
        const logs = await db.collection('tsetmc_fetch_log').find(filter).sort({ createdAt: -1 }).limit(limit).toArray();
        res.json({ logs });
    } catch (e) { next(e); }
});

app.get('/api/tsetmc/fetch-status', async (req, res, next) => {
    try {
        const db = getDB();
        const today = todayDateString(getTehranParts());
        const symbols = await db.collection('monitored_symbols').find({}).toArray();
        const status = [];
        for (const s of symbols) {
            const lastLog = await db.collection('tsetmc_fetch_log').find({ symbol: s.symbol }).sort({ createdAt: -1 }).limit(1).toArray();
            const successToday = await db.collection('tsetmc_fetch_log').findOne({ symbol: s.symbol, date: today, status: 'SUCCESS' });
            status.push({ symbol: s.symbol, successToday: !!successToday, last: lastLog[0] || null });
        }
        res.json({ today, status });
    } catch (e) { next(e); }
});

const health = { consecutiveFailures: 0, alerted: false, lastError: null, lastTickAt: null };
async function bumpDayStat(field, n = 1) {
    const today = todayDateString(getTehranParts());
    await getDB().collection('meta').updateOne({ _id: `daystats_${today}` }, { $inc: { [field]: n }, $set: { date: today } }, { upsert: true }).catch(() => {});
}
async function recordTickFailure(msg) {
    health.consecutiveFailures++; health.lastError = msg; await bumpDayStat('ticksFail');
    console.error('❌ تیک ناموفق:', msg);
    if (health.consecutiveFailures === 5 && !health.alerted) { health.alerted = true; await notify(`🔴 پنج تیک پیاپی ناموفق!\n${msg}`); }
}
async function recordTickSuccess() {
    if (health.alerted) { health.alerted = false; await notify('🟢 سیستم به حالت عادی برگشت.'); }
    health.consecutiveFailures = 0; health.lastTickAt = new Date(); await bumpDayStat('ticksOk');
}
async function sendDailySummary() {
    const today = todayDateString(getTehranParts());
    const st = await getDB().collection('meta').findOne({ _id: `daystats_${today}` }) || {};
    const usage = await getAllUsage();
    let optLine = '', storLine = '', portfolioLine = '';
    try { const list = await getDB().collection('option_positions').find({}).toArray(); const s = Options.positionStats(list); optLine = `\nآپشن: باز ${s.open} | بسته ${s.closed} | وین‌ریت ${s.winRate.toFixed(0)}٪ | بازده کل ${s.totalPnl.toFixed(0)}٪`; } catch (e) {}
    try { const sg = await Options.storageStats(); storLine = `\nدیتابیس: ${sg.storageMB} MB`; } catch (e) {}
    try {
        const open = await getDB().collection('option_positions').find({ status: 'open' }).toArray();
        let totalExposure = 0;
        for (const p of open) totalExposure += (p.entryAsk || 0) * (p.positionSize || 1) * (p.size || 1000);
        const capital = Settings.capital();
        portfolioLine = `\n💼 سرمایه: ${Math.round(capital).toLocaleString()} | درگیری: ${Math.round(totalExposure).toLocaleString()} (${capital > 0 ? (totalExposure/capital*100).toFixed(1) : 0}٪)`;
    } catch (e) {}
    await notify(`📊 خلاصه روز ${today}\nتیک: موفق ${st.ticksOk || 0} | ناموفق ${st.ticksFail || 0}\nسیگنال: ${st.signals || 0} | لغو: ${st.cancels || 0}${optLine}${portfolioLine}\nAPI: ${usage.total}/${usage.totalLimit}${storLine}`);
}

async function telegramSendBackup(filename, jsonObj) {
    if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) throw new Error('تلگرام تنظیم نشده است');
    const blob = new Blob([JSON.stringify(jsonObj, null, 2)], { type: 'application/json' });
    const form = new FormData();
    form.append('chat_id', TELEGRAM_CHAT_ID);
    form.append('caption', `💾 بکاپ (${todayDateString(getTehranParts())})`);
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
    await notify(`📅 امروز (${holidayDate}) احتمالاً تعطیل است.`);
}
app.delete('/api/holiday', async (req, res, next) => { try { holidayDate = null; inactiveTicks = 0; await getDB().collection('meta').deleteOne({ _id: 'holiday' }); res.json({ success: true }); } catch (e) { next(e); } });

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
async function persistTfCandles() {
    const db = getDB(), tfs = await activeConfigTimeframes(); if (!tfs.size) return;
    const todayStart = Math.floor(dayStartUTC(getTehranParts()).getTime() / 1000);
    const monitored = await db.collection('monitored_symbols').find({}).toArray();
    for (const m of monitored) {
        const base = await getBaseCandles(m.symbol); if (!base.length) continue;
        for (const tf of tfs) {
            const candles = mergeSessionTail(aggregateCandles(base, TF[tf]), TF[tf]);
            for (const c of candles) {
                if (c.time >= todayStart) continue;
                await db.collection('candles_tf').updateOne({ symbol: m.symbol, tf, time: new Date(c.time * 1000) },
                    { $set: { symbol: m.symbol, tf, time: new Date(c.time * 1000), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0, complete: c.complete } }, { upsert: true });
            }
        }
    }
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
async function backfillDailyFromBase() {
    const db = getDB();
    const symbols = await db.collection('monitored_symbols').find({}).toArray();
    for (const m of symbols) {
        const daily = aggregateCandles(await getBaseCandles(m.symbol), 1440);
        for (const c of daily) {
            const time = new Date(c.time * 1000);
            await db.collection('candles_daily').updateOne({ symbol: m.symbol, time }, { $setOnInsert: { symbol: m.symbol, time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0, source: 'backfill' } }, { upsert: true });
        }
    }
}

app.get('/api/timeframes', (req, res) => res.json(Object.keys(TF)));
app.get('/api/strategies', (req, res) => {
    const overrides = Settings.getAllStrategyDefaults();
    res.json(Object.values(STRATEGIES).map(s => ({ id: s.id, name: s.name, defaultTimeframe: s.defaultTimeframe, htfTimeframe: s.htfTimeframe || '1d', defaultParams: { ...s.defaultParams, ...(overrides[s.id] || {}) }, baseDefaults: s.defaultParams, overrides: overrides[s.id] || {}, indicators: s.indicators })));
});
app.get('/api/candles/:symbol/:timeframe', async (req, res, next) => {
    const { symbol, timeframe } = req.params; if (!TF[timeframe]) return res.status(400).json({ error: 'تایم‌فریم نامعتبر' });
    try { res.json(await getCandles(symbol, timeframe)); } catch (e) { next(e); }
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
            const row = { symbol: m.symbol, timeframes: {}, optionHistory: 0, optionDaily: 0, requirements: {} };
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
    if (!picked) throw new Error('سهمیه‌ی دیتای تاریخی تمام شده است.');
    const r = await fetch(`https://Api.BrsApi.ir/Tsetmc/History.php?key=${picked.key}&type=0&l18=${encodeURIComponent(symbol)}`, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, timeout: 20000 });
    if (!r.ok) throw new Error(`HTTP ${r.status} (کلید ${picked.index + 1})`);
    const data = await r.json();
    if (!Array.isArray(data) || !data.length) throw new Error('داده‌ای برای این نماد یافت نشد');
    const col = getDB().collection('candles_daily'); let added = 0;
    for (const row of data) {
        const time = parseJalaliDate(row.date); if (!time) continue;
        const close = +row.pl || +row.pc || 0; if (!(close > 0)) continue;
        const doc = { symbol, time, open: +row.pf || close, high: +row.pmax || close, low: +row.pmin || close, close, volume: +row.tvol || 0, source: 'brsapi-history' };
        const res = await col.updateOne({ symbol, time }, { $setOnInsert: doc }, { upsert: true });
        if (res.upsertedCount) added++;
    }
    return { added, total: data.length };
}
app.post('/api/import-daily/:symbol', async (req, res) => {
    try { res.json({ success: true, ...(await importDailyHistory(req.params.symbol)) }); }
    catch (e) { console.error('❌ import-daily:', e.message); res.status(400).json({ error: e.message }); }
});

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
        if (await db.collection('monitored_symbols').findOne({ symbol })) return res.status(400).json({ error: 'این نماد قبلاً اضافه شده است' });
        const doc = { symbol, addedAt: new Date() };
        const r = await db.collection('monitored_symbols').insertOne(doc);
        await refreshSymbolData(symbol).catch(() => {});
        res.json({ _id: r.insertedId, ...doc });
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

app.get('/api/strategy-configs', async (req, res, next) => { try { res.json(await getDB().collection('strategy_configs').find({}).sort({ createdAt: 1 }).toArray()); } catch (e) { next(e); } });
app.post('/api/strategy-configs', async (req, res, next) => {
    try {
        const { symbol, strategyId, timeframe, htfTimeframe, candleType, params, enabled, role } = req.body;
        if (!symbol || !STRATEGIES[strategyId]) return res.status(400).json({ error: 'نماد یا استراتژی نامعتبر' });
        if (!TF[timeframe]) return res.status(400).json({ error: 'تایم‌فریم نامعتبر' });
        const htf = htfTimeframe || STRATEGIES[strategyId].htfTimeframe || '1d';
        if (!TF[htf] || TF[htf] <= TF[timeframe]) return res.status(400).json({ error: 'تایم‌فریم بالا باید بزرگ‌تر باشد' });
        const db = getDB();
        if (!await db.collection('monitored_symbols').findOne({ symbol })) return res.status(400).json({ error: 'ابتدا نماد را اضافه کنید.' });
        const overrides = Settings.getStrategyDefaults(strategyId);
        const defaultParams = { ...STRATEGIES[strategyId].defaultParams, ...overrides, ...(params || {}) };
        const finalRole = (role === 'confirmer') ? 'confirmer' : 'leader';
        const doc = { symbol, strategyId, timeframe, htfTimeframe: htf, candleType: candleType === 'simple' ? 'simple' : 'heikin', params: defaultParams, enabled: enabled !== false, role: finalRole, createdAt: new Date() };
        const r = await db.collection('strategy_configs').insertOne(doc);
        const fullDoc = { _id: r.insertedId, ...doc };
        await evaluateStrategyConfig(fullDoc, null).catch(e => console.error('❌ ارزیابی آنی:', e.message));
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
        res.json({ success: true });
    } catch (e) { next(e); }
});
app.delete('/api/strategy-configs/:id', async (req, res, next) => {
    try { const db = getDB(); await db.collection('strategy_configs').deleteOne({ _id: new ObjectId(req.params.id) }); await db.collection('signals_state').deleteOne({ configId: req.params.id }); res.json({ success: true }); }
    catch (e) { next(e); }
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

async function computeStockBacktestTrades(cfg) {
    const def = STRATEGIES[cfg.strategyId]; const htfTf = cfg.htfTimeframe || '1d';
    const candles = closedOnly(await getCandlesFull(cfg.symbol, cfg.timeframe), cfg.timeframe);
    const htf = closedOnly(await getCandlesFull(cfg.symbol, htfTf), htfTf);
    const result = def.run(candles, { ...cfg.params, candleType: cfg.candleType }, { htfCandles: htf, htfTimeframe: htfTf, entryWindow: { start: ENTRY_START, end: ENTRY_END } });
    const closeAt = new Map(candles.map((c, i) => [c.time, { close: c.close, i }]));
    const trades = []; let open = null;
    for (const s of result.signals) {
        const c = closeAt.get(s.time); if (!c) continue;
        if (s.signalType === 'BUY' && !open) open = { entryTime: s.time, entryPrice: c.close, entryIdx: c.i, reason: s.reason, status: 'open' };
        else if (s.signalType === 'EXIT_LONG' && open) { trades.push({ ...open, exitTime: s.time, exitPrice: c.close, pnlPct: (c.close / open.entryPrice - 1) * 100, bars: c.i - open.entryIdx, exitReason: s.reason, status: 'closed' }); open = null; }
    }
    if (open) trades.push(open);
    return { candles, htf, trades };
}
app.get('/api/backtest-option/:configId', async (req, res, next) => {
    try {
        const cfg = await getDB().collection('strategy_configs').findOne({ _id: new ObjectId(req.params.configId) });
        if (!cfg) return res.status(404).json({ error: 'تنظیم یافت نشد' });
        const { trades } = await computeStockBacktestTrades(cfg);
        const closedTrades = trades.filter(t => t.status === 'closed');
        const result = await Options.runHybridOptionBacktest(cfg.symbol, closedTrades);
        res.json({ stockTradesCount: trades.length, stockClosedCount: closedTrades.length, ...result });
    } catch (e) { next(e); }
});

app.post('/api/backtest-compare', async (req, res, next) => {
    try {
        const { symbols, strategies, useRealOption } = req.body || {};
        if (!Array.isArray(symbols) || !symbols.length) return res.status(400).json({ error: 'حداقل یک نماد' });
        if (!Array.isArray(strategies) || !strategies.length) return res.status(400).json({ error: 'حداقل یک استراتژی' });

        const results = [];
        for (const symbol of symbols) {
            for (const s of strategies) {
                const def = STRATEGIES[s.id]; if (!def) continue;
                const cfg = { symbol, strategyId: s.id, timeframe: s.timeframe || def.defaultTimeframe, htfTimeframe: s.htfTimeframe || def.htfTimeframe || '1d', candleType: s.candleType === 'simple' ? 'simple' : 'heikin', params: { ...def.defaultParams, ...Settings.getStrategyDefaults(s.id), ...(s.params || {}) } };
                try {
                    const tf = cfg.timeframe, htf = cfg.htfTimeframe;
                    const closedCandles = closedOnly(await getCandles(cfg.symbol, tf), tf);
                    const closedHtf = closedOnly(await getCandles(cfg.symbol, htf), htf);
                    const required = getRequiredCandles(cfg.strategyId, cfg.params);
                    const requiredHtf = Strat.getRequiredHtfCandles ? Strat.getRequiredHtfCandles(cfg.strategyId, cfg.params) : 0;
                    if (closedCandles.length < required || closedHtf.length < requiredHtf) {
                        results.push({ symbol, strategyId: s.id, strategyName: def.name, timeframe: cfg.timeframe, htfTimeframe: cfg.htfTimeframe, candleType: cfg.candleType, error: `داده کافی نیست (ورود: ${closedCandles.length}/${required}، روند: ${closedHtf.length}/${requiredHtf})`, insufficientData: true });
                        continue;
                    }
                    const { trades } = await computeStockBacktestTrades(cfg);
                    const closedTrades = trades.filter(t => t.status === 'closed');
                    const stockWins = closedTrades.filter(t => t.pnlPct > 0);
                    const stockSum = closedTrades.reduce((acc, t) => acc + t.pnlPct, 0);

                    const h = await Options.runHybridOptionBacktest(symbol, closedTrades, { realEnabled: !!useRealOption });
                    const optStats = h.stats;
                    optStats.realUsed = h.realUsed;
                    optStats.approxUsed = h.approxUsed;
                    optStats.diagnostic = h.diagnostic;
                    optStats.hasAnyOptionData = h.hasAnyOptionData;

                    results.push({
                        symbol, strategyId: s.id, strategyName: def.name,
                        timeframe: cfg.timeframe, htfTimeframe: cfg.htfTimeframe, candleType: cfg.candleType,
                        stock: { total: trades.length, closed: closedTrades.length, winRate: closedTrades.length ? stockWins.length / closedTrades.length * 100 : 0, avgPnl: closedTrades.length ? stockSum / closedTrades.length : 0, totalPnl: stockSum },
                        option: optStats, optionMode: h.mode
                    });
                } catch (e) {
                    results.push({ symbol, strategyId: s.id, strategyName: def.name, timeframe: cfg.timeframe, htfTimeframe: cfg.htfTimeframe, candleType: cfg.candleType, error: e.message });
                }
            }
        }
        results.sort((a, b) => {
            const pfA = a.option && a.option.profitFactor != null ? a.option.profitFactor : -1;
            const pfB = b.option && b.option.profitFactor != null ? b.option.profitFactor : -1;
            return pfB - pfA;
        });
        const validResults = results.filter(r => !r.error && !r.insufficientData);
        const computeAgg = (arr) => {
            let stockTrades = 0, stockWins = 0, stockSum = 0;
            let optTrades = 0, optWins = 0, optSum = 0, optReal = 0, optApprox = 0;
            let optGrossWin = 0, optGrossLoss = 0;
            for (const r of arr) {
                const st = r.stock || {}, ot = r.option || {};
                stockTrades += st.closed || 0;
                stockWins += ((st.closed || 0) * (st.winRate || 0) / 100);
                stockSum += st.totalPnl || 0;
                optTrades += ot.count || 0;
                optWins += ((ot.count || 0) * (ot.winRate || 0) / 100);
                optSum += ot.totalPnl || 0;
                optReal += ot.realUsed || 0;
                optApprox += ot.approxUsed || 0;
                if (ot.trades && Array.isArray(ot.trades)) {
                    for (const t of ot.trades) {
                        if (t.pnlPct > 0) optGrossWin += t.pnlPct;
                        else optGrossLoss += Math.abs(t.pnlPct);
                    }
                }
            }
            const pf = optGrossLoss > 0 ? optGrossWin / optGrossLoss : (optGrossWin > 0 ? null : 0);
            return {
                stock: { trades: stockTrades, winRate: stockTrades ? stockWins / stockTrades * 100 : 0, avgPnl: stockTrades ? stockSum / stockTrades : 0, totalPnl: stockSum },
                option: { trades: optTrades, winRate: optTrades ? optWins / optTrades * 100 : 0, avgPnl: optTrades ? optSum / optTrades : 0, totalPnl: optSum, realUsed: optReal, approxUsed: optApprox, profitFactor: pf },
                combos: arr.length
            };
        };
        const total = computeAgg(validResults);
        const bySymbol = Object.entries(validResults.reduce((acc, r) => { (acc[r.symbol] = acc[r.symbol] || []).push(r); return acc; }, {})).map(([sym, arr]) => ({ symbol: sym, ...computeAgg(arr) })).sort((a, b) => (b.option.profitFactor || -1) - (a.option.profitFactor || -1));
        const byStrategy = Object.entries(validResults.reduce((acc, r) => { (acc[r.strategyId] = acc[r.strategyId] || []).push(r); return acc; }, {})).map(([sid, arr]) => ({ strategyId: sid, strategyName: arr[0].strategyName, ...computeAgg(arr) })).sort((a, b) => (b.option.profitFactor || -1) - (a.option.profitFactor || -1));
        const byTimeframe = Object.entries(validResults.reduce((acc, r) => { (acc[r.timeframe] = acc[r.timeframe] || []).push(r); return acc; }, {})).map(([tf, arr]) => ({ timeframe: tf, ...computeAgg(arr) })).sort((a, b) => (b.option.profitFactor || -1) - (a.option.profitFactor || -1));
        res.json({ count: results.length, results, aggregate: { total, bySymbol, byStrategy, byTimeframe } });
    } catch (e) { next(e); }
});

// ======================== Auto-Configure ========================
// ✅ v7: آستانه‌ها: ۷ معامله سهم + ۳ معامله آپشن + PF > 1.1
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

async function autoConfigureSingle(symbol, maxConfirmers) {
    const db = getDB();
    const monitored = await db.collection('monitored_symbols').findOne({ symbol });
    if (!monitored) return { symbol, error: 'نماد در لیست پایش نیست' };

    const strategies = Object.values(STRATEGIES).filter(s => s.id !== 'ensemble');
    const results = [];

    for (const def of strategies) {
        const cfg = { symbol, strategyId: def.id, timeframe: def.defaultTimeframe, htfTimeframe: def.htfTimeframe || '1d', candleType: 'heikin', params: { ...def.defaultParams, ...Settings.getStrategyDefaults(def.id) } };
        try {
            const tf = cfg.timeframe, htf = cfg.htfTimeframe;
            const closedCandles = closedOnly(await getCandles(symbol, tf), tf);
            const closedHtf = closedOnly(await getCandles(symbol, htf), htf);
            const required = getRequiredCandles(cfg.strategyId, cfg.params);
            const requiredHtf = Strat.getRequiredHtfCandles ? Strat.getRequiredHtfCandles(cfg.strategyId, cfg.params) : 0;
            if (closedCandles.length < required || closedHtf.length < requiredHtf) {
                results.push({ strategyId: def.id, strategyName: def.name, timeframe: cfg.timeframe, error: `داده ناکافی (${closedCandles.length}/${required})`, insufficientData: true, score: -Infinity });
                continue;
            }
            const { trades } = await computeStockBacktestTrades(cfg);
            const closedTrades = trades.filter(t => t.status === 'closed');
            const stockWins = closedTrades.filter(t => t.pnlPct > 0);
            const stockSum = closedTrades.reduce((acc, t) => acc + t.pnlPct, 0);
            const h = await Options.runHybridOptionBacktest(symbol, closedTrades, { realEnabled: true });

            const r = {
                strategyId: def.id, strategyName: def.name, timeframe: cfg.timeframe, htfTimeframe: cfg.htfTimeframe,
                stock: { total: trades.length, closed: closedTrades.length, winRate: closedTrades.length ? stockWins.length / closedTrades.length * 100 : 0, avgPnl: closedTrades.length ? stockSum / closedTrades.length : 0, totalPnl: stockSum },
                option: { ...h.stats, realUsed: h.realUsed, approxUsed: h.approxUsed, diagnostic: h.diagnostic }
            };
            r.score = scoreStrategyForAuto(r);
            results.push(r);
        } catch (e) {
            results.push({ strategyId: def.id, strategyName: def.name, error: e.message, score: -Infinity });
        }
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
        return { symbol, error: 'هیچ استراتژی معتبری پیدا نشد (معیار: ۷ معامله سهم + ۳ معامله آپشن + PF>1.1)', results, rejectionReasons };
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
        const { symbol, symbols, maxConfirmers = 2, dryRun = false } = req.body || {};
        let targetSymbols = [];
        if (symbol) targetSymbols = [symbol];
        else if (Array.isArray(symbols)) targetSymbols = symbols;
        if (!targetSymbols.length) return res.status(400).json({ error: 'حداقل یک نماد انتخاب کنید' });

        const db = getDB();
        const plans = [];
        for (const sym of targetSymbols) {
            const p = await autoConfigureSingle(sym, maxConfirmers);
            plans.push(p);
        }

        if (dryRun) return res.json({ plans, applied: false });

        const applied = [];
        for (const p of plans) {
            if (p.error || !p.leader) { applied.push({ symbol: p.symbol, error: p.error || 'بدون leader', rejectionReasons: p.rejectionReasons }); continue; }
            const old = await db.collection('strategy_configs').find({ symbol: p.symbol }).toArray();
            const oldIds = old.map(o => o._id.toString());
            await db.collection('strategy_configs').deleteMany({ symbol: p.symbol });
            await db.collection('signals_state').deleteMany({ configId: { $in: oldIds } });

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

        await notify(`🤖 تنظیم خودکار انجام شد\n${applied.filter(a => !a.error).map(a => `• ${a.symbol}: لیدر ${a.leaderName} (${a.leaderScore}) + ${a.confirmers.length} تأییدکننده`).join('\n')}`).catch(() => {});
        res.json({ plans, applied: true, results: applied });
    } catch (e) { next(e); }
});

app.post('/api/auto-configure/preview', async (req, res, next) => {
    try {
        const { symbol, symbols, maxConfirmers = 2 } = req.body || {};
        let targetSymbols = [];
        if (symbol) targetSymbols = [symbol];
        else if (Array.isArray(symbols)) targetSymbols = symbols;
        if (!targetSymbols.length) return res.status(400).json({ error: 'حداقل یک نماد' });

        const plans = [];
        for (const sym of targetSymbols) plans.push(await autoConfigureSingle(sym, maxConfirmers));
        res.json({ plans });
    } catch (e) { next(e); }
});

// ======================== ارزیابی استراتژی ========================
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
    catch (e) { console.error(`❌ استراتژی ${config.symbol}:`, e.message); return; }
    const prev = await stateColl.findOne({ configId });
    const latest = result.signals[result.signals.length - 1]; if (!latest) return;

    // ✅ Warm-up: اولین اجرا سیگنال نمی‌فرستد
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
        console.log(`🌱 warm-up: ${config.symbol} | ${config.strategyId} | position=${latest.position}`);
        return;
    }

    const prevNotified = prev.lastNotifiedTime || 0;
    let last = latest;
    for (let i = result.signals.length - 1, k = 0; i >= 0 && k < 5; i--, k++) {
        const s = result.signals[i];
        if ((s.signalType === 'BUY' || s.signalType === 'EXIT_LONG') && s.time > prevNotified) { last = s; break; }
    }
    const late = last !== latest;
    const lastPrice = candles[candles.length - 1].close;
    await stateColl.updateOne({ configId }, { $set: { ...base, insufficientData: false, position: latest.position, indicators: latest.indicators, price: lastPrice, lastCandleTime: latest.time, htfTrend: result.htfTrend || null, reason: latest.reason || null } }, { upsert: true });
    const label = `${config.symbol} | ${def.name} | ${config.timeframe}→${htfTf}`;
    const lastHa = result.ha.find(h => h.time === last.time);

    // ✅ تگ ناقص فقط برای کندل در حال تشکیل
    const tfMin = TF[config.timeframe] || 30;
    const isFormingNow = lastHa && (lastHa.time + tfMin * 60) > (Date.now() / 1000);
    const isIncomplete = isFormingNow && !!(lastHa && lastHa.complete === false);
    const incompleteTag = isIncomplete ? '\n⏳ کندل در حال تشکیل' : '';

    if (prev && prev.position === 'LONG' && latest.position !== 'LONG' && last.signalType !== 'EXIT_LONG') {
        if (!isConfirmer) { await notify(`⚠️ لغو سیگنال\n${label}\nموقعیت خرید قبلی وجود ندارد.`); await bumpDayStat('cancels'); }
    }
    const actionable = last.signalType === 'BUY' || last.signalType === 'EXIT_LONG';
    const already = prev && prev.lastNotifiedTime === last.time && prev.lastNotifiedType === last.signalType;
    if (!actionable || already) return;

    // ✅ FIX: استفاده از زمان سیگنال (نه زمان فعلی)
    const signalT = getTehranParts(new Date(last.time * 1000));
    const signalMin = signalT.hour * 60 + signalT.minute;
    const inWindow = signalMin >= ENTRY_START && signalMin <= ENTRY_END;

    const queueTag = info && info.queue === 'buy' ? '\n⚠️ صف خرید' : info && info.queue === 'sell' ? '\n⚠️ صف فروش' : '';
    const windowTag = last.signalType === 'BUY' && !inWindow ? `\n⏸ خارج از بازه` : '';

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
    const confluenceTag = confluence > 1 ? `\n🔥 هم‌گرایی ${confluence} استراتژی` : '';
    const confirmersTag = confirmersList.length ? `\n✅ تأیید: ${confirmersList.join('، ')}` : '';

    await stateColl.updateOne({ configId }, { $set: { lastNotifiedTime: last.time, lastNotifiedType: last.signalType } });

    let shouldNotifyConfirmer = false;
    if (isConfirmer && last.signalType === 'BUY' && confirmersList.length >= Settings.multiConfirmerMin()) shouldNotifyConfirmer = true;

    if (isConfirmer && !shouldNotifyConfirmer) {
        await db.collection('signal_history').insertOne({ configId, symbol: config.symbol, strategyId: config.strategyId, strategyName: def.name, timeframe: config.timeframe, signalType: last.signalType, price: lastPrice, time: last.time, reason: last.reason || null, htfTrend: result.htfTrend || null, inWindow, queue: info ? info.queue : null, incomplete: isIncomplete, confluence, role: 'confirmer', createdAt: new Date() });
        return;
    }

    let title;
    if (isConfirmer) title = `🔔 سیگنال چند-تأییدکننده (${confirmersList.length} تأیید)`;
    else title = (last.signalType === 'BUY' ? '📈 سیگنال خرید (کال)' : '🔔 خروج از خرید (بستن کال)') + (late ? ' ⏰' : '');
    const roleTag = isConfirmer ? '[چند-تأیید]' : '[لیدر]';
    const text = `${title}\n${label} ${roleTag}\nروند ${htfTf}: ${result.htfTrend || '-'}\nقیمت: ${lastPrice.toLocaleString()}${info ? ` | لحظه‌ای: ${info.price.toLocaleString()}` : ''}\nدلیل: ${last.reason || '-'}${confluenceTag}${confirmersTag}${queueTag}${windowTag}${incompleteTag}`;
    await notify(text);
    await db.collection('signal_history').insertOne({ configId, symbol: config.symbol, strategyId: config.strategyId, strategyName: def.name, timeframe: config.timeframe, signalType: last.signalType, price: lastPrice, time: last.time, reason: last.reason || null, htfTrend: result.htfTrend || null, inWindow, queue: info ? info.queue : null, incomplete: isIncomplete, confluence, role: isConfirmer ? 'multi-confirmer' : 'leader', confirmers: confirmersList, createdAt: new Date() });
    await bumpDayStat('signals');

    if (last.signalType === 'BUY') {
        if (!inWindow || (info && info.queue === 'buy')) { await notify(`ℹ️ ${config.symbol}: به‌دلیل ${!inWindow ? 'خارج از بازه' : 'صف خرید'} آپشن پیشنهاد نشد.`); return; }
        const stop = last.indicators && last.indicators.stop, atr = last.indicators && last.indicators.atr;
        const risk = stop && stop < lastPrice ? lastPrice - stop : (atr ? 2 * atr : lastPrice * 0.03);
        const targetPct = (risk * 3.0 / lastPrice) * 100;
        const minTarget = Settings.minTargetPct();
        if (targetPct < minTarget) { await notify(`ℹ️ ${config.symbol}: هدف سهم فقط ${targetPct.toFixed(1)}٪ — کمتر از حداقل ${minTarget}٪.`); return; }
        try { await Options.onBuySignal({ config, indicators: last.indicators, price: lastPrice, liveS: info ? info.price : null, tradeId: null, confluence, confirmers: confirmersList }); }
        catch (e) { console.error('❌ انتخاب آپشن:', e.message); await notify(`⚠️ انتخاب قرارداد ${config.symbol} ناموفق: ${e.message}`); }
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
        } catch (e) { console.error('❌ آپشن:', e.message); }
        await flushOutbox();
        await recordTickSuccess();
        console.log(`⏱ ${tehran.hour}:${String(tehran.minute).padStart(2, '0')} | ${monitored.length} نماد | ${n} استراتژی | فعال: ${active}`);
    } catch (e) { await recordTickFailure(e.message); }
    finally { tickRunning = false; }
}
app.post('/api/evaluate-now', async (req, res, next) => { try { await tick(); res.json({ success: true, lastTickAt: health.lastTickAt, lastError: health.lastError, consecutiveFailures: health.consecutiveFailures }); } catch (e) { next(e); } });

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
Options.registerRoutes(app, ObjectId);

app.use((req, res) => { Log.push('warn', `404 ${req.method} ${req.originalUrl}`); res.status(404).json({ error: 'مسیر یافت نشد' }); });
app.use((err, req, res, next) => { console.error('❌', err.message); res.status(500).json({ error: err.message || 'خطای داخلی' }); });

async function ensureIndexes() {
    const db = getDB();
    await db.collection('candles_daily').createIndex({ symbol: 1, time: 1 }, { unique: true });
    await db.collection('telegram_outbox').createIndex({ sentAt: 1, createdAt: 1 });
    try { await db.collection('telegram_outbox').dropIndex('sentAt_1'); } catch (e) {}
    try { await db.collection('telegram_outbox').dropIndex('createdAt_1'); } catch (e) {}
    await Log.ensureIndexes(db);
}

async function cleanOrphanConfigs() {
    const db = getDB();
    const validIds = Object.keys(STRATEGIES);
    const orphans = await db.collection('strategy_configs').find({ strategyId: { $nin: validIds } }).toArray();
    if (orphans.length) {
        console.log(`🧹 حذف ${orphans.length} کانفیگ یتیم:`, orphans.map(o => `${o.symbol}/${o.strategyId}`).join(', '));
        await db.collection('strategy_configs').deleteMany({ _id: { $in: orphans.map(o => o._id) } });
        await db.collection('signals_state').deleteMany({ configId: { $in: orphans.map(o => o._id.toString()) } });
    }
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
    Options.init({
        getDB, notify,
        TIMEFRAME_MINUTES: Strat.TIMEFRAME_MINUTES,
        todayDateString: () => todayDateString(getTehranParts()),
        archiveStats: async () => [],
        getQuote: (sym) => lastQuotes.get(sym)
    });
    await Options.ensureIndexes();
    await cleanOrphanConfigs();
    await backfillDailyFromBase();
    await persistTfCandles().catch(e => console.error('❌ persistTfCandles:', e.message));
    const hol = await getDB().collection('meta').findOne({ _id: 'holiday' }); if (hol) holidayDate = hol.date;
    if (!await loadSymbolsCacheFromDB()) { try { await updateSymbolsCacheFromRaw(await fetchAllSymbolsRaw()); } catch (e) { console.error('❌ کش نمادها:', e.message); } }
    if (!ADMIN_TOKEN) console.warn('⚠️ ADMIN_TOKEN تنظیم نشده.');

    cron.schedule('* * * * *', async () => {
        const t = getTehranParts();
        flushOutbox().catch(() => {});
        if (!isMarketOpen(t)) return;
        if (holidayDate === todayDateString(t)) {
            if (t.minute % 5 !== 0) return;
            try { const raw = await fetchAllSymbolsRaw(); if (raw.filter(s => +s.tno > 0).length >= 20) { holidayDate = null; inactiveTicks = 0; await getDB().collection('meta').deleteOne({ _id: 'holiday' }); await notify('🟢 بازار فعال شد.'); } else return; }
            catch (e) { return; }
        }
        await tick();
    });

    cron.schedule('32 12 * * 6,0,1,2,3', async () => {
        if (holidayDate === todayDateString(getTehranParts())) return;
        try {
            await evaluateAll(null);
            await persistTfCandles();
            const monitored = await getDB().collection('monitored_symbols').find({}).toArray();
            const mset = new Set(monitored.map(m => Options.norm(m.symbol)));
            const chain = await Options.fetchChain(0);
            await Options.storeEOD(chain, mset);
            await Options.managePositions(chain);
            await flushOutbox();
        } catch (e) { console.error('❌ EOD:', e.message); }
    }, { timezone: 'Asia/Tehran' });

    cron.schedule('35 12 * * 6,0,1,2,3', () => { if (holidayDate !== todayDateString(getTehranParts())) sendDailySummary().catch(() => {}); }, { timezone: 'Asia/Tehran' });
    cron.schedule('0 10 * * 4', () => { sendWeeklyBackup().catch(e => console.error('❌ بکاپ:', e.message)); }, { timezone: 'Asia/Tehran' });

    // 🆕 TSETMC — هر ۶۰ دقیقه تلاش برای دریافت ریزدیتا
    cron.schedule('0 * * * *', async () => {
        try {
            const t = getTehranParts();
            const m = minuteOfDay(t);
            // فقط بین 9:00 تا 22:00 تهران
            if (m < 540 || m > 1320) return;
            await tryFetchTsetmcAll(false);
        } catch (e) { console.error('❌ Cron TSETMC:', e.message); }
    }, { timezone: 'Asia/Tehran' });

    const server = app.listen(PORT, () => console.log(`🚀 ${SERVER_VERSION} | port ${PORT} | keys ${API_KEYS.length}`));
    server.keepAliveTimeout = 10 * 60 * 1000;
    server.headersTimeout = 11 * 60 * 1000;
    server.requestTimeout = 10 * 60 * 1000;

    notify(`🚀 سرور ری‌استارت شد (${SERVER_VERSION})`).catch(() => {});
}
start().catch(e => { console.error('❌ راه‌اندازی:', e); process.exit(1); });