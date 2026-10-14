'use strict';
// reference-backtest.js — v4 — canonical backtest + saves snapshot + 3-way delta
// Usage:
//   node backend/scripts/reference-backtest.js           # run + save v4 + compare
//   node backend/scripts/reference-backtest.js --check   # show v2/v3/v4 + delta
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

const CHECK_ONLY = process.argv.indexOf('--check') !== -1;
const REF_ID = 'backtest_reference_v4';
const REF_VERSION = 'v4-2026-10-15';

function _fmt(v, d) { return (v === null || v === undefined || !Number.isFinite(v)) ? '—' : Number(v).toFixed(d == null ? 2 : d); }
function _fmtPct(v) { return (v === null || v === undefined || !Number.isFinite(v)) ? '—' : (v >= 0 ? '+' : '') + Number(v).toFixed(2) + '%'; }

function _printSnapshot(label, doc) {
    if (!doc) { console.log(label + ': (empty)'); return; }
    console.log('');
    console.log('\u2500\u2500 ' + label + ' \u2500\u2500');
    console.log('  computedAt : ' + (doc.computedAt ? doc.computedAt.toISOString() : '?'));
    console.log('  logicVer   : ' + (doc.logicVersion || '?'));
    const s = doc.summary || {};
    console.log('  details#   : ' + (s.detailsCount || 0));
    const pf = s.portfolio || {};
    const pstats = pf.stats || {};
    console.log('  portfolio  : accepted=' + (pf.acceptedTrades || 0) + '/' + (pf.totalTrades || 0) +
                ' PF=' + _fmt(pstats.profitFactor) +
                ' ret=' + _fmtPct(pstats.totalReturnPct) +
                ' sharpe=' + _fmt(pstats.sharpe));
    const an = s.analysis || {};
    console.log('  analysis   : ' + (an.passing || 0) + '/' + (an.totalAnalyzed || 0) + ' passing');
    for (const d of (doc.perDetail || [])) {
        const o = d.option || {};
        const st = d.stock || {};
        console.log('    ' + d.symbol + '/' + d.strategyId +
                    ' | stock N=' + (st.count || 0) + ' PF=' + _fmt(st.pf) + ' WR=' + _fmt(st.winRate, 1) + '%' +
                    ' shrp=' + _fmt(st.sharpe) +
                    ' | opt N=' + (o.count || 0) + ' PF=' + _fmt(o.pf) + ' tot=' + _fmtPct(o.totalPnl));
    }
}

function _printDelta(v2, v3, v4) {
    if (!v2 || !v4) {
        console.log('\n[delta] v2 or v4 missing — cannot compare');
        return;
    }
    console.log('');
    console.log('══════════════════════════════════════════════════');
    console.log('  DELTA — v2 (baseline) → v3 → v4 (final)');
    console.log('══════════════════════════════════════════════════');
    const p2 = (v2.summary && v2.summary.portfolio) || {};
    const p3 = (v3 && v3.summary && v3.summary.portfolio) || {};
    const p4 = (v4.summary && v4.summary.portfolio) || {};
    const s2 = p2.stats || {}, s3 = p3.stats || {}, s4 = p4.stats || {};
    console.log('  portfolio accepted  : ' + (p2.acceptedTrades || 0) + ' → ' + (p3.acceptedTrades || 0) + ' → ' + (p4.acceptedTrades || 0));
    console.log('  portfolio PF        : ' + _fmt(s2.profitFactor) + ' → ' + _fmt(s3.profitFactor) + ' → ' + _fmt(s4.profitFactor));
    console.log('  portfolio return    : ' + _fmtPct(s2.totalReturnPct) + ' → ' + _fmtPct(s3.totalReturnPct) + ' → ' + _fmtPct(s4.totalReturnPct));
    console.log('  portfolio sharpe    : ' + _fmt(s2.sharpe) + ' → ' + _fmt(s3.sharpe) + ' → ' + _fmt(s4.sharpe));
    const a2 = (v2.summary && v2.summary.analysis) || {};
    const a3 = (v3 && v3.summary && v3.summary.analysis) || {};
    const a4 = (v4.summary && v4.summary.analysis) || {};
    console.log('  analysis passing    : ' + (a2.passing || 0) + '/' + (a2.totalAnalyzed || 0) +
                ' → ' + (a3.passing || 0) + '/' + (a3.totalAnalyzed || 0) +
                ' → ' + (a4.passing || 0) + '/' + (a4.totalAnalyzed || 0));
    console.log('');
    const _keyOf = d => d.symbol + '/' + d.strategyId;
    const _idx = doc => { const m = {}; for (const d of ((doc && doc.perDetail) || [])) m[_keyOf(d)] = d; return m; };
    const m2 = _idx(v2), m3 = _idx(v3), m4 = _idx(v4);
    const all = new Set([...Object.keys(m2), ...Object.keys(m3), ...Object.keys(m4)]);
    for (const k of all) {
        const d2 = m2[k] || { stock: {}, option: {} };
        const d3 = m3[k] || { stock: {}, option: {} };
        const d4 = m4[k] || { stock: {}, option: {} };
        console.log('  \u25b8 ' + k);
        console.log('    stock N    : ' + (d2.stock.count || 0) + ' → ' + (d3.stock.count || 0) + ' → ' + (d4.stock.count || 0));
        console.log('    stock PF   : ' + _fmt(d2.stock.pf) + ' → ' + _fmt(d3.stock.pf) + ' → ' + _fmt(d4.stock.pf));
        console.log('    stock WR   : ' + _fmt(d2.stock.winRate, 1) + '% → ' + _fmt(d3.stock.winRate, 1) + '% → ' + _fmt(d4.stock.winRate, 1) + '%');
        console.log('    stock ret  : ' + _fmtPct(d2.stock.totalPnl) + ' → ' + _fmtPct(d3.stock.totalPnl) + ' → ' + _fmtPct(d4.stock.totalPnl));
        console.log('    stock shrp : ' + _fmt(d2.stock.sharpe) + ' → ' + _fmt(d3.stock.sharpe) + ' → ' + _fmt(d4.stock.sharpe));
        console.log('    opt N      : ' + (d2.option.count || 0) + ' → ' + (d3.option.count || 0) + ' → ' + (d4.option.count || 0));
        console.log('    opt PF     : ' + _fmt(d2.option.pf) + ' → ' + _fmt(d3.option.pf) + ' → ' + _fmt(d4.option.pf));
    }
    console.log('══════════════════════════════════════════════════');
}

async function _loadAll() {
    const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 8000 });
    await client.connect();
    const db = client.db('trading_bot');
    const v2 = await db.collection('meta').findOne({ _id: 'backtest_reference_v2' });
    const v3 = await db.collection('meta').findOne({ _id: 'backtest_reference_v3' });
    const v4 = await db.collection('meta').findOne({ _id: REF_ID });
    await client.close();
    return { v2, v3, v4 };
}

(async () => {
    if (CHECK_ONLY) {
        const { v2, v3, v4 } = await _loadAll();
        _printSnapshot('v2 (baseline)', v2);
        _printSnapshot('v3 (post-9.3)', v3);
        _printSnapshot('v4 (final)', v4);
        _printDelta(v2, v3, v4);
        return;
    }

    // ── Run new reference backtest ──
    const to = Math.floor(Date.now() / 1000);
    const from = to - 5 * 365 * 86400;
    const body = {
        mode: 'option',
        symbols: ['اهرم', 'خودرو'],
        strategies: [{ id: 'smc_unicorn' }, { id: 'tsmom' }],
        dateFrom: from, dateTo: to,
        optionType: 'call',
        qualityLevel: 'B',
        panels: {
            analysis: { enabled: true, minTrades: 5, iterations: 3000 },
            portfolio: { enabled: true, capital: 100000000, riskPct: 1.5, maxSymPct: 20, maxTotalPct: 50 },
            wf: { enabled: false }, regime: { enabled: false }
        }
    };
    const _hdr = { 'Content-Type': 'application/json', 'x-admin-token': ADMIN_TOKEN };

    console.log('[ref-v4] POST /api/backtest/run ...');
    const r = await fetch(BASE + '/api/backtest/run', { method: 'POST', headers: _hdr, body: JSON.stringify(body), timeout: 30000 });
    const j = await r.json();
    if (!j.jobId) throw new Error('no jobId: ' + JSON.stringify(j));
    console.log('[ref-v4] jobId=' + j.jobId);

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

    // Read current logic version
    let _logicVer = 'unknown';
    try { _logicVer = require(path.join(__dirname, '..', 'core', 'backtest')).BACKTEST_LOGIC_VERSION || 'unknown'; } catch (_) {}
    let _costVer = 'unknown';
    try { _costVer = require(path.join(__dirname, '..', 'core', 'backtest')).BACKTEST_COST_MODEL_VERSION || 'unknown'; } catch (_) {}

    const doc = {
        _id: REF_ID,
        version: REF_VERSION,
        logicVersion: _logicVer,
        costModelVersion: _costVer,
        params: {
            mode: body.mode,
            symbols: body.symbols,
            strategies: body.strategies.map(s => s.id),
            qualityLevel: body.qualityLevel,
            dateFrom: from, dateTo: to
        },
        summary: {
            mode: result.mode,
            detailsCount: (result.details || []).length,
            portfolio: result.portfolio ? {
                acceptedTrades: result.portfolio.acceptedTrades,
                totalTrades: result.portfolio.totalTrades,
                rejectedTrades: result.portfolio.rejectedTrades,
                stats: result.portfolio.stats || null
            } : null,
            analysis: result.analysis ? {
                totalAnalyzed: result.analysis.totalAnalyzed,
                passing: result.analysis.passing
            } : null
        },
        perDetail: (result.details || []).map(d => ({
            symbol: d.symbol,
            strategyId: d.strategyId,
            stock: d.stockStats ? {
                count: d.stockStats.count, winRate: d.stockStats.winRate,
                totalPnl: d.stockStats.totalPnl, pf: d.stockStats.profitFactor,
                sharpe: d.stockStats.sharpe, maxDD: d.stockStats.maxDrawdownPct
            } : null,
            option: d.optionStats ? {
                count: d.optionStats.count, winRate: d.optionStats.winRate,
                totalPnl: d.optionStats.totalPnl, pf: d.optionStats.profitFactor,
                sharpe: d.optionStats.sharpe, maxDD: d.optionStats.maxDrawdownPct
            } : null
        })),
        computedAt: new Date(),
        jobId: j.jobId
    };
    const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 8000 });
    await client.connect();
    const db = client.db('trading_bot');
    await db.collection('meta').replaceOne({ _id: REF_ID }, doc, { upsert: true });
    const v2 = await db.collection('meta').findOne({ _id: 'backtest_reference_v2' });
    const v3 = await db.collection('meta').findOne({ _id: 'backtest_reference_v3' });
    await client.close();

    console.log('[ref-v4] SAVED ' + REF_ID);
    console.log('[ref-v4] DONE');
    _printSnapshot('v2 (baseline)', v2);
    _printSnapshot('v3 (post-9.3)', v3);
    _printSnapshot('v4 (final)', doc);
    _printDelta(v2, v3, doc);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
