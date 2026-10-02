'use strict';
// ============================================================
// data.service.js — مدیریت داده کندل‌ها و aggregation
// ============================================================
// - خواندن کندل‌ها از Mongo
// - ساخت تایم‌فریم از candles_base
// - ذخیره کندل زنده
// - Backfill از AlgoTik
// ============================================================

const {
    TIMEFRAME_MINUTES,
    SESSION_START_MIN,
    SESSION_END_MIN,
    TEHRAN_OFFSET_MINUTES,
    COLLECTIONS
} = require('../config/constants');

let deps = {
    getDB: null,
    algotik: null,
    logger: null
};

function init(d) {
    deps = { ...deps, ...d };
}

// ============================================================
// Time helpers (Tehran)
// ============================================================
function getTehranParts(date = new Date()) {
    const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Tehran',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false, weekday: 'short'
    });
    const map = {};
    fmt.formatToParts(date).forEach(p => { map[p.type] = p.value; });
    return {
        year: +map.year, month: +map.month, day: +map.day,
        hour: (+map.hour) % 24, minute: +map.minute, second: +map.second,
        weekday: map.weekday
    };
}

function tehranPartsToUTCDate(y, mo, d, h, mi) {
    return new Date(Date.UTC(y, mo - 1, d, h, mi, 0) - 3.5 * 3600 * 1000);
}

function dayStartUTC(t) {
    return tehranPartsToUTCDate(t.year, t.month, t.day, 0, 0);
}

function getBucketTime(t, sizeMin) {
    const b = Math.floor((t.hour * 60 + t.minute) / sizeMin) * sizeMin;
    return tehranPartsToUTCDate(t.year, t.month, t.day, Math.floor(b / 60), b % 60);
}

function minuteOfDay(t) { return t.hour * 60 + t.minute; }

// ============================================================
// Session / candle closing helpers
// ============================================================
function expectedBarsFor(bucketStartMin, tfMin) {
    const overlap = Math.max(0, Math.min(bucketStartMin + tfMin, SESSION_END_MIN) - Math.max(bucketStartMin, SESSION_START_MIN));
    return Math.min(tfMin, overlap) || tfMin;
}

function isCandleClosed(timeSec, tfMin, now = new Date()) {
    const t = getTehranParts(new Date(timeSec * 1000));
    // 🆕 هم‌راست با SESSION_END_MIN (12:35) در constants.js
    const endHour = Math.floor(SESSION_END_MIN / 60);
    const endMin = SESSION_END_MIN % 60;
    const sessionEnd = tehranPartsToUTCDate(t.year, t.month, t.day, endHour, endMin);
    if (tfMin >= 1440 || (tfMin === 60 && t.hour === 11)) return now >= sessionEnd;
    const natural = new Date(timeSec * 1000 + tfMin * 60000);
    return now >= (natural < sessionEnd ? natural : sessionEnd);
}

function closedOnly(candles, tf) {
    const tfMin = TIMEFRAME_MINUTES[tf] || 1440;
    const now = new Date();
    return candles.filter(c => isCandleClosed(c.time, tfMin, now));
}

// ============================================================
// Aggregation
// ============================================================
function aggregateCandles(baseCandles, tfMin) {
    const sorted = [...baseCandles].sort((a, b) => a.time - b.time);
    const map = new Map();

    for (const c of sorted) {
        const t = getTehranParts(new Date(c.time * 1000));
        const b = Math.floor((t.hour * 60 + t.minute) / tfMin) * tfMin;
        const bh = Math.floor(b / 60), bm = b % 60;
        const key = `${t.year}-${t.month}-${t.day}-${bh}-${bm}`;

        if (!map.has(key)) {
            map.set(key, {
                time: Math.floor(tehranPartsToUTCDate(t.year, t.month, t.day, bh, bm).getTime() / 1000),
                open: c.open, high: c.high, low: c.low, close: c.close,
                volume: c.volume || 0,
                barCount: 1,
                expectedBars: expectedBarsFor(b, tfMin)
            });
        } else {
            const x = map.get(key);
            x.high = Math.max(x.high, c.high);
            x.low = Math.min(x.low, c.low);
            x.close = c.close;
            x.volume += c.volume || 0;
            x.barCount++;
        }
    }

    return Array.from(map.values())
        .map(x => ({ ...x, complete: x.barCount >= Math.max(1, x.expectedBars) * 0.6 }))
        .sort((a, b) => a.time - b.time);
}

function mergeSessionTail(candles, tfMin) {
    if (tfMin !== 60) return candles;
    const out = [];
    for (const c of candles) {
        const t = getTehranParts(new Date(c.time * 1000));
        const prev = out[out.length - 1];
        if (t.hour === 12 && prev) {
            const pt = getTehranParts(new Date(prev.time * 1000));
            if (pt.day === t.day && pt.month === t.month && pt.hour === 11) {
                prev.high = Math.max(prev.high, c.high);
                prev.low = Math.min(prev.low, c.low);
                prev.close = c.close;
                prev.barCount = (prev.barCount || 0) + (c.barCount || 0);
                prev.expectedBars = (prev.expectedBars || 0) + (c.expectedBars || 0);
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
    const map = new Map(permanentRows.map(c => [
        Math.floor(c.time.getTime() / 1000),
        {
            time: Math.floor(c.time.getTime() / 1000),
            open: c.open, high: c.high, low: c.low, close: c.close,
            volume: c.volume || 0, complete: c.complete
        }
    ]));
    // 🆕 اگه permanent قبلاً complete=true بوده، live اون رو خراب نکنه
    for (const c of live) {
        const existing = map.get(c.time);
        if (existing && existing.complete === true && c.complete !== true) {
            // keep existing (complete) با آپدیت close/high/low/volume
            map.set(c.time, {
                ...c,
                complete: true
            });
        } else {
            map.set(c.time, c);
        }
    }
    return Array.from(map.values()).sort((a, b) => a.time - b.time);
}

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
            high: Math.max(...arr.map(x => x.high)),
            low: Math.min(...arr.map(x => x.low)),
            close: last.close,
            volume: arr.reduce((s, x) => s + (x.volume || 0), 0)
        });
    }
    return result.sort((a, b) => a.time - b.time);
}

// ============================================================
// Read candles
// ============================================================
async function getBaseCandles(symbol) {
    const db = deps.getDB();
    // نکته: فیلتر flat حذف شد — کندل‌های صف خرید/فروش داده واقعی بازارن
    const base = await db.collection(COLLECTIONS.CANDLES_BASE)
        .find({ symbol })
        .sort({ time: 1 }).toArray();
    return base.map(c => ({
        time: Math.floor(c.time.getTime() / 1000),
        open: c.open, high: c.high, low: c.low, close: c.close,
        volume: c.volume || 0
    }));
}

async function getCandles(symbol, tf) {
    const db = deps.getDB();

    if (tf === '1d') {
        const d = await db.collection(COLLECTIONS.CANDLES_DAILY)
            .find({ symbol }).sort({ time: 1 }).toArray();
        return d.map(c => ({
            time: Math.floor(c.time.getTime() / 1000),
            open: c.open, high: c.high, low: c.low, close: c.close,
            volume: c.volume || 0
        }));
    }

    const permanent = await db.collection(COLLECTIONS.CANDLES_TF)
        .find({ symbol, tf }).sort({ time: 1 }).toArray();
    const base = await getBaseCandles(symbol);
    return buildTfCandles(permanent, base, TIMEFRAME_MINUTES[tf]);
}

async function getCandlesFull(symbol, tf) {
    return getCandles(symbol, tf);
}

// ============================================================
// Write candles (live)
// ============================================================
async function upsertLiveCandle(symbol, time, price, volDelta) {
    const db = deps.getDB();
    // 🆕 فقط اگه کندل real OHLC وجود نداره، از last price بنویس
    // این جلوی overwrite دیتای backfill شده رو می‌گیره
    const existing = await db.collection(COLLECTIONS.CANDLES_BASE).findOne(
        { symbol, time },
        { projection: { source: 1 } }
    );
    if (existing && existing.source === 'algotik_intraday') {
        // دیتای سالم داریم، tick جدید رو نادیده بگیر
        return;
    }

    await db.collection(COLLECTIONS.CANDLES_BASE).updateOne(
        { symbol, time },
        {
            $setOnInsert: { symbol, time, open: price, source: 'live_tick' },
            $set: { close: price },
            $max: { high: price },
            $min: { low: price },
            $inc: { volume: volDelta || 0 }
        },
        { upsert: true }
    );
}

async function upsertDailyCandle(symbol, time, s) {
    const db = deps.getDB();
    // 🆕 algotik-tse: Last, Close, Open, High, Low, Volume, TradeCount
    const pl = +s.Last || +s.Close || +s.pl || 0;
    if (!pl) return;
    const num = v => (+v > 0 ? +v : pl);
    await db.collection(COLLECTIONS.CANDLES_DAILY).updateOne(
        { symbol, time },
        { $set: {
            symbol, time,
            open: num(+s.Open || +s.pf),
            high: num(+s.High || +s.pmax),
            low: num(+s.Low || +s.pmin),
            close: pl,
            volume: +(s.Volume || s.tvol || 0),
            trades: +(s.TradeCount || s.tno || 0),
            source: 'live'
        }},
        { upsert: true }
    );
}

// ============================================================
// Persist TF candles (end of day)
// ============================================================
async function persistTfCandles(configs) {
    const db = deps.getDB();
    const tfs = new Set();
    for (const c of configs) {
        if (TIMEFRAME_MINUTES[c.timeframe] && c.timeframe !== '1d') tfs.add(c.timeframe);
        if (TIMEFRAME_MINUTES[c.htfTimeframe] && c.htfTimeframe !== '1d') tfs.add(c.htfTimeframe);
    }
    if (!tfs.size) return;

    const todayStart = Math.floor(dayStartUTC(getTehranParts()).getTime() / 1000);
    const monitored = await db.collection(COLLECTIONS.MONITORED_SYMBOLS).find({}).toArray();

    let totalWritten = 0;
    for (const m of monitored) {
        const base = await getBaseCandles(m.symbol);
        if (!base.length) continue;

        for (const tf of tfs) {
            const tfMin = TIMEFRAME_MINUTES[tf];
            const candles = mergeSessionTail(aggregateCandles(base, tfMin), tfMin);
            const bulkOps = [];

            for (const c of candles) {
                if (c.time >= todayStart) continue;
                bulkOps.push({
                    updateOne: {
                        filter: { symbol: m.symbol, tf, time: new Date(c.time * 1000) },
                        update: { $set: {
                            symbol: m.symbol, tf, time: new Date(c.time * 1000),
                            open: c.open, high: c.high, low: c.low, close: c.close,
                            volume: c.volume || 0, complete: c.complete
                        }},
                        upsert: true
                    }
                });
                if (bulkOps.length >= 500) {
                    await db.collection(COLLECTIONS.CANDLES_TF).bulkWrite(bulkOps, { ordered: false });
                    totalWritten += bulkOps.length;
                    bulkOps.length = 0;
                }
            }
            if (bulkOps.length) {
                await db.collection(COLLECTIONS.CANDLES_TF).bulkWrite(bulkOps, { ordered: false });
                totalWritten += bulkOps.length;
            }
        }
    }
    return totalWritten;
}

// ============================================================
// Backfill daily from base
// ============================================================
async function backfillDailyFromBase(symbols) {
    const db = deps.getDB();
    let total = 0;
    for (const symbol of symbols) {
        const base = await getBaseCandles(symbol);
        const daily = aggregateCandles(base, 1440);
        const ops = [];
        for (const c of daily) {
            const time = new Date(c.time * 1000);
            ops.push({
                updateOne: {
                    filter: { symbol, time },
                    update: { $setOnInsert: {
                        symbol, time,
                        open: c.open, high: c.high, low: c.low, close: c.close,
                        volume: c.volume || 0,
                        source: 'backfill'
                    }},
                    upsert: true
                }
            });
            if (ops.length >= 500) {
                await db.collection(COLLECTIONS.CANDLES_DAILY).bulkWrite(ops, { ordered: false });
                total += ops.length;
                ops.length = 0;
            }
        }
        if (ops.length) {
            await db.collection(COLLECTIONS.CANDLES_DAILY).bulkWrite(ops, { ordered: false });
            total += ops.length;
        }
    }
    return total;
}

// ============================================================
// Import daily from TSETMC history
// ============================================================
function jalaliToGregorian(jy, jm, jd) {
    jy += 1595;
    let days = -355668 + (365 * jy) + (Math.floor(jy / 33) * 8) +
        Math.floor(((jy % 33) + 3) / 4) + jd +
        ((jm < 7) ? (jm - 1) * 31 : ((jm - 7) * 30) + 186);
    let gy = 400 * Math.floor(days / 146097);
    days %= 146097;
    if (days > 36524) {
        gy += 100 * Math.floor(--days / 36524);
        days %= 36524;
        if (days >= 365) days++;
    }
    gy += 4 * Math.floor(days / 1461);
    days %= 1461;
    if (days > 365) {
        gy += Math.floor((days - 1) / 365);
        days = (days - 1) % 365;
    }
    let gd = days + 1;
    const sal_a = [0, 31, ((gy % 4 === 0 && gy % 100 !== 0) || (gy % 400 === 0)) ? 29 : 28,
        31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let gm;
    for (gm = 0; gm < 13; gm++) {
        const v = sal_a[gm];
        if (gd <= v) break;
        gd -= v;
    }
    return { gy, gm, gd };
}

function parseJalaliDate(s) {
    const [jy, jm, jd] = String(s || '').split('-').map(Number);
    if (!jy || !jm || !jd) return null;
    const { gy, gm, gd } = jalaliToGregorian(jy, jm, jd);
    return tehranPartsToUTCDate(gy, gm, gd, 0, 0);
}

async function importDailyHistory(symbol, rows) {
    const db = deps.getDB();
    const col = db.collection(COLLECTIONS.CANDLES_DAILY);
    let added = 0;

    for (const row of rows) {
        const time = parseJalaliDate(row.date);
        if (!time) continue;
        const close = +row.pl || +row.pc || 0;
        if (!(close > 0)) continue;

        const res = await col.updateOne(
            { symbol, time },
            { $setOnInsert: {
                symbol, time,
                open: +row.pf || close,
                high: +row.pmax || close,
                low: +row.pmin || close,
                close,
                volume: +row.tvol || 0,
                trades: +row.tno || 0,
                source: 'history'
            }},
            { upsert: true }
        );
        if (res.upsertedCount) added++;
    }
    return { added, total: rows.length };
}

// ============================================================
// Aggregation helper for chart
// ============================================================
async function getChartCandles(symbol, timeframe) {
    const { ALL_CHART_TIMEFRAMES } = require('../config/constants');
    const isDailyPlus = ['1d', '1w', '1M', '1Y'].includes(timeframe);

    if (isDailyPlus) {
        const db = deps.getDB();
        const daily = await db.collection(COLLECTIONS.CANDLES_DAILY)
            .find({ symbol }).sort({ time: 1 }).toArray();
        const rows = daily.map(c => ({
            time: Math.floor(new Date(c.time).getTime() / 1000),
            open: c.open, high: c.high, low: c.low, close: c.close,
            volume: c.volume || 0
        }));
        return aggregateDailyForChart(rows, timeframe);
    }

    return getCandles(symbol, timeframe);
}

// ============================================================
// Data Coverage Report
// ============================================================
async function getDataCoverage(symbols, strategies, getRequiredCandles) {
    const db = deps.getDB();
    if (!symbols.length) return [];

    // 🆕 ۴ aggregation برای همه‌ی نمادها (به جای N×M کوئری)
    const [tfAgg, dailyAgg, optHistAgg, optDailyAgg] = await Promise.all([
        db.collection(COLLECTIONS.CANDLES_TF).aggregate([
            { $match: { symbol: { $in: symbols } } },
            { $group: {
                _id: { symbol: '$symbol', tf: '$tf' },
                count: { $sum: 1 },
                from: { $min: '$time' },
                to: { $max: '$time' }
            } }
        ]).toArray(),
        db.collection(COLLECTIONS.CANDLES_DAILY).aggregate([
            { $match: { symbol: { $in: symbols } } },
            { $group: {
                _id: '$symbol',
                count: { $sum: 1 },
                from: { $min: '$time' },
                to: { $max: '$time' }
            } }
        ]).toArray(),
        db.collection(COLLECTIONS.OPTION_HISTORY).aggregate([
            { $match: { underlying: { $in: symbols } } },
            { $group: { _id: '$underlying', count: { $sum: 1 } } }
        ]).toArray(),
        db.collection(COLLECTIONS.OPTION_DAILY).aggregate([
            { $match: { underlying: { $in: symbols } } },
            { $group: { _id: '$underlying', count: { $sum: 1 } } }
        ]).toArray()
    ]);

    const tfMap = {};
    for (const r of tfAgg) {
        const sym = r._id.symbol;
        if (!tfMap[sym]) tfMap[sym] = {};
        tfMap[sym][r._id.tf] = { count: r.count, from: r.from, to: r.to };
    }
    const dailyMap = {};
    for (const r of dailyAgg) {
        dailyMap[r._id] = { count: r.count, from: r.from, to: r.to };
    }
    const optHistMap = {};
    for (const r of optHistAgg) optHistMap[r._id] = r.count;
    const optDailyMap = {};
    for (const r of optDailyAgg) optDailyMap[r._id] = r.count;

    const result = [];
    const tfs = Object.keys(TIMEFRAME_MINUTES).filter(t => t !== '1d');
    for (const sym of symbols) {
        const row = {
            symbol: sym,
            timeframes: {},
            optionHistory: optHistMap[sym] || 0,
            optionDaily: optDailyMap[sym] || 0,
            requirements: {}
        };

        for (const tf of tfs) {
            const m = (tfMap[sym] && tfMap[sym][tf]) || {};
            row.timeframes[tf] = {
                count: m.count || 0,
                from: m.from || null,
                to: m.to || null
            };
        }
        const dm = dailyMap[sym] || {};
        row.timeframes['1d'] = {
            count: dm.count || 0,
            from: dm.from || null,
            to: dm.to || null
        };

        for (const s of strategies) {
            const req = getRequiredCandles(s.id, s.defaultParams);
            const have = row.timeframes[s.defaultTimeframe]?.count || 0;
            row.requirements[s.id] = {
                tf: s.defaultTimeframe,
                required: req,
                have,
                ok: have >= req,
                name: s.name
            };
        }

        result.push(row);
    }
    return result;
}

// ============================================================
// 🆕 In-memory cache for heavy queries
// ============================================================
const _cache = new Map();
function cached(key, ttlMs, fn) {
    const e = _cache.get(key);
    if (e && Date.now() - e.at < ttlMs) return Promise.resolve(e.val);
    return Promise.resolve(fn()).then(v => {
        _cache.set(key, { at: Date.now(), val: v });
        return v;
    });
}

// 🆕 Stale-While-Revalidate cache
// اگه cache تازه → فوری
// اگه cache قدیمی ولی نه خیلی → نسخه‌ی قدیمی + refresh پس‌زمینه
// اگه cache سرد → منتظر
const _swrCache = new Map();
const SWR_STALE_WINDOW = 24 * 60 * 60 * 1000;   // ۲۴ ساعت

function cachedSWR(key, ttlMs, fn, opts = {}) {
    const now = Date.now();
    const staleWindow = opts.staleWindowMs || SWR_STALE_WINDOW;
    const e = _swrCache.get(key);

    // تازه
    if (e && (now - e.at) < ttlMs) return Promise.resolve(e.value);

    // قدیمی ولی usable → فوری برگردون + refresh پس‌زمینه
    if (e && (now - e.at) < staleWindow) {
        if (!e.refreshing) {
            e.refreshing = true;
            Promise.resolve(fn())
                .then(v => {
                    _swrCache.set(key, { value: v, at: Date.now(), refreshing: false });
                    if (deps.logger) deps.logger.info(`swr: refreshed "${key}"`);
                })
                .catch(err => {
                    e.refreshing = false;
                    if (deps.logger) deps.logger.warn(`swr refresh "${key}": ${err.message}`);
                });
        }
        return Promise.resolve(e.value);
    }

    // سرد
    return Promise.resolve(fn()).then(v => {
        _swrCache.set(key, { value: v, at: Date.now(), refreshing: false });
        return v;
    });
}

function clearCache(prefix) {
    if (!prefix) { _cache.clear(); _swrCache.clear(); return; }
    for (const k of _cache.keys()) if (k.startsWith(prefix)) _cache.delete(k);
    for (const k of _swrCache.keys()) if (k.startsWith(prefix)) _swrCache.delete(k);
}
// ============================================================
// 🆕 Candle cache — با eviction خودکار (رفع memory leak)
// ============================================================
const _candleCache = new Map();
const CANDLE_TTL_MS = 3 * 60 * 1000;    // ۳ دقیقه
const CANDLE_MAX_ENTRIES = 500;          // ۲۳ نماد × ۸ تایم‌فریم + بافر

function _cacheKey(symbol, tf) { return `${symbol}::${tf}`; }

// 🆕 پاک‌سازی دورهای — هر ۶۰ ثانیه
let _cacheCleanupTimer = null;
function _startCacheCleanup() {
    if (_cacheCleanupTimer) return;
    _cacheCleanupTimer = setInterval(() => {
        const now = Date.now();
        let removed = 0;
        // 1) حذف منقضی‌شده‌ها
        for (const [k, v] of _candleCache) {
            if (now - v.at > CANDLE_TTL_MS) {
                _candleCache.delete(k);
                removed++;
            }
        }
        // 2) اگه هنوز بیشتر از سقف بود، قدیمی‌ترین‌ها رو حذف کن
        if (_candleCache.size > CANDLE_MAX_ENTRIES) {
            const sorted = [..._candleCache.entries()].sort((a, b) => a[1].at - b[1].at);
            const toRemove = _candleCache.size - CANDLE_MAX_ENTRIES;
            for (let i = 0; i < toRemove; i++) {
                _candleCache.delete(sorted[i][0]);
                removed++;
            }
        }
        if (removed > 0) {
            deps.logger && deps.logger.info(`candle cache: evicted ${removed}, size=${_candleCache.size}`);
        }
    }, 60000);
    // unref تا مانع خروج process نشه
    if (_cacheCleanupTimer.unref) _cacheCleanupTimer.unref();
}

function invalidateCandleCache(symbol, tf) {
    if (symbol && tf) _candleCache.delete(_cacheKey(symbol, tf));
    else if (symbol) {
        for (const k of _candleCache.keys()) if (k.startsWith(symbol + '::')) _candleCache.delete(k);
    } else _candleCache.clear();
}

// wrap getCandles
const _origGetCandles = getCandles;
getCandles = async function cachedGetCandles(symbol, tf) {
    _startCacheCleanup();
    const key = _cacheKey(symbol, tf);
    const e = _candleCache.get(key);
    if (e && Date.now() - e.at < CANDLE_TTL_MS) return e.val;
    const v = await _origGetCandles(symbol, tf);
    _candleCache.set(key, { at: Date.now(), val: v });
    return v;
};

const _origGetBaseCandles = getBaseCandles;
getBaseCandles = async function cachedGetBaseCandles(symbol) {
    _startCacheCleanup();
    const key = _cacheKey(symbol, '_base');
    const e = _candleCache.get(key);
    if (e && Date.now() - e.at < CANDLE_TTL_MS) return e.val;
    const v = await _origGetBaseCandles(symbol);
    _candleCache.set(key, { at: Date.now(), val: v });
    return v;
};

module.exports = {
    invalidateCandleCache,
    init,
    cached,
    cachedSWR,
    clearCache,
    // time
    getTehranParts, tehranPartsToUTCDate, dayStartUTC, getBucketTime,
    minuteOfDay, isCandleClosed, closedOnly,
    // aggregation
    aggregateCandles, mergeSessionTail, buildTfCandles, aggregateDailyForChart,
    // read
    getBaseCandles, getCandles, getCandlesFull, getChartCandles,
    // write
    upsertLiveCandle, upsertDailyCandle, persistTfCandles, backfillDailyFromBase,
    // import
    importDailyHistory, parseJalaliDate,
    // coverage
    getDataCoverage
};