'use strict';
// ============================================================
// options-chain.js — کلاینت Optionschool24 (زنجیره آپشن زنده)
// ============================================================
// این تنها منبع خارجی است که باقی می‌ماند چون جایگزینی ندارد.
// داده در حافظه cache می‌شود تا از هجوم درخواست جلوگیری شود.
// ============================================================

const fetch = require('node-fetch');
const { CACHE_TTL } = require('../config/constants');
const cache = require('./cache');

let OPTIONS_URL = 'https://s3.optionschool24.com/last?type=3';
let cacheTtlMs = CACHE_TTL.OPTION_CHAIN;

const chainCache = cache.memory(1, cacheTtlMs);
const CACHE_KEY = 'chain';

function setUrl(url) { if (url) OPTIONS_URL = url; }
function setCacheTtl(ms) { if (ms > 0) cacheTtlMs = ms; }

// ---------- Normalization ----------
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

// ---------- Parsing ----------
function parseContract(r) {
    const fname = r.fname || '';
    const isPut = /^اخت[يی]ارف/.test(fname);
    const isCallName = /^اخت[يی]ارخ/.test(fname);

    return {
        symbol: r.name,
        fullName: fname,
        isin: r.co,
        isCall: isCallName || (!isPut && r.type === 1),
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
        bidVol: first(r.b_volume),
        ask: first(r.s_price),
        askVol: first(r.s_volume),
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
        statusText: r.status_text || ''
    };
}

// ---------- Fetch ----------
async function fetchChain(maxAgeMs = cacheTtlMs) {
    if (maxAgeMs > 0) {
        const cached = chainCache.get(CACHE_KEY);
        if (cached && Array.isArray(cached.list) && cached.list.length) {
            const age = Date.now() - cached.at;
            if (age < maxAgeMs) return cached.list;
        }
    }

    const r = await fetch(OPTIONS_URL, {
        headers: {
            'User-Agent': 'Mozilla/5.0',
            Accept: 'application/json'
        },
        timeout: 30000
    });
    if (!r.ok) throw new Error(`Options API HTTP ${r.status}`);
    const data = await r.json();
    if (!Array.isArray(data)) throw new Error('پاسخ نامعتبر از API آپشن');

    const list = data.map(parseContract).filter(c => c.symbol && c.strike > 0);
    chainCache.set(CACHE_KEY, { at: Date.now(), list });
    return list;
}

function chainAge() {
    const cached = chainCache.get(CACHE_KEY);
    return cached ? Math.round((Date.now() - cached.at) / 1000) : null;
}

function clearCache() { chainCache.del(CACHE_KEY); }

module.exports = {
    setUrl, setCacheTtl,
    fetchChain, chainAge, clearCache,
    // helpers برای استفاده در core
    norm, num, first, asDecimal, parseContract
};