'use strict';
// ======================== algotik_client.js ========================
// ارتباط با Python Collector Service (algotik-tse) روی localhost:5000

const fetch = require('node-fetch');

const BASE_URL = process.env.ALGOTIK_URL || 'http://127.0.0.1:5000';
const DEFAULT_TIMEOUT = 60 * 60 * 1000; // 1 ساعت برای backfill سنگین

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
        if (!r.ok) throw new Error((data.detail && (data.detail.error || data.detail)) || data.error || 'HTTP ' + r.status);
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
    } catch (e) { return false; }
}

async function getStatus() { return apiCall('GET', '/status', null, 10000); }
async function getLogs(limit = 50) { return apiCall('GET', '/logs?limit=' + limit, null, 10000); }

/**
 * دریافت دیتای سهام — با پشتیبانی از skip-existing
 * گزینه‌ها:
 *   symbols: آرایه نمادها
 *   months: تعداد ماه (اگر startDate داده نشه)
 *   startDate: تاریخ شروع (YYYY-MM-DD) برای skip-existing سمت Python
 *   wait: اگر true، سینکرون (ممکنه timeout بده)
 */
async function fetchStocks(symbols, months = 6, opts = {}) {
    const body = { symbols, months };
    if (opts.startDate) body.start_date = opts.startDate;
    if (opts.skipExisting !== false) body.skip_existing = true;
    const path = opts.wait ? '/backfill/stocks/wait' : '/backfill/stocks';
    return apiCall('POST', path, body, opts.wait ? DEFAULT_TIMEOUT : 30000);
}

async function fetchOptions(underlyings, opts = {}) {
    const body = { underlyings };
    if (opts.skipExisting !== false) body.skip_existing = true;
    return apiCall('POST', '/backfill/options', body, DEFAULT_TIMEOUT);
}

async function startOptionsDailyJob(underlyings, force = false) {
    return apiCall('POST', '/options/daily-job', { underlyings, force }, 10000);
}

async function getJobStatus(jobId) {
    return apiCall('GET', '/jobs/' + jobId, null, 10000);
}

async function listJobs(limit = 20) {
    return apiCall('GET', '/jobs?limit=' + limit, null, 10000);
}

async function backfillAll(months = 6, withOptions = true) {
    return apiCall('POST', '/backfill/all', { months, with_options: withOptions }, DEFAULT_TIMEOUT);
}

async function fetchChart(symbol, interval = '1min', months = 6) {
    const qs = new URLSearchParams({ interval, months: String(months) }).toString();
    return apiCall('GET', '/chart/' + encodeURIComponent(symbol) + '?' + qs, null, 60000);
}

async function fetchOptionsHistoryBulk(symbol, months = 6, opts = {}) {
    const body = { symbol, months };
    if (opts.skipExisting !== false) body.skip_existing = true;
    return apiCall('POST', '/options/history', body, 5 * 60 * 1000);
}

/**
 * Cancel a job on the Python side
 */
async function cancelJob(jobId) {
    try { return await apiCall('POST', '/jobs/' + jobId + '/cancel', null, 10000); }
    catch (e) { return { ok: false, error: e.message }; }
}

module.exports = {
    isOnline, getStatus, getLogs,
    fetchStocks, fetchOptions, backfillAll,
    startOptionsDailyJob, getJobStatus, listJobs, cancelJob,
    fetchChart, fetchOptionsHistoryBulk
};