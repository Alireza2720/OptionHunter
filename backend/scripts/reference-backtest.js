'use strict';
// reference-backtest.js — Stage 10a v3 — CLI-args based, saves named snapshot + delta
// Usage:
//   node backend/scripts/reference-backtest.js --check [--ref-id=X]
//   node backend/scripts/reference-backtest.js --mode=option --symbols=شپنا,خودرو \
//        --strategies=smc_unicorn,tsmom --from-jalali=1402/07/23 --to-jalali=1405/07/23 \
//        --ref-id=backtest_reference_v5 --ref-version=v5-3y-real
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '..', '.env');
if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const eq = t.indexOf('=');
        if (eq < 1) continue;
        const k = t.slice(0, eq).trim();
        let v = t.slice(eq + 1).trim();
        if (v.length >= 2 && v[0] === v[v.length - 1] && (v[0] === '"' || v[0] === "'")) v = v.slice(1, -1);
        if (process.env[k] === undefined) process.env[k] = v;
    }
}

const MONGO_URI = process.env.MONGO_URI;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const BASE = 'http://127.0.0.1:3000';
const fetch = require('node-fetch');
const { MongoClient } = require(path.join(__dirname, '..', '..', 'node_modules', 'mongodb'));

function _arg(name, fallback) {
    const pref = '--' + name + '=';
    const a = process.argv.find(x => x.startsWith(pref));
    return a ? a.slice(pref.length) : fallback;
}

const CHECK_ONLY = process.argv.indexOf('--check') !== -1;
const ARG_MODE = _arg('mode', 'option');
const ARG_FROM_J = _arg('from-jalali', null);
const ARG_TO_J = _arg('to-jalali', null);
const ARG_REF_ID = _arg('ref-id', 'backtest_reference_v4');
const ARG_REF_VERSION = _arg('ref-version', 'v4-2026-10-15');
const ARG_SYMBOLS = _arg('symbols', 'شپنا,خودرو').split(',').map(s => s.trim()).filter(Boolean);
const ARG_STRATEGIES = _arg('strategies', 'smc_unicorn,tsmom').split(',').map(s => s.trim()).filter(Boolean);

function _jalaliToGreg(jStr) {
    if (!jStr) return null;
    const p = String(jStr).split(/[\/\-]/).map(Number);
    if (p.length !== 3 || p.some(isNaN)) return null;
    const [jy, jm, jd] = p;
    let jyA = jy + 1595;
    let days = -355668 + (365 * jyA) + (Math.floor(jyA / 33) * 8) + Math.floor(((jyA % 33) + 3) / 4) + jd + ((jm < 7) ? (jm - 1) * 31 : ((jm - 7) * 30) + 186);
    let gy = 400 * Math.floor(days / 146097); days %= 146097;
    if (days > 36524) { gy += 100 * Math.floor(--days / 36524); days %= 36524; if (days >= 365) days++; }
    gy += 4 * Math.floor(days / 1461); days %= 1461;
    if (days > 365) { gy += Math.floor((days - 1) / 365); days = (days - 1) % 365; }
    let gd = days + 1;
    const leap = (gy % 4 === 0 && gy % 100 !== 0) || (gy % 400 === 0);
    const sm = [0, 31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let gm; for (gm = 0; gm < 13; gm++) { if (gd <= sm[gm]) break; gd -= sm[gm]; }
    return String(gy).padStart(4, '0') + '-' + String(gm).padStart(2, '0') + '-' + String(gd).padStart(2, '0');
}

function _fmt(v, d) { return (v == null || !Number.isFinite(v)) ? '—' : Number(v).toFixed(d == null ? 2 : d); }
function _fmtPct(v) { return (v == null || !Number.isFinite(v)) ? '—' : (v >= 0 ? '+' : '') + Number(v).toFixed(2) + '%'; }

function _printSnapshot(label, doc) {
    if (!doc) { console.log(label + ': (empty)'); return; }
    console.log('');
    console.log('\u2500\u2500 ' + label + ' \u2500\u2500');
    console.log('  computedAt : ' + (doc.computedAt ? doc.computedAt.toISOString() : '?'));
    console.log('  logicVer   : ' + (doc.logicVersion || '?'));
    console.log('  refId      : ' + (doc._id || '?'));
    const s = doc.summary || {};
    console.log('  details#   : ' + (s.detailsCount || 0));
    const pf = s.portfolio || {};
    const ps = pf.stats || {};
    console.log('  portfolio  : accepted=' + (pf.acceptedTrades || 0) + '/' + (pf.totalTrades || 0) +
        ' PF=' + _fmt(ps.profitFactor) + ' ret=' + _fmtPct(ps.totalReturnPct) + ' sharpe=' + _fmt(ps.sharpe));
    const an = s.analysis || {};
    console.log('  analysis   : ' + (an.passing || 0) + '/' + (an.totalAnalyzed || 0) + ' passing');
    for (const d of (doc.perDetail || [])) {
        const st = d.stock || {}, o = d.option || {};
        console.log('    ' + d.symbol + '/' + d.strategyId +
            ' | stock N=' + (st.count || 0) + ' PF=' + _fmt(st.pf) +
            ' | opt N=' + (o.count || 0) + ' PF=' + _fmt(o.pf) + ' tot=' + _fmtPct(o.totalPnl));
    }
}

async function _run() {
    const toGreg = _jalaliToGreg(ARG_TO_J);
    const fromGreg = _jalaliToGreg(ARG_FROM_J);
    const to = toGreg ? Math.floor(new Date(toGreg + 'T23:59:59Z').getTime() / 1000) : Math.floor(Date.now() / 1000);
    const from = fromGreg ? Math.floor(new Date(fromGreg + 'T00:00:00Z').getTime() / 1000) : (to - 5 * 365 * 86400);

    console.log('[ref] refId=' + ARG_REF_ID + ' version=' + ARG_REF_VERSION);
    console.log('[ref] mode=' + ARG_MODE + ' symbols=' + ARG_SYMBOLS.join(',') + ' strategies=' + ARG_STRATEGIES.join(','));
    console.log('[ref] from=' + (ARG_FROM_J || 'default-5y') + ' (' + new Date(from * 1000).toISOString().slice(0, 10) + ')');
    console.log('[ref] to='   + (ARG_TO_J   || 'today')       + ' (' + new Date(to * 1000).toISOString().slice(0, 10) + ')');

    const body = {
        mode: ARG_MODE,
        symbols: ARG_SYMBOLS,
        strategies: ARG_STRATEGIES.map(id => ({ id })),
        dateFrom: from, dateTo: to,
        optionType: 'call', qualityLevel: 'B',
        panels: {
            analysis: { enabled: true, minTrades: 5, iterations: 3000 },
            portfolio: { enabled: true, capital: 100000000, riskPct: 1.5, maxSymPct: 20, maxTotalPct: 50 },
            wf: { enabled: false }, regime: { enabled: false }
        }
    };
    const _hdr = { 'Content-Type': 'application/json', 'x-admin-token': ADMIN_TOKEN };

    console.log('[ref] POST /api/backtest/run ...');
    const r = await fetch(BASE + '/api/backtest/run', { method: 'POST', headers: _hdr, body: JSON.stringify(body), timeout: 30000 });
    const j = await r.json();
    if (!j.jobId) throw new Error('no jobId: ' + JSON.stringify(j));
    console.log('[ref] jobId=' + j.jobId);

    const deadline = Date.now() + 30 * 60 * 1000;
    let result = null;
    while (Date.now() < deadline) {
        await new Promise(rs => setTimeout(rs, 5000));
        const rr = await fetch(BASE + '/api/backtest/results/' + j.jobId, { headers: _hdr, timeout: 30000 });
        const d = await rr.json();
        if (d.computing) continue;
        if (d.status === 'DONE' && d.result) { result = d.result; break; }
        if (d.status === 'FAILED' || d.status === 'CANCELLED') throw new Error('job ' + d.status + ': ' + (d.error || ''));
    }
    if (!result) throw new Error('timeout after 30min');

    let _logicVer = 'unknown';
    try { _logicVer = require(path.join(__dirname, '..', 'core', 'backtest')).BACKTEST_LOGIC_VERSION || 'unknown'; } catch (_) {}
    let _costVer = 'unknown';
    try { _costVer = require(path.join(__dirname, '..', 'core', 'backtest')).BACKTEST_COST_MODEL_VERSION || 'unknown'; } catch (_) {}

    const doc = {
        _id: ARG_REF_ID, version: ARG_REF_VERSION,
        logicVersion: _logicVer, costModelVersion: _costVer,
        params: { mode: body.mode, symbols: body.symbols, strategies: ARG_STRATEGIES, qualityLevel: body.qualityLevel, dateFrom: from, dateTo: to },
        summary: {
            mode: result.mode,
            detailsCount: (result.details || []).length,
            portfolio: result.portfolio ? {
                acceptedTrades: result.portfolio.acceptedTrades,
                totalTrades: result.portfolio.totalTrades,
                rejectedTrades: result.portfolio.rejectedTrades,
                stats: result.portfolio.stats || null
            } : null,
            analysis: result.analysis ? { totalAnalyzed: result.analysis.totalAnalyzed, passing: result.analysis.passing } : null
        },
        perDetail: (result.details || []).map(d => ({
            symbol: d.symbol, strategyId: d.strategyId,
            stock: d.stockStats ? { count: d.stockStats.count, winRate: d.stockStats.winRate, totalPnl: d.stockStats.totalPnl, pf: d.stockStats.profitFactor, sharpe: d.stockStats.sharpe, maxDD: d.stockStats.maxDrawdownPct } : null,
            option: d.optionStats ? { count: d.optionStats.count, winRate: d.optionStats.winRate, totalPnl: d.optionStats.totalPnl, pf: d.optionStats.profitFactor, sharpe: d.optionStats.sharpe, maxDD: d.optionStats.maxDrawdownPct } : null
        })),
        computedAt: new Date(), jobId: j.jobId
    };
    const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 8000 });
    await client.connect();
    await client.db('trading_bot').collection('meta').replaceOne({ _id: ARG_REF_ID }, doc, { upsert: true });
    await client.close();

    console.log('[ref] SAVED ' + ARG_REF_ID);
    console.log('[ref] DONE');
    _printSnapshot(ARG_REF_ID, doc);
}

async function _check() {
    const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 8000 });
    await client.connect();
    const db = client.db('trading_bot');
    const doc = await db.collection('meta').findOne({ _id: ARG_REF_ID });
    await client.close();
    if (!doc) { console.log('EMPTY: ' + ARG_REF_ID); return; }
    _printSnapshot(ARG_REF_ID, doc);
}

(async () => {
    if (CHECK_ONLY) return _check();
    return _run();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
