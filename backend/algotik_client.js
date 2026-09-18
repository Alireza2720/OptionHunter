'use strict';
// ======================== algotik_client.js ========================
// ارتباط با Python Collector Service (algotik-tse)
// روی localhost:5000

const fetch = require('node-fetch');

const BASE_URL = process.env.ALGOTIK_URL || 'http://127.0.0.1:5000';
const DEFAULT_TIMEOUT = 30 * 60 * 1000; // 30 دقیقه (برای backfill کامل)

async function apiCall(method, path, body, timeout = 60000) {
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
        const data = JSON.parse(text);
        if (!r.ok) throw new Error(data.detail || data.error || 'HTTP ' + r.status);
        return data;
    } catch (e) {
        clearTimeout(tid);
        if (e.name === 'AbortError') throw new Error('Timeout — collector پاسخ نداد');
        throw e;
    }
}

async function isOnline() {
    try {
        const r = await apiCall('GET', '/health', null, 5000);
        return r.status === 'ok';
    } catch (e) {
        return false;
    }
}

async function getStatus() {
    return apiCall('GET', '/status', null, 10000);
}

async function getLogs(limit = 50) {
    return apiCall('GET', '/logs?limit=' + limit, null, 10000);
}

async function fetchStocks(symbols, months = 6) {
    return apiCall('POST', '/backfill/stocks/wait', { symbols, months }, DEFAULT_TIMEOUT);
}

async function fetchOptions(underlyings) {
    return apiCall('POST', '/backfill/options', { underlyings }, DEFAULT_TIMEOUT);
}

async function fetchOptionsDaily(underlyings) {
    return apiCall('POST', '/backfill/options-daily', { underlyings }, DEFAULT_TIMEOUT);
}

async function backfillAll(months = 6, withOptions = true) {
    return apiCall('POST', '/backfill/all', { months, with_options: withOptions }, DEFAULT_TIMEOUT);
}

module.exports = {
    isOnline,
    getStatus,
    getLogs,
    fetchStocks,
    fetchOptions,
    fetchOptionsDaily,
    backfillAll
};