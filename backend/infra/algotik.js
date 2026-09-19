'use strict';
// ============================================================
// algotik.js — کلاینت AlgoTik Collector (جایگزین BrsApi)
// ============================================================
// Collector روی http://127.0.0.1:5000 اجرا می‌شود (Python).
// این ماژول یک HTTP wrapper نازک است + کش سبک + retry.
// ============================================================

const fetch = require('node-fetch');
const { CACHE_TTL } = require('../config/constants');
const cache = require('./cache');

let BASE_URL = 'http://127.0.0.1:5000';
const DEFAULT_TIMEOUT = 60 * 1000;           // 1 دقیقه
const LONG_TIMEOUT = 60 * 60 * 1000;         // 1 ساعت (برای backfill)

// کش کوتاه برای health (جلوگیری از hammering)
const healthCache = cache.memory(1, CACHE_TTL.LIVE_MARKET);
// کش live market
const liveMarketCache = cache.memory(1, CACHE_TTL.LIVE_MARKET);

function setBaseUrl(url) { if (url) BASE_URL = url; }

// ---------- Low-level HTTP ----------
async function apiCall(method, path, body, timeout = DEFAULT_TIMEOUT) {
    const url = BASE_URL + path;
    const opts = {
        method,
        timeout,
        headers: { 'Content-Type': 'application/json' }
    };
    if (body) opts.body = JSON.stringify(body);

    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), timeout);
    opts.signal = controller.signal;

    try {
        const r = await fetch(url, opts);
        clearTimeout(tid);
        const text = await r.text();
        if (!text) throw new Error('پاسخ خالی');
        let data;
        try { data = JSON.parse(text); }
        catch { throw new Error('پاسخ JSON نامعتبر از Collector'); }

        if (!r.ok) {
            const msg = (data && data.detail && (data.detail.error || data.detail))
                || (data && data.error)
                || `HTTP ${r.status}`;
            throw new Error(msg);
        }
        return data;
    } catch (e) {
        clearTimeout(tid);
        if (e.name === 'AbortError') throw new Error('Timeout - Collector پاسخ نداد');
        throw e;
    }
}

// ---------- Health / Status ----------
async function isOnline(force = false) {
    if (!force) {
        const c = healthCache.get('health');
        if (c !== null) return c;
    }
    try {
        const r = await apiCall('GET', '/health', null, 5000);
        const ok = r.status === 'ok';
        healthCache.set('health', ok);
        return ok;
    } catch (_) {
        healthCache.set('health', false);
        return false;
    }
}

async function getStatus() {
    return apiCall('GET', '/status', null, 10000);
}

async function getLogs(limit = 50) {
    return apiCall('GET', '/logs?limit=' + limit, null, 10000);
}

// ---------- Live Market (جایگزین BrsApi AllSymbols) ----------
async function getLiveMarket(force = false) {
    if (!force) {
        const c = liveMarketCache.get('live');
        if (c) return c;
    }
    const data = await apiCall('GET', '/live-market', null, 20000);
    liveMarketCache.set('live', data);
    return data;
}

async function getSymbols() {
    return apiCall('GET', '/symbols', null, 20000);
}

async function getDailyHistory(symbol, months = 24) {
    const qs = new URLSearchParams({ months: String(months) }).toString();
    return apiCall('GET', `/daily-history/${encodeURIComponent(symbol)}?${qs}`, null, 60000);
}

// ---------- Backfill ----------
async function fetchStocks(symbols, months = 24, opts = {}) {
    const body = { symbols, months };
    if (opts.startDate) body.start_date = opts.startDate;
    if (opts.skipExisting !== false) body.skip_existing = true;
    const path = opts.wait ? '/backfill/stocks/wait' : '/backfill/stocks';
    return apiCall('POST', path, body, opts.wait ? LONG_TIMEOUT : 30000);
}

async function fetchOptions(underlyings, opts = {}) {
    const body = { underlyings };
    if (opts.skipExisting !== false) body.skip_existing = true;
    return apiCall('POST', '/backfill/options', body, LONG_TIMEOUT);
}

async function fetchOptionsHistoryBulk(symbol, months = 24, opts = {}) {
    const body = { symbol, months };
    if (opts.skipExisting !== false) body.skip_existing = true;
    return apiCall('POST', '/options/history', body, 5 * 60 * 1000);
}

async function backfillAll(months = 24, withOptions = true) {
    return apiCall('POST', '/backfill/all', { months, with_options: withOptions }, LONG_TIMEOUT);
}

// ---------- Jobs ----------
async function startOptionsDailyJob(underlyings, force = false) {
    return apiCall('POST', '/options/daily-job', { underlyings, force }, 10000);
}

async function fetchOptionsDaily(underlyings) {
    return startOptionsDailyJob(underlyings, false);
}

async function getJobStatus(jobId) {
    return apiCall('GET', '/jobs/' + jobId, null, 10000);
}

async function listJobs(limit = 20) {
    return apiCall('GET', '/jobs?limit=' + limit, null, 10000);
}

async function cancelJob(jobId) {
    try {
        return await apiCall('POST', '/jobs/' + jobId + '/cancel', null, 10000);
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

// ---------- Chart ----------
async function fetchChart(symbol, interval = '1min', months = 24) {
    const qs = new URLSearchParams({ interval, months: String(months) }).toString();
    return apiCall('GET', '/chart/' + encodeURIComponent(symbol) + '?' + qs, null, 60000);
}

// ---------- Cache helpers ----------
function invalidateLiveCache() {
    liveMarketCache.del('live');
}

function invalidateHealth() {
    healthCache.del('health');
}

module.exports = {
    setBaseUrl,
    isOnline, getStatus, getLogs,
    getLiveMarket, getSymbols, getDailyHistory,
    fetchStocks, fetchOptions, fetchOptionsHistoryBulk, backfillAll,
    startOptionsDailyJob, fetchOptionsDaily, getJobStatus, listJobs, cancelJob,
    fetchChart,
    invalidateLiveCache, invalidateHealth
};