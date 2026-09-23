'use strict';
// ============================================================
// signal.service.js — هماهنگ‌کننده ارزیابی سیگنال‌ها
// ============================================================
// - تزریق dependency ها به core/signals
// - حلقه tick (خواندن live data، ارزیابی، notify)
// - مدیریت health و holiday
// ============================================================

const {
    COLLECTIONS,
    SESSION_START_MIN,
    SESSION_END_MIN,
    TEHRAN_OFFSET_MINUTES
} = require('../config/constants');

let deps = {
    getDB: null,
    dataService: null,
    signals: null,
    options: null,
    algotik: null,
    settings: null,
    notify: null,
    logger: null,
    symbols: null  // infra/algotik-symbols (یا هر منبع دیگه)
};

function init(d) { deps = { ...deps, ...d }; }

// ============================================================
// Health tracking
// ============================================================
const health = {
    consecutiveFailures: 0,
    alerted: false,
    lastError: null,
    lastTickAt: null
};

let tickRunning = false;
const lastSnap = new Map();
const lastQuotes = new Map();
let inactiveTicks = 0;
let holidayDate = null;

// ============================================================
// Day stats
// ============================================================
async function bumpDayStat(field, n = 1) {
    const today = todayDateStr();
    await deps.getDB().collection(COLLECTIONS.META).updateOne(
        { _id: `daystats_${today}` },
        { $inc: { [field]: n }, $set: { date: today } },
        { upsert: true }
    ).catch(() => {});
}

function todayDateStr(t) {
    if (!t) t = deps.dataService.getTehranParts();
    return `${t.year}-${String(t.month).padStart(2, '0')}-${String(t.day).padStart(2, '0')}`;
}

async function recordTickFailure(msg) {
    health.consecutiveFailures++;
    health.lastError = msg;
    await bumpDayStat('ticksFail');
    deps.logger && deps.logger.warn('تیک ناموفق: ' + msg);

    if (health.consecutiveFailures === 5 && !health.alerted) {
        health.alerted = true;
        await deps.notify(`پنج تیک پیاپی ناموفق!\n${msg}`);
    }
}

async function recordTickSuccess() {
    if (health.alerted) {
        health.alerted = false;
        await deps.notify('سیستم به حالت عادی برگشت.');
    }
    health.consecutiveFailures = 0;
    health.lastTickAt = new Date();
    await bumpDayStat('ticksOk');
}

// ============================================================
// Market info builders
// ============================================================
async function buildMarketInfo(monitored) {
    const raw = await deps.algotik.getLiveMarket();
    const tehran = deps.dataService.getTehranParts();

    const rawMap = new Map();
    for (const s of raw) {
        const sym = s.Symbol || s.symbol;   // 🆕 algotik-tse: Symbol
        if (sym) rawMap.set(sym, s);
    }

    const bucket1 = deps.dataService.getBucketTime(tehran, 1);
    const dayTime = deps.dataService.dayStartUTC(tehran);
    const marketInfo = new Map();

    for (const m of monitored) {
        const s = rawMap.get(m.symbol);
        if (!s) continue;

        // 🆕 algotik-tse: Last, Close, MaxAllowed, MinAllowed, TradeCount, Volume
        const price = +s.Last || +s.Close || +s.pl || 0;
        if (!price) continue;

        const tmax = +s.MaxAllowed || +s.tmax || 0;
        const tmin = +s.MinAllowed || +s.tmin || 0;
        const atUpper = tmax > 0 && price >= tmax;
        const atLower = tmin > 0 && price <= tmin;
        const queue = atUpper ? 'buy' : atLower ? 'sell' : null;

        // 🆕 کلیدهای درست
        const tno = +(s.TradeCount || s.tno || 0);
        const tvol = +(s.Volume || s.tvol || 0);

        const prev = lastSnap.get(m.symbol);
        const traded = !prev || tno !== prev.tno;
        // 🆕 اگه prev نبود، volDelta = tvol (شروع روز جدید)
        const volDelta = prev && tvol >= prev.tvol ? tvol - prev.tvol : tvol;
        lastSnap.set(m.symbol, { tno, tvol });

        marketInfo.set(m.symbol, { price, queue });
        lastQuotes.set(m.symbol, { price, queue, at: new Date() });

        if (!traded && !atUpper && !atLower) continue;

        await deps.dataService.upsertLiveCandle(m.symbol, bucket1, price, volDelta);
        await deps.dataService.upsertDailyCandle(m.symbol, dayTime, s);
    }

    return { marketInfo, activeCount: raw.filter(s => +s.tno > 0).length };
}

// ============================================================
// Main tick
// ============================================================
async function tick() {
    if (tickRunning) return;
    tickRunning = true;
    try {
        const db = deps.getDB();
        const monitored = await db.collection(COLLECTIONS.MONITORED_SYMBOLS).find({}).toArray();
        if (!monitored.length) {
            health.lastTickAt = new Date();
            return;
        }

        const tehran = deps.dataService.getTehranParts();
        const mins = deps.dataService.minuteOfDay(tehran);
        const isWithinMarketWindow = mins >= SESSION_START_MIN + 10 && mins <= SESSION_END_MIN + 5;

        let result;
        try {
            result = await buildMarketInfo(monitored);
        } catch (e) {
            await recordTickFailure(e.message);
            return;
        }

        const { marketInfo, activeCount } = result;

        // تشخیص تعطیلی: فقط در ساعت بازار
        if (isWithinMarketWindow) {
            if (activeCount < 20) {
                if (++inactiveTicks >= 12) {
                    await markHoliday(tehran);
                    return;
                }
            } else {
                inactiveTicks = 0;
            }
        }

        const n = await deps.signals.evaluateAll(marketInfo);

        // مدیریت آپشن‌ها
        try {
            const openOpt = await deps.options.openPositionsCount();
            if (tehran.minute % 5 === 0 || openOpt > 0) {
                const chain = await deps.options.fetchChain
                    ? await deps.options.fetchChain(30000)
                    : null;
                if (chain) {
                    const mset = new Set(monitored.map(m => deps.options.norm(m.symbol)));
                    if (tehran.minute % 5 === 0) {
                        await deps.options.storeSnapshots(chain, mset);
                        await deps.options.storeFullOptionHistory(chain, mset);
                    }
                    await deps.options.managePositions(chain);
                }
            }
        } catch (e) {
            deps.logger && deps.logger.warn('آپشن: ' + e.message);
        }

        await recordTickSuccess();
        deps.logger && deps.logger.info(`${tehran.hour}:${String(tehran.minute).padStart(2, '0')} | ${monitored.length} نماد | ${n} استراتژی | فعال: ${activeCount}`);
    } catch (e) {
        await recordTickFailure(e.message);
    } finally {
        tickRunning = false;
    }
}

// ============================================================
// Holiday
// ============================================================
async function markHoliday(t) {
    holidayDate = todayDateStr(t);
    await deps.getDB().collection(COLLECTIONS.META).updateOne(
        { _id: 'holiday' },
        { $set: { date: holidayDate } },
        { upsert: true }
    );
    await deps.notify(`امروز (${holidayDate}) احتمالا تعطیل است.`);
}

async function clearHoliday() {
    holidayDate = null;
    inactiveTicks = 0;
    await deps.getDB().collection(COLLECTIONS.META).deleteOne({ _id: 'holiday' });
}

async function loadHoliday() {
    const doc = await deps.getDB().collection(COLLECTIONS.META).findOne({ _id: 'holiday' });
    if (doc) holidayDate = doc.date;
}

function getHoliday() { return holidayDate; }
function getHealth() { return { ...health }; }
function getLastQuotes() { return new Map(lastQuotes); }
function isTickRunning() { return tickRunning; }

module.exports = {
    init,
    tick,
    markHoliday, clearHoliday, loadHoliday, getHoliday,
    getHealth, getLastQuotes, isTickRunning,
    todayDateStr
};