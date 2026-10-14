'use strict';
// reference-backtest.js — run canonical backtest & store as backtest_reference_v2
// Usage: node backend/scripts/reference-backtest.js [--check]
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

(async () => {
    if (CHECK_ONLY) {
        const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 8000 });
        await client.connect();
        const db = client.db('trading_bot');
        const doc = await db.collection('meta').findOne({ _id: 'backtest_reference_v2' });
        await client.close();
        if (!doc) { console.log('EMPTY'); return; }
        console.log('SAVED_AT: ' + (doc.computedAt ? doc.computedAt.toISOString() : '?'));
        console.log('SUMMARY: ' + JSON.stringify(doc.summary));
        console.log('PER_DETAIL: ' + JSON.stringify(doc.perDetail));
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

    console.log('[ref-v2] POST /api/backtest/run ...');
    const r = await fetch(BASE + '/api/backtest/run', {
        method: 'POST',
        headers: _hdr,
        body: JSON.stringify(body),
        timeout: 30000,
    });
    const j = await r.json();
    if (!j.jobId) throw new Error('no jobId: ' + JSON.stringify(j));
    console.log('[ref-v2] jobId=' + j.jobId);

    const deadline = Date.now() + 30 * 60 * 1000;
    let result = null;
    let lastMsg = '';
    while (Date.now() < deadline) {
        await new Promise(rs => setTimeout(rs, 5000));
        const rr = await fetch(BASE + '/api/backtest/results/' + j.jobId, { headers: _hdr, timeout: 30000 });
        const d = await rr.json();
        if (d.computing) {
            const m = 'computing... ' + (d.computingFor || 0) + 's';
            if (m !== lastMsg) { console.log('[ref-v2] ' + m); lastMsg = m; }
            continue;
        }
        if (d.status === 'DONE' && d.result) { result = d.result; break; }
        if (d.status === 'FAILED' || d.status === 'CANCELLED') {
            throw new Error('job ' + d.status + ': ' + (d.error || ''));
        }
        const m = 'status=' + d.status;
        if (m !== lastMsg) { console.log('[ref-v2] ' + m); lastMsg = m; }
    }
    if (!result) throw new Error('timeout after 30min');

    const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 8000 });
    await client.connect();
    const db = client.db('trading_bot');

    const doc = {
        _id: 'backtest_reference_v2',
        version: 'v2-2026-10-14',
        logicVersion: 'v2-2026-10-14',
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
    await db.collection('meta').replaceOne({ _id: 'backtest_reference_v2' }, doc, { upsert: true });
    await client.close();

    console.log('[ref-v2] SAVED backtest_reference_v2');
    console.log('[ref-v2] SUMMARY: ' + JSON.stringify(doc.summary));
    console.log('[ref-v2] DONE');
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
