'use strict';
// ============================================================
// options-chain.js — Proxy to Collector's /chain/enriched
// ============================================================
// After Phase 2 migration, this module no longer fetches
// optionschool24.com. It proxies the collector's TSETMC-based
// enriched chain, with local in-memory caching.
//
// Output format is compatible with the legacy optionschool24
// response, so existing callers don't need changes.
// ============================================================

const fetch = require('node-fetch');
const { CACHE_TTL } = require('../config/constants');

// Collector base URL (env ALGOTIK_URL or default)
let COLLECTOR_URL = process.env.ALGOTIK_URL || 'http://127.0.0.1:5000';

// Keep OPTIONS_API_URL as a fallback for safety during transition
const FALLBACK_URL = process.env.OPTIONS_API_URL || '';

let cacheTtlMs = CACHE_TTL.OPTION_CHAIN || 60000;
let pricingModel = process.env.PRICING_MODEL || 'bsm';

// Simple in-memory cache
const cache = { at: 0, list: null, meta: null };

function setUrl(url) {
    if (url) COLLECTOR_URL = url;
}
function setCacheTtl(ms) {
    if (ms > 0) cacheTtlMs = ms;
}
function setPricingModel(m) {
    if (m === 'bsm' || m === 'heston') pricingModel = m;
}

// ---------- Normalization (kept from old options-chain.js) ----------
const norm = s => String(s || '')
    .replace(/ي/g, 'ی').replace(/ك/g, 'ک')
    .replace(/[\u200c\u200e\u200f\s\u00a0]/g, '')
    .trim();

const num = v => {
    const n = parseFloat(String(v ?? '').replace(/,/g, ''));
    return Number.isFinite(n) ? n : 0;
};
const first = s => num(String(s || '').split('/')[0]);
const asDecimal = v => {
    const n = num(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n > 3 ? n / 100 : n;
};

// ---------- Raw fetch from collector ----------
async function fetchFromCollector(maxAgeMs) {
    const fresh = maxAgeMs === 0;
    const url = `${COLLECTOR_URL.replace(/\/+$/, '')}/chain/enriched${fresh ? '?fresh=1' : ''}${fresh ? '&' : '?'}model=${pricingModel}`;
    const r = await fetch(url, {
        headers: { 'Accept': 'application/json' },
        timeout: 180000,  // 3min — compute can take up to ~90s on busy server
    });
    if (!r.ok) throw new Error(`collector /chain/enriched HTTP ${r.status}`);
    const data = await r.json();
    if (!Array.isArray(data)) throw new Error('collector response is not an array');
    return data;
}

// ---------- Fallback: direct optionschool24 (only if explicitly configured) ----------
async function fetchFromFallback() {
    if (!FALLBACK_URL) throw new Error('no fallback configured');
    const r = await fetch(FALLBACK_URL, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
        timeout: 60000,  // fallback — 60s
    });
    if (!r.ok) throw new Error(`fallback HTTP ${r.status}`);
    const data = await r.json();
    if (!Array.isArray(data)) throw new Error('fallback response is not an array');
    return data;
}

// ---------- Parse a row from collector (already optionschool24-shaped) ----------
function parseContract(r) {
    const fname = r.fname || '';
    const isPut = /^اخت[يی]ارف/.test(fname);
    const isCallName = /^اخت[يی]ارخ/.test(fname);
    const isCall = r.isCall === true || isCallName || (!isPut && r.type === 1);

    return {
        symbol: r.name,
        fullName: fname,
        isin: r.co,
        isCall,
        underlying: norm(r.basis_name),
        underlyingRaw: r.basis_name,
        S: num(r.basis),
        strike: num(r.emal),
        expiry: r.to_date,
        daysLeft: num(r.day_left),
        tradingDaysLeft: num(r.days_left_actual),
        last: num(r.close),
        final: num(r.final),
        yday: num(r.yday),
        bid: first(r.b_price),
        bidVol: num(r.b_volume) || first(r.b_volume),
        ask: first(r.s_price),
        askVol: num(r.s_volume) || first(r.s_volume),
        volume: num(r.Tvolume),
        value: num(r.Tvalue),
        trades: num(r.Tcount),
        oi: num(r.op),
        oiChange: num(r.op_change),
        bsApi: num(r.black_sholes),
        ivApi: asDecimal(r.imp),
        hvApi: asDecimal(r.sigma),
        deltaApi: num(r.delta),
        gammaApi: num(r.gamma),
        thetaApi: num(r.theta),
        vegaApi: num(r.vega),
        size: num(r.size) || 1000,
        margin: num(r.tazmin),
        intrinsic: num(r.value),
        statusText: r.status_text || '',
        pricingModel: r.pricingModel || 'bsm',
        source: r.source || 'tsetmc_enriched',
    };
}

// ---------- Public API (kept compatible with callers) ----------
async function fetchChain(maxAgeMs = cacheTtlMs) {
    const now = Date.now();
    if (maxAgeMs > 0 && cache.list && (now - cache.at) < maxAgeMs) {
        return cache.list;
    }

    let raw = null;
    let source = 'collector';

    // Try collector first
    try {
        raw = await fetchFromCollector(maxAgeMs);
    } catch (e) {
        if (FALLBACK_URL) {
            try {
                raw = await fetchFromFallback();
                source = 'fallback';
            } catch (e2) {
                throw new Error(`both collector and fallback failed: ${e.message} / ${e2.message}`);
            }
        } else {
            throw e;
        }
    }

    const list = raw.map(parseContract).filter(c => c.symbol && c.strike > 0);

    cache.at = now;
    cache.list = list;
    cache.meta = { at: new Date(), source, count: list.length, pricingModel };

    return list;
}

function chainAge() {
    return cache.list ? Math.round((Date.now() - cache.at) / 1000) : null;
}

function clearCache() {
    cache.list = null;
    cache.at = 0;
    cache.meta = null;
}

function getMeta() {
    return cache.meta;
}

module.exports = {
    setUrl, setCacheTtl, setPricingModel,
    fetchChain, chainAge, clearCache, getMeta,
    // helpers
    norm, num, first, asDecimal, parseContract,
};