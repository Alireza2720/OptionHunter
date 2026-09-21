'use strict';
// تنظیمات پویا که از فرانت قابل تغییرند و در MongoDB ذخیره می‌شوند.

let deps = null;
function init(d) { deps = d; }

const DEFAULTS = {
    // ---- بازه‌ی ورود ----
    ENTRY_START: '09:30',
    ENTRY_END: '12:00',

    // ---- کارمزد و نرخ ----
    OPTION_FEE_BUY: 0.0012,
    OPTION_FEE_SELL: 0.0012,
    RISK_FREE_RATE: 0.23,

    // ---- مدیریت سرمایه — پایه ----
    TOTAL_CAPITAL: 100000000,
    RISK_PER_TRADE_PCT: 1.5,
    MAX_SYMBOL_EXPOSURE_PCT: 20,
    MAX_TOTAL_EXPOSURE_PCT: 50,
    MIN_CASH_RESERVE_PCT: 20,
    MAX_POSITION_SIZE: 10,

    // ---- لایه ۱: ضریب قدرت سیگنال (بر اساس تعداد تأیید) ----
    SIGNAL_FACTOR_1: 0.7,      // لیدر تنها
    SIGNAL_FACTOR_2: 1.0,      // +۱ تأیید
    SIGNAL_FACTOR_3: 1.3,      // +۲ تأیید
    SIGNAL_FACTOR_4PLUS: 1.5,  // +۳ یا بیشتر

    // ---- لایه ۲: ضریب کیفیت قرارداد (سطح A+/A/B/C/D) ----
    LEVEL_FACTOR_A_PLUS: 1.0,
    LEVEL_FACTOR_A: 0.8,
    LEVEL_FACTOR_B: 0.5,
    LEVEL_FACTOR_C: 0.25,
    LEVEL_FACTOR_D: 0.1,

    // ---- لایه ۳: ضریب IV ----
    IV_FACTOR_MIN: 0.6,
    IV_FACTOR_MAX: 1.2,
    IV_FACTOR_BASE: 1.1,

    // ---- آستانه‌ی زمانی Confluence ----
    CONFLUENCE_TIME_WINDOW: 0,  // 0 = غیرفعال، در غیر این صورت ثانیه

    // ---- چند تأییدکننده ----
    MULTI_CONFIRMER_MIN: 2,
    MULTI_CONFIRMER_TIME_WINDOW: 600,  // ۱۰ دقیقه

    // ---- فیلتر هدف سهم ----
    MIN_TARGET_PCT: 4.5  // حداقل درصد هدف سهم برای سیگنال آپشن
};

let values = { ...DEFAULTS };
let strategyDefaults = {};  // { strategyId: {params...} }

// 🆕 Risk-free dynamic cache (از risk-free.job)
let cachedRiskFreeRate = null;
let cachedRiskFreeDate = null;

function setRiskFreeRate(rate, date) {
    if (Number.isFinite(rate) && rate > 0) {
        cachedRiskFreeRate = rate;
        cachedRiskFreeDate = date || new Date().toISOString().slice(0, 10);
    }
}

function getRiskFreeRate() {
    if (Number.isFinite(cachedRiskFreeRate) && cachedRiskFreeRate > 0) {
        return cachedRiskFreeRate;
    }
    return values.RISK_FREE_RATE || 0.23;
}

function getRiskFreeMeta() {
    return {
        rate: cachedRiskFreeRate,
        date: cachedRiskFreeDate,
        fallback: !Number.isFinite(cachedRiskFreeRate),
    };
}

function envDefaults() {
    const num = (v, fallback) => { const n = parseFloat(String(v == null ? '' : v).trim()); return Number.isFinite(n) ? n : fallback; };
    const time = (v, fallback) => { const s = String(v == null ? '' : v).trim(); return /^\d{1,2}:\d{2}$/.test(s) ? s : fallback; };
    return {
        ENTRY_START: time(process.env.ENTRY_START, DEFAULTS.ENTRY_START),
        ENTRY_END: time(process.env.ENTRY_END, DEFAULTS.ENTRY_END),
        OPTION_FEE_BUY: num(process.env.OPTION_FEE_BUY, DEFAULTS.OPTION_FEE_BUY),
        OPTION_FEE_SELL: num(process.env.OPTION_FEE_SELL, DEFAULTS.OPTION_FEE_SELL),
        RISK_FREE_RATE: num(process.env.RISK_FREE_RATE, DEFAULTS.RISK_FREE_RATE)
    };
}

async function load() {
    const base = envDefaults();
    try {
        const doc = await deps.getDB().collection('meta').findOne({ _id: 'trading_settings' });
        values = { ...DEFAULTS, ...base, ...((doc && doc.values) || {}) };
        const sd = await deps.getDB().collection('meta').findOne({ _id: 'strategy_defaults' });
        strategyDefaults = (sd && sd.values) || {};
    } catch (e) {
        values = { ...DEFAULTS, ...base };
        strategyDefaults = {};
    }
    return values;
}

async function save(partial) {
    const clean = {};
    for (const k of Object.keys(DEFAULTS)) {
        if (partial[k] === undefined || partial[k] === null || partial[k] === '') continue;
        if (k === 'ENTRY_START' || k === 'ENTRY_END') {
            const s = String(partial[k]).trim();
            if (!/^\d{1,2}:\d{2}$/.test(s)) throw new Error(`${k} باید به شکل HH:MM باشد`);
            clean[k] = s;
        } else {
            const n = parseFloat(partial[k]);
            if (!Number.isFinite(n) || n < 0) throw new Error(`${k} باید عدد نامنفی باشد`);
            clean[k] = n;
        }
    }
    const merged = { ...values, ...clean };
    await deps.getDB().collection('meta').updateOne(
        { _id: 'trading_settings' },
        { $set: { values: merged } },
        { upsert: true }
    );
    return load();
}

const toMin = s => { const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0); };
function get() { return values; }
function entryWindow() {
    return { start: toMin(values.ENTRY_START), end: toMin(values.ENTRY_END), startStr: values.ENTRY_START, endStr: values.ENTRY_END };
}

// ---- مدیریت سرمایه — مقادیر پایه ----
function capital() { return values.TOTAL_CAPITAL || 0; }
function riskAmount() { return capital() * (values.RISK_PER_TRADE_PCT / 100); }
function maxSymbolExposure() { return capital() * (values.MAX_SYMBOL_EXPOSURE_PCT / 100); }
function maxTotalExposure() { return capital() * (values.MAX_TOTAL_EXPOSURE_PCT / 100); }
function minCashReserve() { return capital() * (values.MIN_CASH_RESERVE_PCT / 100); }

// ---- مدیریت سرمایه — ضرایب سه‌لایه ----
function signalFactor(confluence) {
    const c = Math.max(1, Number(confluence) || 1);
    if (c >= 4) return values.SIGNAL_FACTOR_4PLUS;
    if (c === 3) return values.SIGNAL_FACTOR_3;
    if (c === 2) return values.SIGNAL_FACTOR_2;
    return values.SIGNAL_FACTOR_1;
}
function levelFactor(level) {
    const L = String(level || '').toUpperCase();
    if (L === 'A+') return values.LEVEL_FACTOR_A_PLUS;
    if (L === 'A') return values.LEVEL_FACTOR_A;
    if (L === 'B') return values.LEVEL_FACTOR_B;
    if (L === 'C') return values.LEVEL_FACTOR_C;
    if (L === 'D') return values.LEVEL_FACTOR_D;
    return 0.5;
}
function ivFactor(ivHv) {
    if (!ivHv || ivHv <= 0) return 1;
    const raw = values.IV_FACTOR_BASE / ivHv;
    return Math.min(values.IV_FACTOR_MAX, Math.max(values.IV_FACTOR_MIN, raw));
}
// 🆕 ضریب عمق دیتا — نمادهای با دیتای کم، وزن کم می‌گیرن
function dataDepthFactor(days) {
    if (!Number.isFinite(days) || days <= 0) return 0.5;   // نامعلوم → نصف
    if (days >= 60) return 1.0;   // دیتای کامل
    if (days >= 30) return 0.8;
    if (days >= 14) return 0.5;
    return 0.3;                    // خیلی کم → ۳۰٪
}

// ---- آستانه‌ی زمانی Confluence ----
function confluenceTimeWindow() { return values.CONFLUENCE_TIME_WINDOW || 0; }

// ---- چند تأییدکننده ----
function multiConfirmerMin() { return values.MULTI_CONFIRMER_MIN || 2; }
function multiConfirmerWindow() { return values.MULTI_CONFIRMER_TIME_WINDOW || 600; }

// ---- فیلتر هدف سهم ----
function minTargetPct() { return values.MIN_TARGET_PCT || 3.5; }

// ---- پیش‌فرض‌های استراتژی ----
function getStrategyDefaults(strategyId) {
    return { ...(strategyDefaults[strategyId] || {}) };
}
function getAllStrategyDefaults() {
    return JSON.parse(JSON.stringify(strategyDefaults));
}
async function saveStrategyDefaults(overrides) {
    // overrides: { strategyId: { param: value, ... }, ... }
    strategyDefaults = overrides || {};
    await deps.getDB().collection('meta').updateOne(
        { _id: 'strategy_defaults' },
        { $set: { values: strategyDefaults } },
        { upsert: true }
    );
    return strategyDefaults;
}
async function resetStrategyDefaults(strategyId) {
    if (strategyId) delete strategyDefaults[strategyId];
    else strategyDefaults = {};
    await deps.getDB().collection('meta').updateOne(
        { _id: 'strategy_defaults' },
        { $set: { values: strategyDefaults } },
        { upsert: true }
    );
    return strategyDefaults;
}

module.exports = {
    init, load, save, get, entryWindow, DEFAULTS,
    capital, riskAmount, maxSymbolExposure, maxTotalExposure, minCashReserve,
    signalFactor, levelFactor, ivFactor,
    confluenceTimeWindow, multiConfirmerMin, multiConfirmerWindow,
    minTargetPct,
    getStrategyDefaults, getAllStrategyDefaults, saveStrategyDefaults, resetStrategyDefaults,
    setRiskFreeRate, getRiskFreeRate, getRiskFreeMeta,
    signalFactor, levelFactor, ivFactor, dataDepthFactor,
};