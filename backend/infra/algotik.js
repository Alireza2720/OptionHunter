'use strict';
// ============================================================
// algotik.js — proxy به Collector
// ============================================================
// Collector تنها منبع داده است. این فایل فقط HTTP proxy.

const fetch = require('node-fetch');

let BASE_URL = 'http://127.0.0.1:5000';
const DEFAULT_TIMEOUT = 120000;

function setBaseUrl(url) { if (url) BASE_URL = url; }

async function apiCall(method, path, body, timeoutMs) {
    const url = BASE_URL + path;
    const opts = {
        method,
        timeout: timeoutMs || DEFAULT_TIMEOUT,
        headers: { 'Content-Type': 'application/json' },
    };
    if (body) opts.body = JSON.stringify(body);
    const r = await fetch(url, opts);
    const text = await r.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; }
    catch { throw new Error('invalid JSON from collector'); }
    if (!r.ok) throw new Error(data.detail || data.error || `HTTP ${r.status}`);
    return data;
}

// Health
async function isOnline() {
    try {
        const r = await apiCall('GET', '/health', null, 5000);
        return r.status === 'ok';
    } catch { return false; }
}
async function getStatus() { return apiCall('GET', '/status'); }

// Symbols
async function listSymbols() { return apiCall('GET', '/symbols'); }
async function addSymbol(symbol, name) { return apiCall('POST', '/symbols', { symbol, name }); }
async function removeSymbol(symbol) { return apiCall('DELETE', `/symbols/${encodeURIComponent(symbol)}`); }
async function setSymbolEnabled(symbol, enabled) {
    return apiCall('PUT', `/symbols/${encodeURIComponent(symbol)}/enabled`, { enabled });
}

// Jobs
async function startFullBackfill(payload) { return apiCall('POST', '/jobs/full-backfill', payload); }
async function getJob(jobId) { return apiCall('GET', `/jobs/${jobId}`); }
async function listJobs(limit) { return apiCall('GET', `/jobs?limit=${limit || 30}`); }
async function cancelJob(jobId) { return apiCall('POST', `/jobs/${jobId}/cancel`); }
// Live market
async function getLiveMarket(symbol) {
    const path = symbol
        ? `/live-market/${encodeURIComponent(symbol)}`
        : '/live-market';
    const r = await apiCall('GET', path, null, 15000);
    return r.data || [];
}

async function getLogs(limit) {
    const r = await apiCall('GET', `/logs?limit=${limit || 100}`, null, 10000);
    return r.logs || [];
}

async function getSymbols() {
    return apiCall('GET', '/symbols');
}
// Data
async function getCoverage() { return apiCall('GET', '/coverage'); }
async function auditAll(days) {
    return apiCall('GET', '/audit?days=' + (days || 730), null, 300000);  // 5 min
}
async function auditOne(symbol, days) {
    return apiCall('GET', '/audit/' + encodeURIComponent(symbol) + '?days=' + (days || 730), null, 60000);
}
async function getRiskFree() { return apiCall('GET', '/risk-free'); }

// Ticker
async function controlTicker(action, intervalSec) {
    return apiCall('POST', '/ticker', { action, intervalSec });
}

module.exports = {
    setBaseUrl,
    isOnline, getStatus,
    listSymbols, addSymbol, removeSymbol, setSymbolEnabled,
    startFullBackfill, getJob, listJobs, cancelJob,
    getCoverage, getRiskFree, controlTicker,
    getLiveMarket, getLogs, getSymbols,
    getCoverage, auditAll, auditOne,
};