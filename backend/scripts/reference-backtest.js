'use strict';
// reference-backtest.js — v3 — canonical backtest + delta comparison (v2 vs v3)
// Usage:
//   node backend/scripts/reference-backtest.js           # run + save v3 + compare
//   node backend/scripts/reference-backtest.js --check   # show saved snapshots + delta
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

function _fmtPct(v) { return (v === null || v === undefined || !Number.isFinite(v)) ? '—' : (v >= 0 ? '+' : '') + v.toFixed(2) + '%'; }
function _fmt(v, d) { return (v === null || v === undefined || !Number.isFinite(v)) ? '—' : Number(v).toFixed(d == null ? 2 : d); }
function _deltaN(a, b) {
    if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b)) return '—';
    const d = b - a;
    return (d > 0 ? '+' : '') + d.toFixed(2);
}
function _deltaPct(a, b) {
    if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b) || a === 0) return '—';
    const d = (b - a) / Math.abs(a) * 100;
    return (d > 0 ? '+' : '') + d.toFixed(1) + '%';
}

async function _loadSnapshots() {
    const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 8000 });
    await client.connect();
    const db = client.db('trading_bot');
    const v2 = await db.collection('meta').findOne({ _id: 'backtest_reference_v2' });
    const v3 = await db.collection('meta').findOne({ _id: 'backtest_reference_v3' });
    await client.close();
    return { v2, v3 };
}

function _printSnapshot(label, doc) {
    if (!doc) { console.log(label + ': (empty)'); return; }
    console.log('');
    console.log('── ' + label + ' ──');
    console.log('  computedAt : ' + (doc.computedAt ? doc.computedAt.toISOString() : '?'));
    console.log('  logicVer   : ' + (doc.logicVersion || '?'));
    console.log('  jobId      : ' + (doc.jobId || '?'));
    const s = doc.summary || {};
    console.log('  details#   : ' + (s.detailsCount || 0));
    const pf = s.portfolio || {};
    const pstats = pf.stats || {};
    console.log('  portfolio  : accepted=' + (pf.acceptedTrades || 0) + '/' + (pf.totalTrades || 0) +
                ' PF=' + _fmt(pstats.profitFactor) +
                ' ret=' + _fmtPct(pstats.totalReturnPct) +
                ' maxDD=' + _fmtPct(-Math.abs(pstats.maxDD || 0)) +
                ' sharpe=' + _fmt(pstats.sharpe));
    const an = s.analysis || {};
    console.log('  analysis   : ' + (an.passing || 0) + '/' + (an.totalAnalyzed || 0) + ' passing');
    console.log('  per-detail :');
    for (const d of (doc.perDetail || [])) {
        const o = d.option || {};
        const st = d.stock || {};
        console.log('    ' + d.symbol + '/' + d.strategyId +
                    ' | stock N=' + (st.count || 0) +
                    ' PF=' + _fmt(st.pf) + ' WR=' + _fmt(st.winRate, 1) + '%' +
                    ' | opt N=' + (o.count || 0) +
                    ' PF=' + _fmt(o.pf) + ' WR=' + _fmt(o.winRate, 1) + '%' +
                    ' tot=' + _fmtPct(o.totalPnl) +
                    ' sharpe=' + _fmt(o.sharpe));
    }
}

function _printDelta(v2, v3) {
    if (!v2 || !v3) {
        console.log('');
        console.log('[delta] یکی از دو snapshot خالیه — نمی‌تونم مقایسه کنم');
        return;
    }
    console.log('');
    console.log('══════════════════════════════════════════════════');
    console.log('  DELTA — v2 (baseline) → v3 (post-9.3)');
    console.log('══════════════════════════════════════════════════');
    const p2 = (v2.summary && v2.summary.portfolio) || {};
    const p3 = (v3.summary && v3.summary.portfolio) || {};
    const s2 = p2.stats || {}, s3 = p3.stats || {};
    console.log('  portfolio accepted   : ' + (p2.acceptedTrades || 0) + ' → ' + (p3.acceptedTrades || 0) +
                ' (' + _deltaN(p2.acceptedTrades || 0, p3.acceptedTrades || 0) + ')');
    console.log('  portfolio PF         : ' + _fmt(s2.profitFactor) + ' → ' + _fmt(s3.profitFactor) +
                ' (' + _deltaN(s2.profitFactor, s3.profitFactor) + ')');
    console.log('  portfolio return     : ' + _fmtPct(s2.totalReturnPct) + ' → ' + _fmtPct(s3.totalReturnPct) +
                ' (' + _deltaPct(s2.totalReturnPct, s3.totalReturnPct) + ')');
    console.log('  portfolio maxDD      : ' + _fmtPct(-Math.abs(s2.maxDD || 0)) + ' → ' + _fmtPct(-Math.abs(s3.maxDD || 0)));
    console.log('  portfolio sharpe     : ' + _fmt(s2.sharpe) + ' → ' + _fmt(s3.sharpe) +
                ' (' + _deltaN(s2.sharpe, s3.sharpe) + ')');
    const a2 = (v2.summary && v2.summary.analysis) || {};
    const a3 = (v3.summary && v3.summary.analysis) || {};
    console.log('  analysis passing     : ' + (a2.passing || 0) + '/' + (a2.totalAnalyzed || 0) +
                ' → ' + (a3.passing || 0) + '/' + (a3.totalAnalyzed || 0));
    console.log('');
    console.log('  per-detail comparison:');
    const _keyOf = d => d.symbol + '/' + d.strategyId;
    const _byKey2 = {}; for (const d of (v2.perDetail || [])) _byKey2[_keyOf(d)] = d;
    const _byKey3 = {}; for (const d of (v3.perDetail || [])) _byKey3[_keyOf(d)] = d;
    const _allKeys = new Set([...Object.keys(_byKey2), ...Object.keys(_byKey3)]);
    for (const k of _allKeys) {
        const d2 = _byKey2[k] || { stock: {}, option: {} };
        const d3 = _byKey3[k] || { stock: {}, option: {} };
        console.log('');
        console.log('  ▸ ' + k);
        console.log('    stock N    : ' + (d2.stock.count || 0) + ' → ' + (d3.stock.count || 0));
        console.log('    stock PF   : ' + _fmt(d2.stock.pf) + ' → ' + _fmt(d3.stock.pf));
        console.log('    stock WR   : ' + _fmt(d2.stock.winRate, 1) + '% → ' + _fmt(d3.stock.winRate, 1) + '%');
        console.log('    stock ret  : ' + _fmtPct(d2.stock.totalPnl) + ' → ' + _fmtPct(d3.stock.totalPnl));
        console.log('    stock shrp : ' + _fmt(d2.stock.sharpe) + ' → ' + _fmt(d3.stock.sharpe));
        console.log('    opt N      : ' + (d2.option.count || 0) + ' → ' + (d3.option.count || 0));
        console.log('    opt PF     : ' + _fmt(d2.option.pf) + ' → ' + _fmt(d3.option.pf));
        console.log('    opt WR     : ' + _fmt(d2.option.winRate, 1) + '% → ' + _fmt(d3.option.winRate, 1) + '%');
        console.log('    opt ret    : ' + _fmtPct(d2.option.totalPnl) + ' → ' + _fmtPct(d3.option.totalPnl));
        console.log('    opt sharpe : ' + _fmt(d2.option.sharpe) + ' → ' + _fmt(d3.option.sharpe));
    }
    console.log('');
    console.log('══════════════════════════════════════════════════');
}

(async () => {
    if (CHECK_ONLY) {
        const { v2, v3 } = await _loadSnapshots();
        _printSnapshot('v2 (baseline)', v2);
        _printSnapshot('v3 (post-9.3)', v3);
        _printDelta(v2, v3);
        return;
    }

    const to = Math.floor(Date.now() / 1000);
    const from = to - 5 * 365 * 86400;

    const body = {
        mode: 'option',
        symbols: ['اهرم', 'خودرو'],
        strategies: [{ id: 'smc_unicorn' }, { id: 'tsmom' }],
        dateFrom: from,
        dateTo: to,
        optionType: 'call',
        qualityLevel: 'B',
        panels: {
            analysis: { enabled: true, minTrades: 5, iterations: 3000 },
            portfolio: {
                enabled: true,
                capital: 100000000,
                riskPct: 1.5,
                maxSymPct: 20,
                maxTotalPct: 50,
            },
            wf: { enabled: false },
            regime: { enabled: false },
        },
    };

    const _hdr = { 'Content-Type': 'application/json', 'x-admin-token': ADMIN_TOKEN };

    console.log('[ref-v3] POST /api/backtest/run ...');
    const r = await fetch(BASE + '/api/backtest/run', {
        method: 'POST',
        headers: _hdr,
        body: JSON.stringify(body),
        timeout: 30000,
    });
    const j = await r.json();
    if (!j.jobId) throw new Error('no jobId: ' + JSON.stringify(j));
    console.log('[ref-v3] jobId=' + j.jobId);

    const deadline = Date.now() + 30 * 60 * 1000;
    let result = null;
    let lastMsg = '';
    while (Date.now() < deadline) {
        await new Promise(rs => setTimeout(rs, 5000));
        const rr = await fetch(BASE + '/api/backtest/results/' + j.jobId, { headers: _hdr, timeout: 30000 });
        const d = await rr.json();
        if (d.computing) {
            const m = 'computing... ' + (d.computingFor || 0) + 's';
            if (m !== lastMsg) { console.log('[ref-v3] ' + m); lastMsg = m; }
            continue;
        }
        if (d.status === 'DONE' && d.result) { result = d.result; break; }
        if (d.status === 'FAILED' || d.status === 'CANCELLED') {
            throw new Error('job ' + d.status + ': ' + (d.error || ''));
        }
        const m = 'status=' + d.status;
        if (m !== lastMsg) { console.log('[ref-v3] ' + m); lastMsg = m; }
    }
    if (!result) throw new Error('timeout after 30min');

    const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 8000 });
    await client.connect();
    const db = client.db('trading_bot');

    const doc = {
        _id: 'backtest_reference_v3',
        version: 'v3-2026-10-14',
        logicVersion: 'v3-2026-10-14',
        costModelVersion: 'v1',
        params: {
            mode: body.mode,
            symbols: body.symbols,
            strategies: body.strategies.map(s => s.id),
            qualityLevel: body.qualityLevel,
            dateFrom: from,
            dateTo: to,
        },
        summary: {
            mode: result.mode,
            detailsCount: (result.details || []).length,
            portfolio: result.portfolio ? {
                acceptedTrades: result.portfolio.acceptedTrades,
                totalTrades: result.portfolio.totalTrades,
                rejectedTrades: result.portfolio.rejectedTrades,
                stats: result.portfolio.stats || null,
            } : null,
            analysis: result.analysis ? {
                totalAnalyzed: result.analysis.totalAnalyzed,
                passing: result.analysis.passing,
            } : null,
        },
        perDetail: (result.details || []).map(d => ({
            symbol: d.symbol,
            strategyId: d.strategyId,
            stock: d.stockStats ? {
                count: d.stockStats.count,
                winRate: d.stockStats.winRate,
                totalPnl: d.stockStats.totalPnl,
                pf: d.stockStats.profitFactor,
                sharpe: d.stockStats.sharpe,
                maxDD: d.stockStats.maxDrawdownPct,
            } : null,
            option: d.optionStats ? {
                count: d.optionStats.count,
                winRate: d.optionStats.winRate,
                totalPnl: d.optionStats.totalPnl,
                pf: d.optionStats.profitFactor,
                sharpe: d.optionStats.sharpe,
                maxDD: d.optionStats.maxDrawdownPct,
            } : null,
        })),
        computedAt: new Date(),
        jobId: j.jobId,
    };
    await db.collection('meta').replaceOne({ _id: 'backtest_reference_v3' }, doc, { upsert: true });

    // Load v2 for delta
    const v2 = await db.collection('meta').findOne({ _id: 'backtest_reference_v2' });
    await client.close();

    console.log('[ref-v3] SAVED backtest_reference_v3');
    console.log('[ref-v3] DONE');
    console.log('');
    _printSnapshot('v2 (baseline)', v2);
    _printSnapshot('v3 (post-9.3)', doc);
    _printDelta(v2, doc);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
