'use strict';
// ======================== tsetmc.js — TSETMC API Client ========================
// ماژول ارتباط با cdn.tsetmc.com
// - جستجوی نماد (Symbol → insCode)
// - تاریخچه روزانه (۲۲ سال دیتا)
// - ریزدیتای معاملات (intermittent)
// - Option Market Watch
// - Retry, timeout, cache

const fetch = require('node-fetch');

const BASE_URL = 'https://cdn.tsetmc.com/api';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const DEFAULT_TIMEOUT = 20000;
const RETRY_DELAYS = [1000, 3000, 8000];

const CACHE_TTL_SEARCH = 24 * 60 * 60 * 1000;
const CACHE_TTL_DAILY = 60 * 60 * 1000;
const CACHE_TTL_OPTION = 60 * 1000;

const searchCache = new Map();
const dailyCache = new Map();
let optionWatchCache = { at: 0, data: null };

async function fetchWithRetry(url, retries = 3) {
    let lastErr = null;
    for (let i = 0; i <= retries; i++) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);
            const r = await fetch(url, {
                headers: { 'User-Agent': UA, 'Accept': 'application/json' },
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            if (!r.ok) throw new Error('HTTP ' + r.status);
            const text = await r.text();
            if (!text) throw new Error('پاسخ خالی');
            if (text.startsWith('<!DOCTYPE') || text.startsWith('<html')) {
                throw new Error('پاسخ HTML به‌جای JSON');
            }
            return JSON.parse(text);
        } catch (e) {
            lastErr = e;
            if (i < retries) {
                const delay = RETRY_DELAYS[Math.min(i, RETRY_DELAYS.length - 1)];
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }
    throw lastErr || new Error('fetch failed');
}

function parseGregorian(dEven) {
    if (!dEven) return null;
    const s = String(dEven);
    if (s.length !== 8) return null;
    const y = +s.slice(0, 4), m = +s.slice(4, 6), d = +s.slice(6, 8);
    if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
    return new Date(Date.UTC(y, m - 1, d, 9, 0, 0));
}

function gregorianString(date) {
    const d = date instanceof Date ? date : new Date(date);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return '' + y + m + day;
}

async function searchInstrument(query) {
    if (!query) throw new Error('query لازمه');
    const cached = searchCache.get(query);
    if (cached && Date.now() - cached.at < CACHE_TTL_SEARCH) return cached.data;
    const url = BASE_URL + '/Instrument/GetInstrumentSearch/' + encodeURIComponent(query);
    const data = await fetchWithRetry(url);
    const list = data.instrumentSearch || [];
    searchCache.set(query, { at: Date.now(), data: list });
    return list;
}

async function getDailyHistory(insCode) {
    if (!insCode) throw new Error('insCode لازمه');
    const cached = dailyCache.get(String(insCode));
    if (cached && Date.now() - cached.at < CACHE_TTL_DAILY) return cached.data;
    const url = BASE_URL + '/ClosingPrice/GetClosingPriceDailyList/' + insCode + '/0';
    const data = await fetchWithRetry(url);
    const rows = (data.closingPriceDaily || []).map(r => ({
        time: parseGregorian(r.dEven),
        open: r.priceFirst,
        high: r.priceMax,
        low: r.priceMin,
        close: r.pClosing,
        last: r.pDrCotVal,
        volume: r.qTotTran5J,
        value: r.qTotCap,
        trades: r.zTotTran,
        change: r.priceChange
    })).filter(r => r.time && r.close > 0);
    rows.sort((a, b) => a.time - b.time);
    dailyCache.set(String(insCode), { at: Date.now(), data: rows });
    return rows;
}

async function getOptionMarketWatch() {
    if (optionWatchCache.data && Date.now() - optionWatchCache.at < CACHE_TTL_OPTION) {
        return optionWatchCache.data;
    }
    const url = BASE_URL + '/Instrument/GetInstrumentOptionMarketWatch/1';
    const data = await fetchWithRetry(url);
    const rows = (data.instrumentOptMarketWatch || []).map(r => ({
        insCodeCall: r.insCode_C,
        insCodePut: r.insCode_P,
        symbolCall: r.lVal18AFC_C,
        symbolPut: r.lVal18AFC_P,
        underlyingInsCode: r.uaInsCode,
        underlyingSymbol: r.lval30_UA,
        contractSize: r.contractSize,
        strike: r.strikePrice,
        expiry: r.expiryDate,
        callLast: r.pDrCotVal_C,
        callClose: r.pClosing_C,
        callVolume: r.qTotTran5J_C,
        callTrades: r.zTotTran_C,
        putLast: r.pDrCotVal_P,
        putClose: r.pClosing_P,
        putVolume: r.qTotTran5J_P,
        putTrades: r.zTotTran_P
    }));
    optionWatchCache = { at: Date.now(), data: rows };
    return rows;
}

async function getTradeHistory(insCode, dateStr, retries = 3) {
    if (!insCode) throw new Error('insCode لازمه');
    if (!dateStr) throw new Error('dateStr لازمه (YYYYMMDD)');
    const url = BASE_URL + '/Trade/GetTradeHistory/' + insCode + '/' + dateStr + '/false';
    const data = await fetchWithRetry(url, retries);
    return data.tradeHistory || [];
}

// تبدیل معاملات تک‌تک به کندل ۱ دقیقه‌ای
function aggregateTo1m(trades, tzOffsetMinutes) {
    const offset = (typeof tzOffsetMinutes === 'number') ? tzOffsetMinutes : 210;
    const buckets = new Map();
    for (const t of trades) {
        if (!t.pTran || !t.qTitTran) continue;
        const hEven = t.hEven;
        const dEven = t.dEven;
        if (!hEven || !dEven) continue;
        const hh = Math.floor(hEven / 10000);
        const mm = Math.floor((hEven % 10000) / 100);
        const y = Math.floor(dEven / 10000);
        const mo = Math.floor((dEven % 10000) / 100);
        const d = dEven % 100;
        const utcMs = Date.UTC(y, mo - 1, d, hh, mm, 0) - offset * 60000;
        if (!buckets.has(utcMs)) {
            buckets.set(utcMs, {
                time: new Date(utcMs),
                open: t.pTran, high: t.pTran, low: t.pTran, close: t.pTran,
                volume: t.qTitTran, trades: 1
            });
        } else {
            const b = buckets.get(utcMs);
            b.high = Math.max(b.high, t.pTran);
            b.low = Math.min(b.low, t.pTran);
            b.close = t.pTran;
            b.volume += t.qTitTran;
            b.trades += 1;
        }
    }
    return Array.from(buckets.values()).sort((a, b) => a.time - b.time);
}

module.exports = {
    searchInstrument,
    getDailyHistory,
    getOptionMarketWatch,
    getTradeHistory,
    aggregateTo1m,
    parseGregorian,
    gregorianString
};