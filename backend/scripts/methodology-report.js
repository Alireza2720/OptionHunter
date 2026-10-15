'use strict';
// methodology-report.js — Stage 9.7d: generate comprehensive audit report
// Usage:
//   node backend/scripts/methodology-report.js           # generate + save to meta
//   node backend/scripts/methodology-report.js --check   # show current report
//   node backend/scripts/methodology-report.js --json    # dump raw JSON
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

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
const ROOT = path.resolve(__dirname, '..', '..');
const { MongoClient } = require(path.join(ROOT, 'node_modules', 'mongodb'));

const CHECK_ONLY = process.argv.indexOf('--check') !== -1;
const AS_JSON = process.argv.indexOf('--json') !== -1;
const REPORT_ID = 'methodology_report_v3';

// ── Fix registry ──
const FIXES = [
    { id: '1', stage: '9.3', severity: 'high',   title: 'fill-from-next-open',           desc: 'Entry/exit fill now uses next candle open, not signal candle close. Removes look-ahead bias at signal boundary.', files: ['backend/core/backtest.js'] },
    { id: '2', stage: '9.4', severity: 'high',   title: 'PIT fail-closed',               desc: 'PITContext.allows(null/undefined/invalid) now returns false by default. Opt-in lenient mode for UI debug only.', files: ['backend/core/pit.js', 'backend/tests/pit.test.js'] },
    { id: '3', stage: '9.4', severity: 'med',    title: 'OPTION_DATA_CUTOFF constant',   desc: 'Added exported constant = 2026-06-09 (Jalali 1405/03/19) — real TSETMC option data starts here. Backtests before this produce ~0 option trades.', files: ['backend/config/constants.js'] },
    { id: '4', stage: '9.3', severity: 'med',    title: 'standard-daily Sharpe',         desc: 'computeStats() now builds a daily capital curve and computes Sharpe/Sortino from daily returns (annualized x sqrt(245)). Legacy trade-based fallback for <5 trades.', files: ['backend/core/backtest.js'] },
    { id: '5', stage: '9.2', severity: 'critical', title: 'no future-leak on option selection', desc: 'Candidate entry rows filtered to time <= entrySec (was entrySec + WINDOW_SEC). Exit rows filtered to time <= exitSec. Removes option-selection look-ahead.', files: ['backend/core/options.js'] },
    { id: '6', stage: '9.2', severity: 'critical', title: 'removed duplicate Bug-9 adjustment', desc: 'Removed the second of two consecutive stock-move adjustments that were double-counted on option PnL.', files: ['backend/core/options.js'] },
    { id: '7', stage: '9.2', severity: 'critical', title: 'quality filters use effective params', desc: 'Hardcoded thresholds (spread<80%, oi<5, days<2) replaced with p.minPremium/p.maxSpreadPct/p.minOI/p.minDays/p.maxDays from the active quality level.', files: ['backend/core/options.js'] },
    { id: '8', stage: '9.4', severity: 'med',    title: 'orderSize units clarity',       desc: 'Explicit numContracts x contractMultiplier = orderSize (shares). dailyVolume also in shares. Prior code combined contract multiplier with volume without comment.', files: ['backend/core/options.js'] },
    { id: '9a', stage: '9.5-v1', severity: 'high', title: 'buildWindows math',            desc: 'Fixed window math: testSize = totalDays / (numWindows + R) where R = trainPct/(1-trainPct). Previously floor(totalDays/(numWindows+1)) under-counted (2/4 windows for 365d).', files: ['backend/core/walk-forward.js'] },
    { id: '9b', stage: '9.5-v2', severity: 'high', title: 'real OOS walk-forward with retrain', desc: 'New wf-retrain.service: per-window grid search on TRAIN (9 combos x 2 params), pick best by PF^0.75 x N^0.25, apply frozen params to TEST. Old naive split re-labeled as method="time-split", isRealOos=false.', files: ['backend/services/wf-retrain.service.js', 'backend/services/wf.service.js', 'backend/api/routes/wf.routes.js', 'backend/bootstrap.js'] },
    { id: '10', stage: '9.2', severity: 'critical', title: 'cache signature versioning', desc: 'buildSignature includes logicVersion + costModelVersion. Any logic/cost change invalidates trade cache. Also exported both constants.', files: ['backend/core/backtest.js', 'backend/scripts/clear-caches.js'] },
    { id: 'X1', stage: '9.6b-v2', severity: 'high', title: 'nr7 dayKey sort leak',       desc: 'Discovered by strategies.test.js future-independence test. dayKey returned un-padded "yyyy-m-d" causing alphabetical sort (2024-1-10 < 2024-1-9). Padded month/day → chronological sort.', files: ['backend/strategies.js'] },
    { id: 'X2', stage: '9.7c', severity: 'critical', title: 'wf.routes app-not-defined', desc: 'Stages 9.5-v2 had placed app.post(retrain) at module level (outside register). Fixed by moving inside register().', files: ['backend/api/routes/wf.routes.js'] },
    { id: '10e', stage: '10e', severity: 'critical', title: 'exitRow undefined in tryGetRealTradeDataFast', desc: 'Function referenced exitRow without declaring it; ReferenceError silently swallowed by try/catch in runHybridOptionBacktest, causing opt N=0 for all trades.', files: ['backend/core/options.js'] },
    { id: '10e.2', stage: '10e.2', severity: 'high', title: 'oi=0 treated as unknown, not zero', desc: 'TSETMC writes oi=0 for historical rows where OI was not tracked. Filter now skips the check when oi<=0, only rejecting when oi>0 and below threshold. Exit lookback also widened 24h->48h for holidays/sparse days.', files: ['backend/core/options.js'] },
    { id: '10f.1', stage: '10f.1', severity: 'high', title: 'min-1-contract floor after soft multipliers', desc: 'The min-1-contract rule was applied BEFORE strategySizeMult; SMC/OB (mult=0.3) then floored 1*0.3 to 0, so no trades were ever opened for those strategies. Rule moved to AFTER all soft multipliers.', files: ['backend/core/execution-guard.js'] },
    { id: '11.1', stage: '11', severity: 'critical', title: 'actionable TDZ bug', desc: 'The "actionable" variable was referenced before its const declaration, causing a silent ReferenceError inside try/catch. Result: NO actionable signals (BUY/EXIT) fired from 2026-10-07 onwards. Fixed by moving declaration BEFORE the logger call and paper hook. Verified: 13 signals fired in 3 min after fix.', files: ['backend/core/signals.js'] },
    { id: '11.2', stage: '11.2', severity: 'high', title: 'paper hooks order', desc: 'paper hook was placed AFTER the already-notified early-return, so paper positions were never created when Telegram notify was already sent for the same signal. Moved BEFORE the early-return.', files: ['backend/core/signals.js'] },
    { id: '11.3', stage: '11.3', severity: 'high', title: 'paperLastNotifiedTime idempotency', desc: 'Added a SEPARATE idempotency field (paperLastNotifiedTime/paperLastNotifiedType) independent from the Telegram notify tracking. Prevents double-firing on paper side AND avoids skipping paper when Telegram already sent.', files: ['backend/core/signals.js'] },
    { id: '11.4', stage: '11.4', severity: 'medium', title: 'remove !isConfirmer filter on paper hook', desc: 'Previous code filtered paper hook to leader role only. Now ALL actionable signals (leader + confirmer) create paper positions, matching live behavior.', files: ['backend/core/signals.js'] },
    { id: '11.5', stage: '11.5', severity: 'medium', title: 'skip orphan EXITs in paper-trading', desc: 'EXIT_LONG signals without a matching open paper BUY were creating noise records. Now skip with reason no-open-paper-position.', files: ['backend/services/paper-trading.service.js'] },
    { id: '11.6', stage: '11.6', severity: 'medium', title: 'paper-trading EXIT_LONG uses signal.symbol', desc: 'Previously EXIT lookup used wrong field; now matches on underlying + paper + status=open correctly.', files: ['backend/services/paper-trading.service.js'] },
    { id: '11.7', stage: '11.7', severity: 'high', title: 'reset-signals-state also resets paperLastNotifiedTime', desc: 'POST /api/reset-signals-state was only resetting lastNotifiedTime, leaving paperLastNotifiedTime stuck. After reset, paper hooks continued to suppress. Now both fields are cleared together.', files: ['backend/api/routes/system.routes.js'] },
    { id: '12.1', stage: '12.1', severity: 'high', title: 'paper-drift service', desc: 'New service computing drift between paper-trading PF and last backtest PF. Uses 30d window with fallback to all-time when sample < 5. Severity: insufficient / ok / notice / warn / critical.', files: ['backend/services/paper-drift.service.js', 'backend/api/routes/paper-trading.routes.js'] },
    { id: '12.2', stage: '12.2', severity: 'medium', title: 'paper-drift cron job', desc: 'Weekly Sunday 10:00 Tehran cron that computes drift and notifies on warn/critical. Registered in bootstrap + server startup.', files: ['backend/jobs/paper-drift.job.js', 'backend/bootstrap.js', 'backend/server.js'] },
    { id: '12.3', stage: '12.3', severity: 'medium', title: 'orphan guard in paper-trading', desc: 'EXIT_LONG with no matching open paper BUY is now skipped (with log) rather than creating a closed record with no entry. Also: /api/paper-trading/cleanup-orphans endpoint to purge legacy orphans.', files: ['backend/services/paper-trading.service.js', 'backend/api/routes/paper-trading.routes.js'] },
    { id: '12.4', stage: '12.4', severity: 'high', title: 'evaluate-now async', desc: 'POST /api/evaluate-now used to block until tick completed (3-5 min for 57 configs). Now fire-and-forget by default, returns started:true in less than 20ms. Pass ?block=1 to wait with client timeout. Prevents HTTP timeouts and dashboard freezes.', files: ['backend/api/routes/configs.routes.js'] },
    { id: '12.5', stage: '12.5', severity: 'high', title: 'capital UI + min-1-contract floor', desc: 'Capital settings moved from openSettings to openAdvancedSettings with Rial labels. min-1-contract floor added to sizing-unified.js (live path) so deep-OTM contracts with high premium are not silently zeroed when they fit within symbol exposure limits.', files: ['frontend/index.html', 'backend/core/sizing-unified.js'] },
    { id: '12.6', stage: '12.6', severity: 'medium', title: 'stacktrace in evaluateConfig + calcPositionSizeV3', desc: 'Both evaluateConfig and calcPositionSizeV3 catch-blocks now log full stacktrace and include it in the response object (result.stack). Added /api/evaluate-single/:configId debug endpoint that returns innerStack/outerStack for a single config.', files: ['backend/core/signals.js', 'backend/core/options.js', 'backend/api/routes/configs.routes.js'] }
];

function _runTest(file) {
    try {
        const out = execSync('node ' + JSON.stringify(file) + ' 2>&1', {
            cwd: ROOT, timeout: 60000, encoding: 'utf8'
        });
        const m = out.match(/(\d+)\s+passed,\s+(\d+)\s+failed/);
        return { pass: m ? +m[1] : null, fail: m ? +m[2] : null, ok: m && +m[2] === 0 };
    } catch (e) {
        const out = ((e.stdout || '') + (e.stderr || '')).toString();
        const m = out.match(/(\d+)\s+passed,\s+(\d+)\s+failed/);
        return { pass: m ? +m[1] : null, fail: m ? +m[2] : null, ok: false, error: (e.message || '').slice(0, 200) };
    }
}

function _collectTests() {
    const dir = path.join(ROOT, 'backend', 'tests');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.test.js')).sort();
    const out = {};
    for (const f of files) {
        out[f] = _runTest(path.join(dir, f));
    }
    return out;
}

function _gitHead() {
    try {
        return execSync('git log --oneline -1', { cwd: ROOT, encoding: 'utf8' }).trim();
    } catch (_) { return '(unavailable)'; }
}

async function _loadSnapshots() {
    const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 8000 });
    await client.connect();
    const db = client.db('trading_bot');
    const v2 = await db.collection('meta').findOne({ _id: 'backtest_reference_v2' });
    const v3 = await db.collection('meta').findOne({ _id: 'backtest_reference_v3' });
    const v4 = await db.collection('meta').findOne({ _id: 'backtest_reference_v4' });
    const v7 = await db.collection('meta').findOne({ _id: 'backtest_reference_v7' });
    const v8 = await db.collection('meta').findOne({ _id: 'backtest_reference_v8' });
    const v9 = await db.collection('meta').findOne({ _id: 'backtest_reference_v9' });
    const v10 = await db.collection('meta').findOne({ _id: 'backtest_reference_v10' });
    const v11 = await db.collection('meta').findOne({ _id: 'backtest_reference_v11' });
    const v12 = await db.collection('meta').findOne({ _id: 'backtest_reference_v12' });
    await client.close();
    return { v2, v3, v4, v7, v8, v9, v10, v11, v12 };
}

function _summaryOf(doc) {
    if (!doc) return null;
    const s = doc.summary || {};
    return {
        logicVersion: doc.logicVersion || null,
        detailsCount: s.detailsCount || 0,
        portfolio: s.portfolio || null,
        analysis: s.analysis || null,
        perDetail: (doc.perDetail || []).map(d => ({
            symbol: d.symbol, strategyId: d.strategyId,
            stockN: d.stock && d.stock.count, stockPF: d.stock && d.stock.pf,
            stockWR: d.stock && d.stock.winRate, stockRet: d.stock && d.stock.totalPnl,
            stockSharpe: d.stock && d.stock.sharpe,
            optN: d.option && d.option.count, optPF: d.option && d.option.profitFactor
        }))
    };
}

(async () => {
    if (CHECK_ONLY) {
        const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 8000 });
        await client.connect();
        const doc = await client.db('trading_bot').collection('meta').findOne({ _id: REPORT_ID });
        await client.close();
        if (!doc) { console.log('EMPTY: no methodology report yet'); return; }
        if (AS_JSON) { console.log(JSON.stringify(doc, null, 2)); return; }
        console.log('generatedAt : ' + (doc.generatedAt ? doc.generatedAt.toISOString() : '?'));
        console.log('gitHead     : ' + doc.gitHead);
        console.log('fixes       : ' + (doc.fixes || []).length);
        console.log('tests       : ' + JSON.stringify(doc.testsSummary || {}));
        console.log('snapshots   : v2=' + (doc.snapshots && doc.snapshots.v2 ? 'Y' : 'N') +
                    ' v3=' + (doc.snapshots && doc.snapshots.v3 ? 'Y' : 'N') +
                    ' v4=' + (doc.snapshots && doc.snapshots.v4 ? 'Y' : 'N'));
        return;
    }

    console.log('[method] collecting git HEAD ...');
    const gitHead = _gitHead();

    console.log('[method] running all tests ...');
    const tests = _collectTests();
    const testsSummary = {
        totalFiles: Object.keys(tests).length,
        totalPass: 0, totalFail: 0,
        allOk: true
    };
    for (const [f, r] of Object.entries(tests)) {
        if (r.pass != null) testsSummary.totalPass += r.pass;
        if (r.fail != null) testsSummary.totalFail += r.fail;
        if (!r.ok) testsSummary.allOk = false;
    }

    console.log('[method] loading reference snapshots ...');
    const { v2, v3, v4, v7, v8, v9, v10, v11, v12 } = await _loadSnapshots();

    // Delta v2 -> v4
    function _indexBy(doc) {
        const m = {};
        for (const d of ((doc && doc.perDetail) || [])) m[d.symbol + '/' + d.strategyId] = d;
        return m;
    }
    const m2 = _indexBy(v2), m4 = _indexBy(v4);
    const delta = {};
    for (const k of new Set([...Object.keys(m2), ...Object.keys(m4)])) {
        const a = m2[k] || {}; const b = m4[k] || {};
        delta[k] = {
            stockPF:    [a.stock && a.stock.pf, b.stock && b.stock.pf],
            stockWR:    [a.stock && a.stock.winRate, b.stock && b.stock.winRate],
            stockRet:   [a.stock && a.stock.totalPnl, b.stock && b.stock.totalPnl],
            stockN:     [a.stock && a.stock.count, b.stock && b.stock.count],
            optN:       [a.option && a.option.count, b.option && b.option.count]
        };
    }

    const doc = {
        _id: REPORT_ID,
        version: 'v3-2026-10-15',
        generatedAt: new Date(),
        gitHead,
        fixes: FIXES,
        tests,
        testsSummary,
        snapshots: {
            v2: _summaryOf(v2),
            v3: _summaryOf(v3),
            v4: _summaryOf(v4),
            v7: _summaryOf(v7),
            v8: _summaryOf(v8),
            v9: _summaryOf(v9),
            v10: _summaryOf(v10),
            v11: _summaryOf(v11),
            v12: _summaryOf(v12)
        },
        delta_v2_to_v4: delta,
        knownLimitations: [
            'OPTION_DATA_CUTOFF = 2026-06-09 (Jalali 1405/03/19). 5Y option backtests show ~0 option trades before this date — this is data coverage, not a bug.',
            'Reference backtest 2sym x 2strat shows portfolio accepted=0/0. Portfolio simulator rejects all trades under current limits; this may be by-design (constraints) or a separate bug to investigate.',
            'Reference analysis passing=0/3. No pair passed the bootstrap + t-test + Sharpe + rolling gate. Consistent with an honest post-fix baseline.',
            'Regime and walk-forward panels are intentionally disabled in reference snapshots (kept short for fast CI).'
        ],
        reproducibility: {
            cacheClearCmd: 'node backend/scripts/clear-caches.js',
            referenceRun: 'node backend/scripts/reference-backtest.js',
            referenceCheck: 'node backend/scripts/reference-backtest.js --check',
            fullTestSuite: 'bash backend/tests/run-all.sh'
        }
    };

    const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 8000 });
    await client.connect();
    await client.db('trading_bot').collection('meta').replaceOne({ _id: REPORT_ID }, doc, { upsert: true });
    await client.close();

    console.log('[method] SAVED ' + REPORT_ID);
    console.log('[method] summary:');
    console.log('  gitHead    : ' + gitHead);
    console.log('  fixes      : ' + FIXES.length);
    console.log('  tests      : ' + testsSummary.totalPass + ' pass / ' + testsSummary.totalFail + ' fail (allOk=' + testsSummary.allOk + ')');
    console.log('  v2 details : ' + (v2 ? (v2.summary || {}).detailsCount : '-'));
    console.log('  v4 details : ' + (v4 ? (v4.summary || {}).detailsCount : '-'));
    console.log('[method] DONE');
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
