#!/usr/bin/env node
'use strict';
// ============================================================
// OHDoctor v2 — Comprehensive System Audit
// Usage:
//   node backend/scripts/monitor.js
//   node backend/scripts/monitor.js --skip-heavy
//   node backend/scripts/monitor.js --sections=1,2,3,9
//   node backend/scripts/monitor.js --send-report
//   node backend/scripts/monitor.js --json
// ============================================================

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const { spawnSync, execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const BACKEND = path.join(ROOT, 'backend');
const COLLECTOR_DIR = path.join(ROOT, 'collector');
const LOGS = path.join(ROOT, 'logs');
const ENV_FILE = path.join(ROOT, '.env');

const ARGV = process.argv.slice(2);
const CONF = {
    backend: process.env.OH_DOCTOR_BACKEND || 'http://127.0.0.1:3000',
    collector: process.env.OH_DOCTOR_COLLECTOR || 'http://127.0.0.1:5000',
    timeout: 15000,
    adminToken: '',
    skipHeavy: ARGV.includes('--skip-heavy'),
    skipPipeline: ARGV.includes('--skip-pipeline') || ARGV.includes('--skip-heavy'),
    skipBacktest: ARGV.includes('--skip-backtest'),
    skipLiveTick: ARGV.includes('--skip-live'),
    sendReport: ARGV.includes('--send-report'),
    jsonOut: ARGV.includes('--json'),
    verbose: ARGV.includes('--verbose') || ARGV.includes('-v'),
    quiet: ARGV.includes('--quiet'),
    sections: null,   // [1..24] or null for all

    // 🆕 قیدهای زمانی و job
    forceHours: ARGV.includes('--force-hours') || ARGV.includes('--unsafe') || ARGV.includes('--force'),
    // ↑ اجبار به اجرا حتی در ساعات بازار
    waitForIdle: ARGV.includes('--wait-for-idle'),
    // ↑ اگر job فعال بود، منتظر بمان (پیش‌فرض: رد کن)
    idleWaitMaxMin: (() => {
        const a = ARGV.find((x) => x.startsWith('--idle-wait='));
        return a ? parseInt(a.split('=')[1], 10) : 30;
    })(),
    // ↑ حداکثر زمان انتظار برای job ها (دقیقه)
};
const secArg = ARGV.find((a) => a.startsWith('--sections='));
if (secArg) {
    CONF.sections = secArg.split('=')[1].split(',').map((s) => +s.trim()).filter(Boolean);
}

// ============================================================
// 🎯 MODE DETECTION — یک فایل، دو رفتار
// ============================================================
// PM2 (بدون flag):     → daemon mode (پیوسته، سبک)
// CLI (بدون flag):     → doctor mode
// UI (--doctor ...):   → doctor mode
// --daemon:            → daemon (اجباری)
// --doctor:            → doctor (اجباری)
// ============================================================
const _pmId = process.env.pm_id;
const _underPm2 = _pmId !== undefined && _pmId !== null && String(_pmId) !== '';
const _hasDaemon = ARGV.includes('--daemon');
const _doctorFlags = [
    '--doctor', '--skip-heavy', '--skip-pipeline', '--skip-backtest',
    '--skip-live', '--send-report', '--json', '--verbose', '-v',
    '--force-hours', '--wait-for-idle', '--unsafe', '--force',
];
const _hasDoctor = ARGV.some((a) =>
    _doctorFlags.includes(a) || a.startsWith('--sections=') || a.startsWith('--idle-wait=')
);
const MODE = _hasDaemon ? 'daemon'
    : _hasDoctor ? 'doctor'
    : _underPm2 ? 'daemon'
    : 'doctor';

// ============================================================
// 🛡 SAFETY GUARD — جلوگیری از خفه کردن سرور
// ============================================================
const SAFETY = {
    minFreeMemMB: 400,             // حداقل RAM آزاد قبل از بخش سنگین
    watchdogMinMB: 200,            // اگر کمتر شد، اجرا را abort کن
    maxNodeRssMB: 750,             // اگر Node بالاتر بود، skip heavy
    maxSectionMs: 5 * 60 * 1000,   // حداکثر ۵ دقیقه برای هر بخش
    safeMode: !ARGV.includes('--unsafe') && !ARGV.includes('--force'),
    // safeMode = پیش‌فرض ON. برای غیرفعال کردن: --unsafe
};

let _safetyAborted = false;
let _safetyWatchdog = null;

function startSafetyWatchdog() {
    _safetyWatchdog = setInterval(() => {
        const free = os.freemem() / 1048576;
        if (free < SAFETY.watchdogMinMB) {
            _safetyAborted = true;
            wc(`  🚨 [WATCHDOG] RAM بحرانی: ${free.toFixed(0)}MB — abort فوری`, C.red + C.bold);
            process.exit(3);
        }
    }, 15000);
    if (_safetyWatchdog.unref) _safetyWatchdog.unref();
}
function stopSafetyWatchdog() {
    if (_safetyWatchdog) { clearInterval(_safetyWatchdog); _safetyWatchdog = null; }
}

// ============================================================
// 🕐 MARKET HOURS GATE
// ============================================================
function checkMarketHours() {
    const now = new Date();
    const tehran = new Date(now.getTime() + 3.5 * 3600 * 1000);
    const wd = tehran.getUTCDay();           // 0=Sun..6=Sat
    const mins = tehran.getUTCHours() * 60 + tehran.getUTCMinutes();

    // شنبه..چهارشنبه (6,0,1,2,3)
    const isTradingDay = [6, 0, 1, 2, 3].includes(wd);
    // پنجره‌ی امن: از 8:45 تا 12:45 — دیواره‌ی حاشیه‌ای برای اطمینان
    const SAFE_START = 8 * 60 + 45;           // 08:45
    const SAFE_END = 12 * 60 + 45;            // 12:45
    const inDanger = isTradingDay && mins >= SAFE_START && mins <= SAFE_END;

    // پیش‌بینی زمان تا پنجره‌ی بعدی
    let hint = '';
    if (inDanger) {
        const minsToSafe = SAFE_END - mins;
        hint = `بازار باز/در آستانه‌ی بازگشایی است — تا ${minsToSafe} دقیقه صبر کن (بعد از ${String(Math.floor(SAFE_END / 60)).padStart(2, '0')}:${String(SAFE_END % 60).padStart(2, '0')})`;
    } else if (isTradingDay && mins < SAFE_START) {
        const minsToOpen = SAFE_START - mins;
        hint = `${minsToOpen} دقیقه تا پنجره‌ی بازار — صبر کن`;
    } else {
        hint = 'خارج از پنجره‌ی بازار ✓';
    }

    return {
        ok: !inDanger,
        isTradingDay,
        isMarketOpen: isTradingDay && mins >= 9 * 60 && mins <= 12 * 60 + 35,
        inDanger,
        reason: inDanger
            ? `🚫 بازار/آستانه‌ی بازار باز است — OHDoctor سنگین می‌تواند سرور را کند کند. ${hint}`
            : `✅ خارج از ساعت بازار — اجرا امن است`,
        hint,
        tehran: tehran.toISOString(),
    };
}

// ============================================================
// 🚦 JOB IDLE GATE
// ============================================================
async function checkJobsIdle() {
    try {
        const r = await httpGet(CONF.backend + '/api/jobs?limit=10', { timeout: 5000 });
        if (!r.ok || !r.json || !Array.isArray(r.json.jobs)) {
            return { idle: true, count: 0, jobs: [], note: 'unable to query jobs — assuming idle' };
        }
        const active = r.json.jobs.filter((j) =>
            ['QUEUED', 'RUNNING', 'COMPUTING'].includes(j.status)
        );
        return {
            idle: active.length === 0,
            count: active.length,
            jobs: active.map((j) => ({
                type: j.type,
                status: j.status,
                message: (j.progress && j.progress.message) || '',
                id: String(j._id).slice(-6),
            })),
        };
    } catch (e) {
        return { idle: true, count: 0, jobs: [], note: 'error: ' + e.message };
    }
}

async function waitForJobsIdle(maxWaitMs) {
    const t0 = Date.now();
    let lastCount = -1;
    while (Date.now() - t0 < maxWaitMs) {
        const chk = await checkJobsIdle();
        if (chk.idle) return { ok: true, waited: Date.now() - t0 };
        if (chk.count !== lastCount) {
            lastCount = chk.count;
            info(`[IDLE-WAIT] ${chk.count} job فعال — نمونه: ${chk.jobs.slice(0, 3).map((j) => `${j.type}:${j.status}`).join(', ')}`);
        }
        await sleep(10000);
    }
    return { ok: false, waited: Date.now() - t0, timedOut: true };
}

async function preHeavyCheck(sectionName) {
    // 1) RAM آزاد سیستم
    const totalMB = os.totalmem() / 1048576;
    const freeMB = os.freemem() / 1048576;
    if (freeMB < SAFETY.minFreeMemMB) {
        warn(`[SAFETY] ${sectionName} رد شد — RAM آزاد کم: ${freeMB.toFixed(0)}MB < ${SAFETY.minFreeMemMB}MB`);
        return false;
    }

    // 2) RSS پروسه‌ی Node اصلی (OptionHunter)
    try {
        const r = tryExec('pm2', ['jlist'], { timeout: 5000 });
        if (r.ok && r.stdout) {
            const list = JSON.parse(r.stdout);
            for (const app of list) {
                if (app.name === 'OptionHunter') {
                    const rss = Math.round((app.monit && app.monit.memory || 0) / 1048576);
                    if (rss > SAFETY.maxNodeRssMB) {
                        warn(`[SAFETY] ${sectionName} رد شد — Node RSS بالا: ${rss}MB > ${SAFETY.maxNodeRssMB}MB`);
                        return false;
                    }
                }
            }
        }
    } catch (_) {}

    // 3) job فعال در پس‌زمینه (خود بک‌تست یا pipeline)
    try {
        const jobs = await httpGet(CONF.backend + '/api/jobs?limit=5', { timeout: 5000 });
        if (jobs.ok && jobs.json && Array.isArray(jobs.json.jobs)) {
            const active = jobs.json.jobs.filter((j) => ['QUEUED', 'RUNNING', 'COMPUTING'].includes(j.status));
            if (active.length > 0) {
                warn(`[SAFETY] ${sectionName} رد شد — ${active.length} job فعال در پس‌زمینه`);
                for (const j of active.slice(0, 3)) info(`  • ${j.type} → ${j.status}`);
                return false;
            }
        }
    } catch (_) {}

    ok(`[SAFETY] ${sectionName} عبور کرد (RAM آزاد: ${freeMB.toFixed(0)}MB)`);
    return true;
}

// ---- Env loader ----
const ENV = {};
(function loadEnv() {
    try {
        const txt = fs.readFileSync(ENV_FILE, 'utf8');
        for (const line of txt.split(/\r?\n/)) {
            const t = line.trim();
            if (!t || t.startsWith('#')) continue;
            const eq = t.indexOf('=');
            if (eq < 1) continue;
            const k = t.slice(0, eq).trim();
            let v = t.slice(eq + 1).trim();
            if (v.length >= 2 && v[0] === v[v.length - 1] && (v[0] === '"' || v[0] === "'")) v = v.slice(1, -1);
            ENV[k] = v;
        }
        CONF.adminToken = ENV.ADMIN_TOKEN || '';
    } catch (_) {}
})();

// ============================================================
// REPORT / OUTPUT
// ============================================================
const R = {
    startedAt: new Date(),
    issues: [], warnings: [], oks: [],
    sectionResults: {},
    summary: {},
};
const OUT = [];
const C = { reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m', cyan: '\x1b[36m', magenta: '\x1b[35m', gray: '\x1b[90m', bold: '\x1b[1m' };
function w(l = '') { OUT.push(l); if (!CONF.quiet && !CONF.jsonOut) console.log(l); }
function wc(l, c) { OUT.push(l); if (!CONF.quiet && !CONF.jsonOut) console.log(c + l + C.reset); }
function bar() { w('═'.repeat(78)); }
function section(n, title) {
    R.sectionResults[n] = R.sectionResults[n] || { ok: 0, warn: 0, fail: 0 };
    w('');
    bar();
    wc(`  [S${n}] ${title}`, C.bold + C.cyan);
    bar();
}
function sub(t) { w(''); wc('─── ' + t + ' ───', C.gray); }
function ok(m) { wc('  ✅ ' + m, C.green); R.oks.push(m); _sectionInc('ok'); }
function warn(m) { wc('  ⚠️  ' + m, C.yellow); R.warnings.push(m); _sectionInc('warn'); }
function fail(m) { wc('  ❌ ' + m, C.red); R.issues.push(m); _sectionInc('fail'); }
function info(m) { w('  ℹ️  ' + m); }
function kv(k, v, c) { wc(`     ${String(k).padEnd(30)} ${v}`, c || ''); }
function _sectionInc(type) {
    const k = Object.keys(R.sectionResults).pop();
    if (k !== undefined) R.sectionResults[k][type]++;
}
function sectionEnabled(n) { return !CONF.sections || CONF.sections.includes(n); }

// ============================================================
// UTILS
// ============================================================
function tryExec(cmd, args, opts = {}) {
    try {
        const r = spawnSync(cmd, args, {
            encoding: 'utf8', timeout: opts.timeout || 15000,
            maxBuffer: opts.maxBuffer || 16 * 1024 * 1024,
            cwd: opts.cwd || ROOT,
        });
        return { ok: r.status === 0, stdout: r.stdout || '', stderr: r.stderr || '', status: r.status };
    } catch (e) { return { ok: false, stdout: '', stderr: e.message, status: -1 }; }
}
function tryShell(cmd, opts = {}) {
    try {
        const out = execSync(cmd, {
            encoding: 'utf8', timeout: opts.timeout || 15000,
            maxBuffer: opts.maxBuffer || 16 * 1024 * 1024,
            cwd: opts.cwd || ROOT, stdio: ['ignore', 'pipe', 'pipe'],
        });
        return { ok: true, stdout: out, stderr: '' };
    } catch (e) { return { ok: false, stdout: e.stdout || '', stderr: e.stderr || e.message }; }
}
function httpGet(url, opts = {}) {
    return new Promise((resolve) => {
        const started = Date.now();
        let u;
        try { u = new URL(url); } catch (e) { return resolve({ ok: false, status: 0, error: 'bad url', ms: 0 }); }
        const mod = u.protocol === 'https:' ? https : http;
        const headers = { 'user-agent': 'OHDoctor/2.0', 'accept': 'application/json' };
        if (CONF.adminToken) headers['x-admin-token'] = CONF.adminToken;
        if (opts.headers) Object.assign(headers, opts.headers);
        let bodyStr = null;
        if (opts.body !== undefined) {
            bodyStr = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
            headers['content-type'] = headers['content-type'] || 'application/json';
            headers['content-length'] = Buffer.byteLength(bodyStr);
        }
        const req = mod.request({
            method: opts.method || 'GET',
            hostname: u.hostname, port: u.port,
            path: u.pathname + u.search, headers,
            timeout: opts.timeout || CONF.timeout,
        }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { if (body.length < 1024 * 1024) body += c; });
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(body); } catch (_) {}
                resolve({ ok: res.statusCode >= 200 && res.statusCode < 400, status: res.statusCode, body, json: parsed, ms: Date.now() - started });
            });
        });
        req.on('error', (e) => resolve({ ok: false, status: 0, error: e.message, ms: Date.now() - started }));
        req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, error: 'timeout', ms: Date.now() - started }); });
        if (bodyStr) req.write(bodyStr);
        req.end();
    });
}
function walk(dir, pred, out = [], skip = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', 'Include', 'Lib', 'dist', 'build', 'logs'])) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
    for (const e of entries) {
        if (skip.has(e.name)) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, pred, out, skip);
        else if (e.isFile()) { try { if (pred(full, e.name)) out.push(full); } catch (_) {} }
    }
    return out;
}
function fileSize(p) { try { return fs.statSync(p).size; } catch (_) { return 0; } }
function fileLines(p) { try { return fs.readFileSync(p, 'utf8').split('\n').length; } catch (_) { return 0; } }
function readText(p, max = 1024 * 1024) {
    try { const s = fs.readFileSync(p, 'utf8'); return s.length > max ? s.slice(0, max) : s; } catch (_) { return ''; }
}
function fmtBytes(b) {
    if (b < 1024) return b + 'B';
    if (b < 1048576) return (b / 1024).toFixed(1) + 'KB';
    if (b < 1073741824) return (b / 1048576).toFixed(1) + 'MB';
    return (b / 1073741824).toFixed(2) + 'GB';
}
function fmtMs(ms) { return ms < 1000 ? ms + 'ms' : (ms / 1000).toFixed(2) + 's'; }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ============================================================
// S1 — ENVIRONMENT
// ============================================================
function s1_env() {
    section(1, 'ENVIRONMENT');
    const nodeVer = process.version;
    const major = parseInt(nodeVer.slice(1).split('.')[0], 10);
    if (major >= 20) ok(`Node ${nodeVer}`);
    else if (major >= 18) warn(`Node ${nodeVer} — upgrade به v20+ پیشنهاد می‌شود`);
    else fail(`Node ${nodeVer} — قدیمی`);

    const py = tryExec('python3', ['--version']);
    if (py.ok) ok(`Python: ${py.stdout.trim()}`); else warn('Python3 یافت نشد');

    kv('Platform', `${os.platform()} ${os.arch()}`);
    kv('Hostname', os.hostname());
    kv('Kernel', os.release());
    kv('Uptime', `${(os.uptime() / 3600).toFixed(1)}h`);

    const total = os.totalmem() / 1048576, free = os.freemem() / 1048576;
    const used = total - free, pct = (used / total * 100).toFixed(1);
    kv('RAM', `${used.toFixed(0)} / ${total.toFixed(0)} MB (${pct}%)`, pct > 85 ? C.red : pct > 70 ? C.yellow : C.green);
    if (pct > 85) fail(`RAM ${pct}%`); else if (pct > 70) warn(`RAM ${pct}%`);

    const load = os.loadavg(), cores = os.cpus().length;
    kv('Load avg', `${load.map((x) => x.toFixed(2)).join(', ')} (${cores} core)`,
        load[0] > cores * 2 ? C.red : load[0] > cores ? C.yellow : C.green);
    if (load[0] > cores * 2) warn(`Load بالا`);

    const df = tryShell("df -B1 / | tail -1 | awk '{print $2, $3, $4}'");
    if (df.ok) {
        const [t, u, f] = df.stdout.trim().split(/\s+/).map(Number);
        const p = (u / t * 100).toFixed(1);
        kv('Disk', `${(u / 1073741824).toFixed(1)} / ${(t / 1073741824).toFixed(1)} GB (${p}%)`,
            p > 85 ? C.red : p > 70 ? C.yellow : C.green);
        if (p > 85) fail(`Disk ${p}%`);
    }

    const now = new Date();
    const tehran = new Date(now.getTime() + 3.5 * 3600 * 1000);
    kv('UTC', now.toISOString());
    kv('Tehran', tehran.toISOString().replace('T', ' ').slice(0, 19));
    const wd = tehran.getUTCDay();
    const mins = tehran.getUTCHours() * 60 + tehran.getUTCMinutes();
    const isTradingDay = [6, 0, 1, 2, 3].includes(wd);
    const isMarket = isTradingDay && mins >= 9 * 60 && mins <= 12 * 60 + 35;
    kv('Market', isMarket ? '🟢 OPEN' : (isTradingDay ? '⚪ closed' : '⚪ holiday'));
}

// ============================================================
// S2 — STRUCTURE
// ============================================================
function s2_structure() {
    section(2, 'STRUCTURE');
    const dirs = ['backend', 'backend/api', 'backend/api/routes', 'backend/api/middleware',
        'backend/config', 'backend/core', 'backend/infra', 'backend/jobs', 'backend/services',
        'backend/scripts', 'backend/tests', 'collector', 'collector/pipeline',
        'frontend', 'logs', '.vscode', '.github/workflows'];
    for (const d of dirs) {
        if (fs.existsSync(path.join(ROOT, d))) info(`✓ ${d}`);
        else warn(`پوشه غایب: ${d}`);
    }
    const files = ['package.json', 'ecosystem.config.js', '.env', '.env.example',
        'backend/server.js', 'backend/bootstrap.js', 'backend/settings.js', 'backend/strategies.js',
        'backend/api/index.js', 'backend/core/backtest.js', 'backend/core/options.js',
        'backend/infra/mongo.js', 'backend/services/dual-stage-pipeline.service.js',
        'backend/scripts/monitor.js', 'collector/service.py', 'collector/requirements.txt',
        'frontend/index.html'];
    for (const f of files) {
        const p = path.join(ROOT, f);
        if (fs.existsSync(p)) info(`✓ ${f} (${fmtBytes(fileSize(p))}, ${fileLines(p)}L)`);
        else warn(`فایل غایب: ${f}`);
    }
    const js = walk(ROOT, (f) => f.endsWith('.js'));
    const py = walk(COLLECTOR_DIR, (f) => f.endsWith('.py'));
    kv('JS files', js.length);
    kv('PY files', py.length);
}

// ============================================================
// S3 — SYNTAX
// ============================================================
function s3_syntax() {
    section(3, 'SYNTAX');
    sub('JavaScript (node --check)');
    const js = walk(ROOT, (f) => f.endsWith('.js'));
    let jf = 0;
    for (const f of js) {
        const r = tryExec('node', ['--check', f], { timeout: 5000 });
        if (!r.ok) {
            jf++;
            fail(`${path.relative(ROOT, f)} — ${r.stderr.split('\n').slice(0, 2).join(' | ').slice(0, 120)}`);
        }
    }
    if (!jf) ok(`${js.length} فایل JS سالم`);

    sub('Python (py_compile)');
    const py = walk(COLLECTOR_DIR, (f) => f.endsWith('.py'));
    let pf = 0;
    for (const f of py) {
        const r = tryExec('python3', ['-m', 'py_compile', f], { timeout: 5000 });
        if (!r.ok) { pf++; fail(`${path.relative(ROOT, f)}`); }
    }
    if (!pf) ok(`${py.length} فایل Python سالم`);

    sub('JSON');
    const jn = walk(ROOT, (f) => f.endsWith('.json'));
    let jnf = 0;
    for (const f of jn) {
        try { JSON.parse(readText(f).replace(/^\uFEFF/, '')); }
        catch (e) { jnf++; fail(`${path.relative(ROOT, f)}: ${e.message.slice(0, 80)}`); }
    }
    if (!jnf) ok(`${jn.length} JSON معتبر`);

    sub('VSCode');
    for (const f of ['.vscode/settings.json', '.vscode/launch.json', '.vscode/tasks.json']) {
        const p = path.join(ROOT, f);
        if (!fs.existsSync(p)) continue;
        const txt = readText(p);
        if (/^(cat|mkdir|echo)\s/.test(txt.trim())) fail(`${f} آلوده به shell`);
        else {
            try { JSON.parse(txt.replace(/^\uFEFF/, '')); ok(`${f}`); }
            catch (e) { fail(`${f}: ${e.message.slice(0, 80)}`); }
        }
    }

    sub('Shell scripts');
    const sh = walk(ROOT, (f) => f.endsWith('.sh'));
    for (const f of sh) {
        const r = tryExec('bash', ['-n', f], { timeout: 5000 });
        if (r.ok) info(`✓ ${path.relative(ROOT, f)}`);
        else fail(`${path.relative(ROOT, f)}: ${r.stderr.slice(0, 80)}`);
    }
}

// ============================================================
// S4 — BUG PATTERNS
// ============================================================
const PATTERNS = [
    { n: '$unset داخل $set', r: /\$set\s*:\s*\{[^}]*\$unset/, sev: 'fail' },
    { n: 'await ternary', r: /await\s+[\w.\[\]]+\s*\?\s+await\s+[\w.\[\]]+\s*:/, sev: 'fail' },
    { n: 'dropIndex در runtime', r: /\.dropIndex\s*\(/, sev: 'warn', files: ['backend/infra/mongo.js', 'backend/infra/logger.js'] },
    { n: 'execSync در route', r: /execSync\s*\(/, sev: 'warn', files: ['backend/api/routes/'] },
    { n: 'Math.min/max با spread', r: /Math\.(min|max)\s*\(\s*\.\.\./, sev: 'warn' },
    { n: 'TODO/FIXME', r: /\b(TODO|FIXME|XXX|HACK)\b/, sev: 'info' },
    { n: 'console.log در core/services', r: /console\.log\s*\(/, sev: 'info', files: ['backend/core/', 'backend/services/'] },
    { n: 'x-admin-token در URL', r: /x-admin-token=[^&"'\s]+/, sev: 'fail' },
    { n: '12:31 vs 12:35 hardcode', r: /12\s*\*\s*60\s*\+\s*3[0-9]/, sev: 'warn' },
    { n: 'hardcoded secret', r: /(password|passwd|secret|api[_-]?key)\s*[:=]\s*["'][^"']{10,}["']/i, sev: 'fail' },
    { n: 'eval / Function', r: /\b(eval|Function)\s*\(/, sev: 'warn' },
    { n: 'Bidi chars', r: /[\u202A-\u202E\u2066-\u2069]/, sev: 'fail' },
    { n: 'process.exit بدون log', r: /process\.exit\s*\(\s*[0-9]+\s*\)\s*;?\s*$/m, sev: 'info' },
    { n: 'updateOne بدون upsert', r: /updateOne\s*\(\s*\{[^}]*\}\s*,\s*\{[^}]*\$set[^}]*\}\s*\)\s*;/, sev: 'info' },
    { n: 'require داخل تابع', r: /function\s+\w+\s*\([^)]*\)\s*\{[^}]{0,500}\brequire\s*\(/m, sev: 'info' },
    { n: 'async بدون await', r: /async\s+function\s+\w+\s*\([^)]*\)\s*\{[^}]{0,800}\}/m, sev: 'info' },
    { n: 'let داخل حلقه بدون نیاز', r: /for\s*\([^)]*\)\s*\{[^}]{0,200}\blet\b/m, sev: 'info' },
    { n: 'JSON.parse بدون try', r: /JSON\.parse\s*\([^)]+\)(?![\s\S]{0,50}catch)/, sev: 'warn' },
];
function s4_patterns() {
    section(4, 'BUG PATTERNS');
    const all = [...walk(ROOT, (f) => f.endsWith('.js') && !f.includes('/tests/') && !f.includes('/node_modules/')),
        ...walk(COLLECTOR_DIR, (f) => f.endsWith('.py'))];
    for (const p of PATTERNS) {
        const matches = [];
        for (const f of all) {
            const rel = path.relative(ROOT, f);
            if (p.files && !p.files.some((x) => rel.includes(x))) continue;
            const lines = readText(f, 500 * 1024).split('\n');
            for (let i = 0; i < lines.length; i++) {
                if (p.r.test(lines[i])) matches.push({ file: rel, line: i + 1, text: lines[i].trim().slice(0, 100) });
            }
        }
        if (!matches.length) ok(p.n + ' — پاک');
        else {
            const sevFn = p.sev === 'fail' ? fail : p.sev === 'warn' ? warn : info;
            sevFn(`${p.n} — ${matches.length} مورد`);
            if (p.sev !== 'info' || CONF.verbose) {
                for (const m of matches.slice(0, 6)) {
                    wc(`     • ${m.file}:${m.line}`, p.sev === 'fail' ? C.red : p.sev === 'warn' ? C.yellow : C.gray);
                    if (CONF.verbose) wc(`       → ${m.text}`, C.gray);
                }
                if (matches.length > 6) info(`... +${matches.length - 6} مورد دیگر`);
            }
        }
    }
}

// ============================================================
// S5 — CONFIG
// ============================================================
function s5_config() {
    section(5, 'CONFIG');
    sub('.env');
    if (!fs.existsSync(ENV_FILE)) return fail('.env غایب');
    const mode = (fs.statSync(ENV_FILE).mode & 0o777).toString(8);
    kv('.env mode', mode, ['600', '400', '640'].includes(mode) ? C.green : C.yellow);
    if (!['600', '400', '640'].includes(mode)) warn(`.env permissions ${mode} — chmod 600 کن`);
    const req = ['MONGO_URI', 'ALGOTIK_URL', 'PORT', 'HOST', 'NODE_ENV'];
    const rec = ['ADMIN_TOKEN', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];
    for (const k of req) {
        if (!ENV[k]) fail(`متغیر اجباری غایب: ${k}`); else ok(`${k} ست`);
    }
    for (const k of rec) if (!ENV[k]) warn(`${k} خالی`);
    if (ENV.ADMIN_TOKEN) ok('ADMIN_TOKEN ست (auth فعال)');
    if (ENV.TELEGRAM_BOT_TOKEN && ENV.TELEGRAM_CHAT_ID) ok('Bale/Telegram پیکربندی شده');

    sub('package.json');
    try {
        const pkg = JSON.parse(readText(path.join(ROOT, 'package.json')));
        kv('name', pkg.name);
        kv('version', pkg.version);
        kv('deps', Object.keys(pkg.dependencies || {}).length);
    } catch (e) { fail('package.json: ' + e.message); }

    sub('ecosystem.config.js');
    try {
        const eco = require(path.join(ROOT, 'ecosystem.config.js'));
        for (const a of eco.apps || []) {
            kv(a.name, `script=${a.script} maxmem=${a.max_memory_restart || '-'}`, a.script ? C.green : C.red);
        }
    } catch (e) { fail('ecosystem: ' + e.message.slice(0, 80)); }
}

// ============================================================
// S6 — PM2
// ============================================================
function s6_pm2() {
    section(6, 'PM2');
    const r = tryExec('pm2', ['jlist'], { timeout: 10000 });
    if (!r.ok || !r.stdout) return warn('PM2 در دسترس نیست');
    let list;
    try { list = JSON.parse(r.stdout); } catch (_) { return fail('pm2 jlist نامعتبر'); }
    if (!list.length) return warn('هیچ process در PM2');
    for (const app of list) {
        const env = app.pm2_env || {}, m = app.monit || {};
        const status = env.status;
        const col = status === 'online' ? C.green : status === 'errored' ? C.red : C.yellow;
        sub(app.name);
        kv('status', status, col);
        kv('pid', app.pid || '-');
        kv('restarts', env.restart_time || 0, (env.restart_time || 0) > 20 ? C.red : (env.restart_time || 0) > 5 ? C.yellow : C.green);
        kv('uptime', env.pm_uptime ? `${((Date.now() - env.pm_uptime) / 60000).toFixed(1)}min` : '-');
        kv('memory', `${Math.round((m.memory || 0) / 1048576)}MB`, (m.memory || 0) / 1048576 > 800 ? C.yellow : '');
        kv('cpu', `${m.cpu || 0}%`);
        if (status === 'errored') fail(`${app.name} errored`);
        if ((env.restart_time || 0) > 30) warn(`${app.name} restart بالا`);
    }
    const names = list.map((a) => a.name);
    if (!names.includes('OptionHunter')) fail('OptionHunter در PM2 نیست');
    if (!names.includes('OHMonitor')) warn('OHMonitor در PM2 نیست');
}

// ============================================================
// S7 — SYSTEMD
// ============================================================
function s7_systemd() {
    section(7, 'SYSTEMD — COLLECTOR');
    const act = tryShell("systemctl is-active collector 2>/dev/null");
    const s = act.stdout.trim();
    kv('Active', s, s === 'active' ? C.green : C.red);
    if (s !== 'active') fail(`collector ${s}`);

    const info = tryShell("systemctl show collector -p MainPID,MemoryCurrent,NRestarts,ActiveState --no-pager 2>/dev/null");
    if (info.ok) {
        const m = {};
        info.stdout.split('\n').forEach((l) => {
            const i = l.indexOf('=');
            if (i > 0) m[l.slice(0, i)] = l.slice(i + 1);
        });
        kv('MainPID', m.MainPID);
        if (m.MemoryCurrent && m.MemoryCurrent !== '[not set]') kv('Memory', `${Math.round(+m.MemoryCurrent / 1048576)}MB`);
        kv('NRestarts', m.NRestarts || '0');
    }

    const jc = tryShell("journalctl -u collector -n 30 --no-pager 2>/dev/null | grep -iE 'error|exception|traceback' | tail -5");
    if (jc.ok && jc.stdout.trim()) {
        warn('خطاهای اخیر collector:');
        for (const l of jc.stdout.trim().split('\n')) wc(`     • ${l.slice(0, 140)}`, C.yellow);
    } else ok('بدون خطا در journalctl اخیر');
}

// ============================================================
// S8 — MONGODB
// ============================================================
async function s8_mongo() {
    section(8, 'MONGODB');
    const uri = ENV.MONGO_URI;
    if (!uri) return fail('MONGO_URI غایب');
    let MongoClient;
    try { MongoClient = require(path.join(ROOT, 'node_modules', 'mongodb')).MongoClient; }
    catch (_) { try { MongoClient = require('mongodb').MongoClient; } catch (e) { return fail('mongodb driver نیافت'); } }
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000, maxPoolSize: 4 });
    let db;
    try { await client.connect(); db = client.db('trading_bot'); await db.command({ ping: 1 }); ok('اتصال موفق'); }
    catch (e) { return fail('Mongo: ' + e.message); }
    try {
        sub('DB stats');
        const st = await db.command({ dbStats: 1 });
        kv('collections', st.collections);
        kv('objects', st.objects.toLocaleString());
        kv('dataSize', fmtBytes(st.dataSize));
        kv('storageSize', fmtBytes(st.storageSize));
        kv('indexSize', fmtBytes(st.indexSize));

        sub('Collections');
        const cols = (await db.listCollections().toArray()).map((c) => c.name).sort();
        for (const n of cols) {
            let c = -1;
            try { c = await db.collection(n).estimatedDocumentCount(); } catch (_) {}
            kv(n, c < 0 ? '?' : c.toLocaleString());
        }

        sub('Indexes');
        const exp = {
            candles_base: ['symbol_1_time_1'],
            candles_daily: ['symbol_1_time_1'],
            candles_tf: ['symbol_1_tf_1_time_1'],
            option_history: ['symbol_1_time_1', 'underlying_1_time_1'],
            monitored_symbols: ['symbol_1'],
            strategy_configs: ['symbol_1'],
            signals_state: ['configId_1'],
            signal_history: ['createdAt_-1'],
            backtest_jobs: ['status_1_createdAt_1'],
            backtest_compare_details: ['jobId_1_symbol_1_strategyId_1'],
            stock_ticks: ['symbol_1_time_1'],
            logs: ['at_1'],
        };
        for (const [col, idx] of Object.entries(exp)) {
            try {
                const existing = (await db.collection(col).indexes()).map((i) => i.name);
                for (const name of idx) {
                    if (existing.includes(name)) info(`✓ ${col}.${name}`);
                    else warn(`✗ ${col}.${name} غایب`);
                }
            } catch (_) {}
        }

        sub('Data quality — per symbol');
        const monitored = await db.collection('monitored_symbols').find({ enabled: true }).toArray();
        const syms = monitored.map((s) => s.symbol);
        if (syms.length) {
            const base = {}, daily = {}, opt = {};
            for (const r of await db.collection('candles_base').aggregate([
                { $match: { symbol: { $in: syms }, source: 'algotik_intraday' } },
                { $group: { _id: '$symbol', c: { $sum: 1 }, last: { $max: '$time' } } },
            ]).toArray()) base[r._id] = r;
            for (const r of await db.collection('candles_daily').aggregate([
                { $match: { symbol: { $in: syms } } },
                { $group: { _id: '$symbol', c: { $sum: 1 }, last: { $max: '$time' } } },
            ]).toArray()) daily[r._id] = r;
            for (const r of await db.collection('option_history').aggregate([
                { $match: { underlying: { $in: syms } } },
                { $group: {
                    _id: '$underlying', c: { $sum: 1 },
                    bidask: { $sum: { $cond: [{ $and: [{ $gt: ['$bid', 0] }, { $gt: ['$ask', 0] }] }, 1, 0] } },
                    iv: { $sum: { $cond: [{ $gt: ['$ivApi', 0] }, 1, 0] } },
                    last: { $max: '$time' },
                } },
            ]).toArray()) opt[r._id] = r;

            const now = Date.now();
            w('');
            w(`     ${'symbol'.padEnd(12)} ${'1m'.padEnd(10)} ${'daily'.padEnd(8)} ${'opt'.padEnd(9)} ${'bidask'.padEnd(9)} ${'IV'.padEnd(9)} last`);
            for (const s of syms) {
                const b = base[s] || {}, d = daily[s] || {}, o = opt[s] || {};
                const gap = d.last ? Math.floor((now - new Date(d.last).getTime()) / 86400000) : -1;
                const flag = gap > 5 ? '⚠' : '';
                w(`     ${s.padEnd(12)} ${String(b.c || 0).padEnd(10)} ${String(d.c || 0).padEnd(8)} ${String(o.c || 0).padEnd(9)} ${String(o.bidask || 0).padEnd(9)} ${String(o.iv || 0).padEnd(9)} ${d.last ? new Date(d.last).toISOString().slice(0, 10) : '-'} ${flag}`);
            }
        }

        sub('Recent activity');
        const since1d = new Date(Date.now() - 86400000);
        kv('ticks 24h', (await db.collection('stock_ticks').countDocuments({ time: { $gte: since1d } })).toLocaleString());
        kv('signals 30d', (await db.collection('signal_history').countDocuments({ createdAt: { $gte: new Date(Date.now() - 30 * 86400000) } })).toLocaleString());
        kv('pending outbox', await db.collection('telegram_outbox').countDocuments({ sentAt: null, attempts: { $lt: 120 } }));
        kv('active jobs', await db.collection('backtest_jobs').countDocuments({ status: { $in: ['QUEUED', 'RUNNING', 'COMPUTING'] } }));
        kv('failed jobs 30d', await db.collection('backtest_jobs').countDocuments({ status: 'FAILED', finishedAt: { $gte: new Date(Date.now() - 30 * 86400000) } }));
        kv('strategy_configs', await db.collection('strategy_configs').countDocuments({}));
        kv('  enabled', await db.collection('strategy_configs').countDocuments({ enabled: true }));
    } finally { try { await client.close(); } catch (_) {} }
}

// ============================================================
// S9 — BACKEND HTTP
// ============================================================
async function s9_backend_http() {
    section(9, 'BACKEND HTTP');
    const eps = [
        ['GET', '/ping'], ['GET', '/'], ['GET', '/strategies.js'], ['GET', '/api/strategies'],
        ['GET', '/api/timeframes'], ['GET', '/api/monitored-symbols'], ['GET', '/api/strategy-configs'],
        ['GET', '/api/status'], ['GET', '/api/signal-history'], ['GET', '/api/quotes'],
        ['GET', '/api/trading-settings'], ['GET', '/api/strategy-defaults'], ['GET', '/api/options/settings'],
        ['GET', '/api/options/positions'], ['GET', '/api/algotik/health'], ['GET', '/api/algotik/status'],
        ['GET', '/api/algotik/coverage'], ['GET', '/api/algotik/quality'], ['GET', '/api/algotik/freshness'],
        ['GET', '/api/algotik/data-range'], ['GET', '/api/algotik/risk-free'], ['GET', '/api/dashboard/live'],
        ['GET', '/api/system/stats'], ['GET', '/api/system/jobs'], ['GET', '/api/jobs?limit=5'],
        ['GET', '/api/jobs?limit=5&all=1'], ['GET', '/api/pipeline/dual-stage/preview'],
        ['GET', '/api/pipeline/dual-stage/list?limit=5'], ['GET', '/api/journal?limit=5'],
        ['GET', '/api/portfolio/analysis'], ['GET', '/api/portfolio/correlation'],
        ['GET', '/api/portfolio/whitelist'], ['GET', '/api/regime/all'], ['GET', '/api/regime/strategy-map'],
        ['GET', '/api/data-coverage'], ['GET', '/api/reports/monthly/latest'], ['GET', '/api/algotik/ticker-log?limit=5'],
    ];
    let okC = 0, failC = 0, slowC = 0;
    w(`     ${'endpoint'.padEnd(42)} ms         status`);
    for (const [m, p] of eps) {
        const r = await httpGet(CONF.backend + p, { method: m });
        const col = r.ok ? C.green : (r.status >= 400 && r.status < 500) ? C.yellow : C.red;
        const fl = r.ms > 2000 ? ' 🐌' : r.ms > 500 ? ' 🟡' : '';
        if (r.ok) okC++; else failC++;
        if (r.ms > 2000) slowC++;
        wc(`     ${p.padEnd(42)} ${fmtMs(r.ms).padEnd(10)} ${String(r.status).padEnd(6)}${fl}`, col);
    }
    kv('OK / Fail / Slow', `${okC} / ${failC} / ${slowC}`,
        failC === 0 ? C.green : failC < 5 ? C.yellow : C.red);
}

// ============================================================
// S10 — COLLECTOR HTTP
// ============================================================
async function s10_collector_http() {
    section(10, 'COLLECTOR HTTP');
    const h = await httpGet(CONF.collector + '/health');
    if (!h.ok) return fail(`Collector ${CONF.collector} unreachable`);
    ok('Collector online');
    if (h.json) {
        kv('status', h.json.status);
        kv('mongo', h.json.mongo);
        kv('ticker', h.json.ticker);
        kv('backfill_running', h.json.backfill_running);
    }
    const eps = ['/status', '/coverage', '/symbols', '/risk-free', '/jobs?limit=10', '/data-range', '/live-market'];
    for (const p of eps) {
        const r = await httpGet(CONF.collector + p, { timeout: 30000 });
        wc(`     ${p.padEnd(30)} ${fmtMs(r.ms).padEnd(10)} ${r.status}`, r.ok ? C.green : C.red);
    }
    const st = await httpGet(CONF.collector + '/status');
    if (st.ok && st.json && st.json.ticker) {
        sub('Ticker');
        const t = st.json.ticker;
        kv('running', t.running);
        kv('ticks', t.ticks);
        kv('errors', t.tick_errors || 0, (t.tick_errors || 0) > 50 ? C.yellow : '');
    }
}

// ============================================================
// S11 — CROSS-SERVICE
// ============================================================
async function s11_cross() {
    section(11, 'CROSS-SERVICE');
    const [mon, cfg, colSym] = await Promise.all([
        httpGet(CONF.backend + '/api/monitored-symbols'),
        httpGet(CONF.backend + '/api/strategy-configs'),
        httpGet(CONF.collector + '/symbols'),
    ]);
    if (mon.ok && cfg.ok) {
        const ms = new Set((mon.json || []).map((x) => x.symbol));
        const cs = new Set((cfg.json || []).map((x) => x.symbol));
        const only = [...cs].filter((s) => !ms.has(s));
        kv('monitored', ms.size);
        kv('in configs', cs.size);
        if (only.length) warn(`${only.length} نماد در configs بدون monitored: ${only.slice(0, 8).join(', ')}`);
        else ok('همه config symbols monitored');
    }
    if (mon.ok && colSym.ok) {
        const ms = new Set((mon.json || []).map((x) => x.symbol));
        const cs = new Set((colSym.json || []).map((x) => x.symbol));
        const bOnly = [...ms].filter((s) => !cs.has(s));
        const cOnly = [...cs].filter((s) => !ms.has(s));
        if (bOnly.length) warn(`${bOnly.length} در backend نه collector: ${bOnly.slice(0, 5).join(', ')}`);
        if (cOnly.length) warn(`${cOnly.length} در collector نه backend: ${cOnly.slice(0, 5).join(', ')}`);
        if (!bOnly.length && !cOnly.length) ok('symbols backend↔collector همگام');
    }
}

// ============================================================
// S12 — DATA GAP ANALYSIS
// ============================================================
async function s12_gaps() {
    section(12, 'DATA GAP ANALYSIS');
    if (CONF.skipHeavy) return info('skip-heavy');
    const r = await httpGet(CONF.backend + '/api/algotik/fix-gaps?days=30', { method: 'POST', timeout: 120000 });
    if (!r.ok) return warn(`fix-gaps preview ناموفق: ${r.status}`);
    const data = r.json || {};
    kv('checked', data.checked || 0);
    kv('withGaps', data.withGaps || 0);
    kv('days scanned', data.days || 30);
    if ((data.withGaps || 0) > 0) {
        warn(`${data.withGaps} نماد با شکاف داده:`);
        for (const g of (data.gaps || []).slice(0, 10)) {
            const thin = (g.thinDays || []).slice(0, 3).map((d) => `${d.date}(${d.count})`).join(' ');
            wc(`     • ${g.symbol}: ${g.missingCount} روز ناقص — ${thin}`, C.yellow);
        }
    } else ok('بدون شکاف دیتا در ۳۰ روز اخیر');
}

// ============================================================
// S13 — LIVE TICK TEST
// ============================================================
async function s13_live_tick() {
    section(13, 'LIVE TICK');
    if (CONF.skipLiveTick) return info('skip-live');
    if (!await preHeavyCheck('S13 LIVE-TICK')) return;
    const now = new Date(Date.now() + 3.5 * 3600 * 1000);
    const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
    const wd = now.getUTCDay();
    const isM = [6, 0, 1, 2, 3].includes(wd) && mins >= 9 * 60 && mins <= 12 * 60 + 35;
    if (!isM) {
        info(`بازار بسته است — تست کامل tick انجام نمی‌شود`);
        const h = await httpGet(CONF.collector + '/health');
        if (h.ok && h.json) kv('ticker (from collector)', h.json.ticker);
        return;
    }
    sub('Trigger tick via evaluate-now');
    const before = await httpGet(CONF.backend + '/api/quotes');
    const beforeCount = before.ok ? Object.keys(before.json || {}).length : 0;
    kv('quotes before', beforeCount);

    const r = await httpGet(CONF.backend + '/api/evaluate-now', { method: 'POST', timeout: 60000 });
    if (!r.ok) return fail(`evaluate-now ${r.status}`);
    if (r.json && r.json.success) {
        ok('evaluate-now موفق');
        kv('lastTickAt', r.json.lastTickAt);
        kv('lastError', r.json.lastError || '-');
        kv('consecutiveFailures', r.json.consecutiveFailures || 0);
        if (r.json.consecutiveFailures > 3) warn(`consecutive failures: ${r.json.consecutiveFailures}`);
    }

    await sleep(2000);
    const after = await httpGet(CONF.backend + '/api/quotes');
    const afterCount = after.ok ? Object.keys(after.json || {}).length : 0;
    kv('quotes after', afterCount);
    if (afterCount > beforeCount) ok(`+${afterCount - beforeCount} quote جدید`);
    else info('تغییر quotes: 0');
}

// ============================================================
// S14 — STRATEGY DRY RUN
// ============================================================
async function s14_strategies() {
    section(14, 'STRATEGY DRY RUN');
    if (CONF.skipHeavy) return info('skip-heavy');
    if (!await preHeavyCheck('S14 STRATEGIES')) return;
    const stratResp = await httpGet(CONF.backend + '/api/strategies');
    if (!stratResp.ok) return fail('strategies list ناموفق');
    const strats = stratResp.json || [];
    const symResp = await httpGet(CONF.backend + '/api/monitored-symbols');
    const syms = (symResp.ok ? symResp.json : []) || [];
    if (!syms.length) return warn('هیچ نماد monitored نیست');
    const sample = syms[0].symbol;
    kv('total strategies', strats.length);
    kv('sample symbol', sample);
    kv('testing all strategies in dry-run mode...');

    // Trigger single backtest with all strategies, small window
    const to = Math.floor(Date.now() / 1000);
    const from = to - 30 * 86400;
    const body = {
        mode: 'stock',
        symbols: [sample],
        strategies: strats.map((s) => ({ id: s.id })),
        panels: { analysis: { enabled: false }, portfolio: { enabled: false }, wf: { enabled: false }, regime: { enabled: false } },
        dateFrom: from, dateTo: to,
    };
    const run = await httpGet(CONF.backend + '/api/backtest/run', { method: 'POST', body, timeout: 60000 });
    if (!run.ok || !run.json || !run.json.jobId) return fail(`backtest run ${run.status}`);
    kv('jobId', run.json.jobId);

    const jobId = run.json.jobId;
    const deadline = Date.now() + 90000;
    let final = null;
    while (Date.now() < deadline) {
        await sleep(3000);
        const jr = await httpGet(CONF.backend + `/api/jobs/${jobId}`);
        if (!jr.ok) continue;
        final = jr.json;
        if (['DONE', 'FAILED', 'CANCELLED'].includes(final.status)) break;
    }
    if (!final || final.status !== 'DONE') return fail(`status=${final && final.status}`);
    ok('backtest کامل شد');
    const res = (final.result && final.result.results) || [];
    const errors = res.filter((r) => r.error);
    const insufficient = res.filter((r) => r.insufficientData);
    const valid = res.filter((r) => !r.error && !r.insufficientData);
    kv('total', res.length);
    kv('valid', valid.length, valid.length === res.length ? C.green : '');
    kv('insufficient', insufficient.length, insufficient.length > 0 ? C.yellow : '');
    kv('errors', errors.length, errors.length > 0 ? C.red : '');
    if (errors.length) {
        sub('Strategy errors');
        for (const e of errors.slice(0, 10)) {
            wc(`     • ${e.symbol}/${e.strategyId}: ${e.error}`, C.red);
        }
    }
    if (insufficient.length) {
        sub('Insufficient data');
        for (const e of insufficient.slice(0, 10)) {
            wc(`     • ${e.symbol}/${e.strategyId}: ${e.error || 'داده ناکافی'}`, C.yellow);
        }
    }
}

// ============================================================
// S15 — REGIME
// ============================================================
async function s15_regime() {
    section(15, 'REGIME');
    if (CONF.skipHeavy) return info('skip-heavy');
    if (!await preHeavyCheck('S15 REGIME')) return;
    sub('Refresh all');
    const r = await httpGet(CONF.backend + '/api/regime/refresh', { method: 'POST', timeout: 120000 });
    if (!r.ok) return warn(`refresh ${r.status}`);
    if (r.json) {
        kv('refreshed', r.json.refreshed || 0);
        const syms = r.json.symbols || [];
        const byMacro = {};
        for (const s of syms) byMacro[s.macro || '?'] = (byMacro[s.macro || '?'] || 0) + 1;
        for (const [k, v] of Object.entries(byMacro)) kv('  ' + k, v);
        if (syms.length === 0) warn('regime نمادها خالی');
    }
    sub('All cached');
    const all = await httpGet(CONF.backend + '/api/regime/all');
    if (all.ok) {
        const s = (all.json && all.json.symbols) || [];
        kv('cached regimes', s.length);
        const unknown = s.filter((x) => x.macro === 'unknown').length;
        if (unknown > 0) warn(`${unknown} نماد با regime unknown`);
    }
    sub('Strategy map');
    const map = await httpGet(CONF.backend + '/api/regime/strategy-map');
    if (map.ok && map.json) kv('mapped strategies', Object.keys(map.json).length);
}

// ============================================================
// S16 — JOURNAL
// ============================================================
async function s16_journal() {
    section(16, 'JOURNAL');
    sub('Sync');
    const s = await httpGet(CONF.backend + '/api/journal/sync', { method: 'POST', timeout: 60000 });
    if (!s.ok) return warn(`sync ${s.status}`);
    if (s.json) {
        kv('created', s.json.created || 0);
        kv('updated', s.json.updated || 0);
    }
    sub('Stats');
    const j = await httpGet(CONF.backend + '/api/journal?limit=5');
    if (!j.ok) return warn(`journal ${j.status}`);
    const st = (j.json && j.json.stats) || {};
    kv('total', st.total || 0);
    kv('open', st.open || 0);
    kv('closed', st.closed || 0);
    kv('winRate', `${st.winRate || 0}%`);
    kv('PF', st.pf != null ? (st.pf === 999 ? '∞' : st.pf) : '-');
    kv('avgPnl', `${st.avgPnl || 0}%`);
}

// ============================================================
// S17 — PORTFOLIO ANALYSIS
// ============================================================
async function s17_portfolio() {
    section(17, 'PORTFOLIO ANALYSIS');
    if (CONF.skipHeavy) return info('skip-heavy');
    if (!await preHeavyCheck('S17 PORTFOLIO')) return;
    sub('Correlation refresh');
    const r = await httpGet(CONF.backend + '/api/portfolio/correlation/refresh?days=30', { method: 'POST', timeout: 120000 });
    if (!r.ok) return warn(`correlation refresh ${r.status}`);
    if (r.json) {
        kv('symbols', r.json.symbols || 0);
        kv('clusters', r.json.clusters || 0);
    }
    sub('Portfolio analysis');
    const a = await httpGet(CONF.backend + '/api/portfolio/analysis');
    if (!a.ok) return warn(`analysis ${a.status}`);
    if (a.json) {
        kv('symbols', a.json.symbolsCount || 0);
        kv('clusters', (a.json.clusters || []).length);
        kv('sectors', Object.keys(a.json.sectorDistribution || {}).length);
        const top = (a.json.clusters || []).slice(0, 3);
        for (const c of top) w(`     • cluster: ${c.slice(0, 5).join(', ')}${c.length > 5 ? '...' : ''}`);
    }
    sub('Whitelist');
    const wl = await httpGet(CONF.backend + '/api/portfolio/whitelist');
    if (wl.status === 404) info('whitelist ساخته نشده (طبیعی)');
    else if (wl.ok && wl.json) {
        kv('pairsCount', wl.json.pairsCount || 0);
        kv('strategies', (wl.json.strategies || []).length);
        kv('symbolsCount', wl.json.symbolsCount || 0);
    }
}

// ============================================================
// S18 — DUAL-STAGE PIPELINE (DRY RUN)
// ============================================================
async function s18_pipeline() {
    section(18, 'DUAL-STAGE PIPELINE (DRY RUN)');
    if (CONF.skipPipeline) return info('skip-pipeline');
    if (!await preHeavyCheck('S18 PIPELINE')) return;
    const symResp = await httpGet(CONF.backend + '/api/monitored-symbols');
    const syms = (symResp.ok ? symResp.json : []) || [];
    if (!syms.length) return warn('هیچ نماد');
    const strats = await httpGet(CONF.backend + '/api/strategies');
    const validIds = (strats.ok ? strats.json : []).slice(0, 2).map((s) => s.id);
    if (!validIds.length) return warn('strategies خالی');
    const target = syms.slice(0, 1).map((s) => s.symbol);
    kv('symbols', target.join(','));
    kv('strategies', validIds.join(','));

    const body = {
        symbols: target,
        strategies: validIds,
        dryRun: true,
        validationsDays: 30,
        minStockTrades: 3,
        minStockPF: 0.5,
        fdrQ: 0.1,
        minValidationPF: 0.5,
        maxConfirmers: 1,
        minOptionTrades: 1,
        goThreshold: 0.5,
        maybeThreshold: 0.3,
    };
    const r = await httpGet(CONF.backend + '/api/pipeline/dual-stage', { method: 'POST', body, timeout: 30000 });
    if (!r.ok) return fail(`start ${r.status}: ${(r.body || '').slice(0, 200)}`);
    const jobId = r.json && r.json.jobId;
    if (!jobId) return fail('jobId نیافت');
    kv('jobId', jobId);

    const deadline = Date.now() + 5 * 60 * 1000;
    let lastStage = -1;
    let final = null;
    while (Date.now() < deadline) {
        await sleep(4000);
        const jr = await httpGet(CONF.backend + `/api/pipeline/dual-stage/${jobId}`, { timeout: 30000 });
        if (!jr.ok) continue;
        final = jr.json;
        if (final.pipelineStage !== lastStage) {
            lastStage = final.pipelineStage;
            info(`  → stage ${lastStage} — ${(final.progress && final.progress.message) || ''}`);
        }
        if (['DONE', 'FAILED', 'CANCELLED'].includes(final.status)) break;
    }
    kv('final status', final && final.status, final && final.status === 'DONE' ? C.green : C.red);
    if (final && final.status === 'DONE' && final.result) {
        const s = final.result.summary || {};
        kv('totalCombos', s.totalCombos || 0);
        kv('candidates', s.candidates || 0);
        kv('validated', s.validated || 0);
        kv('plans', s.plans || 0);
        kv('GO/MAYBE/SKIP', `${s.go || 0} / ${s.maybe || 0} / ${s.skip || 0}`);
        kv('elapsed', `${final.result.elapsed || 0}s`);
        ok('dual-stage pipeline کامل شد');
    } else if (final && final.status === 'FAILED') {
        fail(`pipeline FAILED: ${final.error || '?'}`);
    }
}

// ============================================================
// S19 — BACKTEST MATRIX
// ============================================================
async function s19_backtest() {
    section(19, 'BACKTEST MATRIX');
    if (CONF.skipBacktest || CONF.skipHeavy) return info('skip-backtest');
    if (!await preHeavyCheck('S19 BACKTEST')) return;
    const symResp = await httpGet(CONF.backend + '/api/monitored-symbols');
    const syms = ((symResp.ok ? symResp.json : []) || []).slice(0, 2).map((s) => s.symbol);
    if (!syms.length) return warn('نماد نیست');
    const strats = await httpGet(CONF.backend + '/api/strategies');
    const strategyIds = ((strats.ok ? strats.json : []) || []).slice(0, 3).map((s) => ({ id: s.id }));
    kv('matrix', `${syms.length} × ${strategyIds.length} = ${syms.length * strategyIds.length}`);
    const to = Math.floor(Date.now() / 1000);
    const from = to - 45 * 86400;
    const body = {
        mode: 'option',
        symbols: syms, strategies: strategyIds,
        panels: {
            analysis: { enabled: true, minTrades: 3, iterations: 1000 },
            portfolio: { enabled: true, capital: 100000000, riskPct: 1.5 },
            wf: { enabled: false },
            regime: { enabled: true },
        },
        dateFrom: from, dateTo: to,
    };
    const r = await httpGet(CONF.backend + '/api/backtest/run', { method: 'POST', body, timeout: 30000 });
    if (!r.ok) return fail(`run ${r.status}`);
    const jobId = r.json && r.json.jobId;
    kv('jobId', jobId);
    const deadline = Date.now() + 3 * 60 * 1000;
    let final = null;
    while (Date.now() < deadline) {
        await sleep(4000);
        const jr = await httpGet(CONF.backend + `/api/backtest/results/${jobId}`);
        if (!jr.ok) continue;
        final = jr.json;
        if (final.computing) { info(`  → computing (${final.computingFor || 0}s)`); continue; }
        if (['DONE', 'FAILED', 'CANCELLED'].includes(final.status)) break;
    }
    if (!final || final.status !== 'DONE') return fail(`backtest status=${final && final.status}`);
    ok('backtest کامل');
    if (final.result) {
        const det = final.result.details || [];
        const valid = det.filter((d) => (d.optionStats && d.optionStats.count > 0) || (d.stockStats && d.stockStats.count > 0));
        kv('details', det.length);
        kv('valid', valid.length);
        if (final.result.portfolio && !final.result.portfolio.error) {
            const p = final.result.portfolio.stats || {};
            kv('portfolio return', `${p.totalReturnPct || 0}%`);
            kv('portfolio PF', p.profitFactor != null ? p.profitFactor : '-');
            kv('portfolio MaxDD', `${p.maxDD || 0}%`);
        }
        if (final.result.analysis && !final.result.analysis.error) {
            kv('analysis analyzed', final.result.analysis.totalAnalyzed || 0);
            kv('analysis passing', final.result.analysis.passing || 0);
        }
        if (final.result.regimes) {
            kv('regimes', final.result.regimes.length);
        }
    }
}

// ============================================================
// S20 — BALE / TELEGRAM
// ============================================================
async function s20_bale() {
    section(20, 'BALE / TELEGRAM');
    const tk = ENV.TELEGRAM_BOT_TOKEN, ch = ENV.TELEGRAM_CHAT_ID, base = ENV.TELEGRAM_API_BASE || 'https://api.telegram.org';
    kv('BOT_TOKEN set', tk ? '✓' : '✗', tk ? C.green : C.red);
    kv('CHAT_ID', ch ? `✓ (${ch.slice(0, 6)}...)` : '✗', ch ? C.green : C.red);
    kv('API_BASE', base);
    if (!tk || !ch) return warn('Bale/Telegram پیکربندی نشده');
    const msg = `🩺 OHDoctor Test\n${new Date().toISOString()}\nاگر این پیام را می‌بینی، سیستم ارسال کار می‌کند.`;
    const url = `${base}/bot${tk}/sendMessage`;
    const r = await httpGet(url, { method: 'POST', body: { chat_id: ch, text: msg }, timeout: 10000 });
    if (r.ok && r.json && r.json.ok) ok('پیام تست ارسال شد');
    else fail(`ارسال ناموفق: ${r.status} ${r.error || ''} ${(r.body || '').slice(0, 100)}`);

    // Also test outbox flush
    const flush = await httpGet(CONF.backend + '/api/telegram/test', { method: 'POST', timeout: 10000 });
    if (flush.ok) ok('outbox flush از backend موفق');
    else warn(`outbox flush: ${flush.status}`);
}

// ============================================================
// S21 — PERFORMANCE
// ============================================================
async function s21_perf() {
    section(21, 'PERFORMANCE');
    const tests = [
        { n: '/ping', u: '/ping', cnt: 20 },
        { n: '/api/quotes', u: '/api/quotes', cnt: 20 },
        { n: '/api/monitored-symbols', u: '/api/monitored-symbols', cnt: 10 },
        { n: '/api/algotik/coverage', u: '/api/algotik/coverage', cnt: 5 },
        { n: '/api/dashboard/live', u: '/api/dashboard/live', cnt: 10 },
    ];
    for (const t of tests) {
        sub(t.n);
        const times = [];
        for (let i = 0; i < t.cnt; i++) {
            const r = await httpGet(CONF.backend + t.u);
            times.push(r.ms);
        }
        times.sort((a, b) => a - b);
        const p50 = times[Math.floor(times.length * 0.5)];
        const p95 = times[Math.floor(times.length * 0.95)];
        const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
        kv('min/p50/p95/avg', `${fmtMs(times[0])} / ${fmtMs(p50)} / ${fmtMs(p95)} / ${fmtMs(avg)}`,
            p95 > 2000 ? C.red : p95 > 500 ? C.yellow : C.green);
    }
    sub('Concurrent 10× /api/quotes');
    const t0 = Date.now();
    const results = await Promise.all(Array(10).fill().map(() => httpGet(CONF.backend + '/api/quotes')));
    const elapsed = Date.now() - t0;
    const oks = results.filter((r) => r.ok).length;
    kv('elapsed', fmtMs(elapsed), elapsed > 5000 ? C.red : elapsed > 2000 ? C.yellow : C.green);
    kv('successful', `${oks}/10`, oks === 10 ? C.green : C.red);
}

// ============================================================
// S22 — SECURITY  (🚨 FIXED: async)
// ============================================================
async function s22_security() {
    section(22, 'SECURITY');

    sub('File permissions');
    for (const f of ['.env', 'ecosystem.config.js']) {
        const p = path.join(ROOT, f);
        if (!fs.existsSync(p)) continue;
        const m = (fs.statSync(p).mode & 0o777).toString(8);
        if (f === '.env' && !['600', '400', '640'].includes(m)) warn(`${f} → ${m} (توصیه 600)`);
        else info(`${f} → ${m}`);
    }

    sub('Secrets scan');
    const files = walk(ROOT, (f) => f.endsWith('.js') || f.endsWith('.py'));
    let found = false;
    for (const f of files) {
        const t = readText(f);
        if (/mongodb(\+srv)?:\/\/[^'"\s]+:[^'"\s@]+@/.test(t)) { fail('MongoDB URI hardcoded: ' + path.relative(ROOT, f)); found = true; }
        if (/\b\d{8,10}:[A-Za-z0-9_-]{35}\b/.test(t)) { fail('Token hardcoded: ' + path.relative(ROOT, f)); found = true; }
    }
    if (!found) ok('بدون secret hardcoded');

    sub('Auth test (POST without token)');
    const saved = CONF.adminToken;
    CONF.adminToken = '';
    try {
        const a = await httpGet(CONF.backend + '/api/telegram/test', { method: 'POST', timeout: 5000 });
        if (a.status === 401) ok('auth اجباری ✓');
        else if (a.status === 200 || a.status === 500) {
            const tknSet = !!saved;
            if (tknSet) warn(`auth غیرفعال! با ADMIN_TOKEN ست شده، اما بدون توکن قبول کرد (status ${a.status})`);
            else info(`ADMIN_TOKEN خالی است → همه‌چیز مجاز (فقط dev)`);
        } else info(`auth status: ${a.status}`);
    } finally { CONF.adminToken = saved; }

    sub('CORS');
    const cors = await httpGet(CONF.backend + '/ping', { method: 'OPTIONS' });
    info(`CORS: بدون محدودیت (cors() بدون options — اگر public است، محدود کن)`);

    sub('Rate limiting');
    info('بررسی: هیچ rate limiter در پروژه نیست — برای POSTها پیشنهاد می‌شود');
}

// ============================================================
// S23 — LOG TAIL
// ============================================================
function s23_logs() {
    section(23, 'LOG TAIL');
    const files = ['error.log', 'out.log', 'monitor.log', 'monitor-error.log'];
    for (const f of files) {
        const p = path.join(LOGS, f);
        sub(f);
        if (!fs.existsSync(p)) { info('غایب'); continue; }
        kv('size', fmtBytes(fileSize(p)));
        const t = tryShell(`tail -15 "${p}"`);
        if (!t.ok || !t.stdout.trim()) continue;
        const errs = t.stdout.split('\n').filter((l) => /error|exception|unhandled|fail/i.test(l));
        if (errs.length) {
            warn(`${errs.length} خط error در آخرین 15:`);
            for (const l of errs.slice(0, 4)) wc(`     ${l.slice(0, 130)}`, C.red);
        } else info('آخرین خطوط بدون error');
    }
}

// ============================================================
// S24 — REPORT + BALE NOTIFY
// ============================================================
async function s24_report() {
    section(24, 'FINAL REPORT');

    const elapsed = ((Date.now() - R.startedAt.getTime()) / 1000).toFixed(1);
    kv('Started', R.startedAt.toISOString());
    kv('Elapsed', elapsed + 's');
    kv('Total OK', R.oks.length, C.green);
    kv('Total warnings', R.warnings.length, R.warnings.length ? C.yellow : C.green);
    kv('Total issues', R.issues.length, R.issues.length ? C.red : C.green);

    if (R.issues.length) {
        w('');
        wc('  🚨 ISSUES:', C.bold + C.red);
        for (const m of R.issues.slice(0, 40)) wc('  • ' + m, C.red);
        if (R.issues.length > 40) wc(`  ... +${R.issues.length - 40}`, C.gray);
    }
    if (R.warnings.length) {
        w('');
        wc('  ⚠️  WARNINGS:', C.bold + C.yellow);
        for (const m of R.warnings.slice(0, 25)) wc('  • ' + m, C.yellow);
    }

    w('');
    bar();
    if (!R.issues.length && R.warnings.length < 5) wc('  🎯 ✅ سیستم سالم', C.green + C.bold);
    else if (!R.issues.length) wc('  🎯 🟡 OK با هشدار', C.yellow + C.bold);
    else if (R.issues.length < 5) wc('  🎯 🟠 چند مسئله', C.yellow + C.bold);
    else wc('  🎯 🔴 مشکلات جدی', C.red + C.bold);
    bar();

    // Save file
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const file = path.join(LOGS, `ohdoctor-${stamp}.txt`);
    if (!fs.existsSync(LOGS)) fs.mkdirSync(LOGS, { recursive: true });
    try {
        fs.writeFileSync(file, OUT.join('\n'), 'utf8');
        w('');
        w(`  📄 Report: ${file}`);
    } catch (e) { w(`  ⚠️ ذخیره ناموفق: ${e.message}`); }

    // JSON summary
    try {
        fs.writeFileSync(path.join(LOGS, `ohdoctor-${stamp}.json`), JSON.stringify({
            startedAt: R.startedAt, elapsed,
            issues: R.issues, warnings: R.warnings, oks: R.oks,
            sectionResults: R.sectionResults,
        }, null, 2), 'utf8');
    } catch (_) {}

    // Bale notify (only if requested)
    if (CONF.sendReport && ENV.TELEGRAM_BOT_TOKEN && ENV.TELEGRAM_CHAT_ID) {
        const base = ENV.TELEGRAM_API_BASE || 'https://api.telegram.org';
        const url = `${base}/bot${ENV.TELEGRAM_BOT_TOKEN}/sendMessage`;
        const header = `🩺 OHDoctor — ${R.startedAt.toISOString().slice(0, 19)}Z\n` +
            `Elapsed: ${elapsed}s\n` +
            `OK: ${R.oks.length} | ⚠️ ${R.warnings.length} | ❌ ${R.issues.length}\n`;
        const body = header +
            (R.issues.length ? '\n🚨 مسائل:\n' + R.issues.slice(0, 15).map((x) => `• ${x}`).join('\n') : '') +
            (R.warnings.length ? '\n\n⚠️ هشدارها:\n' + R.warnings.slice(0, 8).map((x) => `• ${x}`).join('\n') : '') +
            `\n\n📄 کامل: ${path.basename(file)}`;
        const txt = body.slice(0, 3800);
        await httpGet(url, { method: 'POST', body: { chat_id: ENV.TELEGRAM_CHAT_ID, text: txt }, timeout: 10000 });
        w('  📲 گزارش به Bale ارسال شد');
    } else if (CONF.sendReport) {
        w('  ℹ️ send-report درخواست شد اما Bale/Telegram پیکربندی نشده');
    }
}

// ============================================================
// MAIN
// ============================================================
async function runDoctor() {
    // ══════════════════════════════════════════════════════════
    // 🕐 GATE 1: فقط خارج از ساعت بازار (اجباری)
    // ══════════════════════════════════════════════════════════
    const mh = checkMarketHours();
    if (!mh.ok && !CONF.forceHours) {
        // در حالت --json هم باید JSON بدیم
        if (CONF.jsonOut) {
            console.log(JSON.stringify({ error: mh.reason, marketHours: mh, aborted: true }, null, 2));
        } else {
            console.error('');
            console.error('╔════════════════════════════════════════════════════════════════════╗');
            console.error('║  🚫 OHDoctor ABORTED — Market Hours Gate                          ║');
            console.error('╚════════════════════════════════════════════════════════════════════╝');
            console.error('');
            console.error(mh.reason);
            console.error('');
            console.error('  گزینه‌ها:');
            console.error('    --force-hours      اجرای اجباری (ریسک فشار روی سرور)');
            console.error('    --skip-heavy       فقط بخش‌های سبک (بدون backtest/pipeline)');
            console.error('');
            console.error('  پیشنهاد: اجرای خودکار در ساعت 14:00 با cron:');
            console.error('    0 14 * * 6,0,1,2,3 cd ~/apps/OptionHunter && node backend/scripts/monitor.js --send-report');
            console.error('');
        }
        process.exit(4);
    }

    // اگر safeMode و داخل پنجره‌ی خطر ولی --force-hours زده شده
    if (!mh.ok && CONF.forceHours) {
        console.error('');
        console.error('  ⚠️  [FORCE-HOURS] اجرا در ساعت بازار — ریسک فشار روی سرور');
    } else if (mh.ok) {
        // خارج از ساعت بازار → Safe Mode را خاموش کن (چون خطری نیست)
        // اما اگر skipHeavy دستی false بشه، احترام بذار
        // هیچ تغییری نیاز نیست
    }

    // ══════════════════════════════════════════════════════════
    // 🚦 GATE 2: هیچ job فعالی نباشد
    // ══════════════════════════════════════════════════════════
    const jobChk = await checkJobsIdle();
    if (!jobChk.idle) {
        if (CONF.waitForIdle) {
            console.error(`⏳ ${jobChk.count} job فعال — انتظار تا اتمام (حداکثر ${CONF.idleWaitMaxMin} دقیقه)...`);
            const w = await waitForJobsIdle(CONF.idleWaitMaxMin * 60 * 1000);
            if (!w.ok) {
                const msg = `⏱ timeout — ${jobChk.count} job پس از ${CONF.idleWaitMaxMin} دقیقه هنوز فعال است`;
                if (CONF.jsonOut) console.log(JSON.stringify({ error: msg, aborted: true }, null, 2));
                else console.error('❌ ' + msg);
                process.exit(5);
            }
            console.error(`✅ همه job ها تمام شدند (انتظار: ${(w.waited / 1000).toFixed(0)}s)`);
        } else if (!CONF.forceHours) {
            if (CONF.jsonOut) {
                console.log(JSON.stringify({
                    error: `${jobChk.count} job فعال`, jobs: jobChk.jobs, aborted: true,
                }, null, 2));
            } else {
                console.error('');
                console.error('╔════════════════════════════════════════════════════════════════════╗');
                console.error('║  🚦 OHDoctor ABORTED — Jobs Active                                ║');
                console.error('╚════════════════════════════════════════════════════════════════════╝');
                console.error('');
                console.error(`${jobChk.count} job در حال اجراست:`);
                for (const j of jobChk.jobs) {
                    console.error(`  • ${j.type} [${j.status}] ${j.message.slice(0, 80)}`);
                }
                console.error('');
                console.error('  گزینه‌ها:');
                console.error('    --wait-for-idle            صبر کن تا job ها تمام شوند');
                console.error('    --idle-wait=60             حداکثر ۶۰ دقیقه صبر (پیش‌فرض: ۳۰)');
                console.error('    --force-hours              اجراى اجبارى');
                console.error('');
            }
            process.exit(5);
        }
    }

    startSafetyWatchdog();

    if (!CONF.jsonOut) {
        w('');
        wc('╔════════════════════════════════════════════════════════════════════╗', C.bold + C.cyan);
        wc('║  🩺  OHDoctor v2 — Comprehensive Audit (24 sections)               ║', C.bold + C.cyan);
        wc('╚════════════════════════════════════════════════════════════════════╝', C.bold + C.cyan);
        w(`  Started: ${R.startedAt.toISOString()}`);
        w(`  Root: ${ROOT}`);
        w(`  Backend: ${CONF.backend}`);
        w(`  Collector: ${CONF.collector}`);
        w(`  Mode: skipHeavy=${CONF.skipHeavy} skipPipeline=${CONF.skipPipeline} skipBacktest=${CONF.skipBacktest} sendReport=${CONF.sendReport}`);
        if (CONF.sections) w(`  Sections filter: ${CONF.sections.join(',')}`);
        wc(`  🛡 Safety: safeMode=${SAFETY.safeMode} minFreeMem=${SAFETY.minFreeMemMB}MB maxSectionMs=${SAFETY.maxSectionMs / 1000}s`,
            SAFETY.safeMode ? C.green : C.yellow);
        if (!SAFETY.safeMode) warn('safeMode خاموش است — ریسک فشار روی سرور');
        if (mh.ok) wc(`  🕐 Market: ${mh.hint}`, C.green);
        else wc(`  🕐 Market: ${mh.hint}`, C.yellow);
        if (jobChk.idle) wc(`  🚦 Jobs: idle ✓`, C.green);
    }

    const run = async (n, title, fn, forceAsync) => {
        if (!sectionEnabled(n)) return;
        try {
            if (forceAsync) await fn();
            else fn();
        } catch (e) {
            fail(`S${n} crashed: ${e.message}`);
            if (CONF.verbose) w(e.stack);
        }
    };

    await run(1, 'ENV', s1_env);
    await run(2, 'STRUCTURE', s2_structure);
    await run(3, 'SYNTAX', s3_syntax);
    await run(4, 'PATTERNS', s4_patterns);
    await run(5, 'CONFIG', s5_config);
    await run(6, 'PM2', s6_pm2);
    await run(7, 'SYSTEMD', s7_systemd);
    await run(8, 'MONGO', s8_mongo, true);
    await run(9, 'HTTP', s9_backend_http, true);
    await run(10, 'COLLECTOR', s10_collector_http, true);
    await run(11, 'CROSS', s11_cross, true);
    await run(12, 'GAPS', s12_gaps, true);
    await run(13, 'LIVE-TICK', s13_live_tick, true);
    await run(14, 'STRATEGIES', s14_strategies, true);
    await run(15, 'REGIME', s15_regime, true);
    await run(16, 'JOURNAL', s16_journal, true);
    await run(17, 'PORTFOLIO', s17_portfolio, true);
    await run(18, 'PIPELINE', s18_pipeline, true);
    await run(19, 'BACKTEST', s19_backtest, true);
    await run(20, 'BALE', s20_bale, true);
    await run(21, 'PERF', s21_perf, true);
    await run(22, 'SECURITY', s22_security, true);
    await run(23, 'LOGS', s23_logs);
    await run(24, 'REPORT', s24_report, true);
    // 🆕 در انتهای main() بعد از همه اجراها:
    stopSafetyWatchdog();

    if (CONF.jsonOut) {
        // Write final JSON to stdout only
        const out = JSON.stringify({
            startedAt: R.startedAt,
            elapsed: ((Date.now() - R.startedAt.getTime()) / 1000).toFixed(1),
            issues: R.issues, warnings: R.warnings, oks: R.oks,
            sectionResults: R.sectionResults,
        }, null, 2);
        console.log(out);
    }
    process.exitCode = R.issues.length > 0 ? 1 : 0;
}

// ============================================================
// 🩺 DAEMON MODE — حلقه‌ی رصد سبک (برای PM2/OHMonitor)
// ============================================================
function runDaemon() {
    const LOGS_DIR = path.join(ROOT, 'logs');
    if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

    const tsLocal = () => new Date().toISOString();
    const tehranNow = () => new Date(Date.now() + 3.5 * 3600 * 1000);
    function isMarketHours() {
        const t = tehranNow();
        const wd = t.getUTCDay();
        const mins = t.getUTCHours() * 60 + t.getUTCMinutes();
        return [6, 0, 1, 2, 3].includes(wd) && mins >= 9 * 60 && mins <= 12 * 60 + 35;
    }
    function appendLog(f, line) {
        try { fs.appendFileSync(path.join(LOGS_DIR, f), line + '\n'); } catch (_) {}
    }
    function getNodeStats() {
        try {
            const raw = tryShell('pm2 jlist 2>/dev/null || echo "[]"', { timeout: 5000 }).stdout;
            const list = JSON.parse(raw);
            for (const p of list) {
                if (p.name === 'OptionHunter') {
                    return {
                        rssMB: Math.round(((p.monit && p.monit.memory) || 0) / 1048576),
                        cpu: (p.monit && p.monit.cpu) || 0,
                        restarts: (p.pm2_env && p.pm2_env.restart_time) || 0,
                    };
                }
            }
        } catch (_) {}
        return { rssMB: 0, cpu: 0, restarts: 0 };
    }
    function getCollectorStats() {
        try {
            const out = tryShell(
                'systemctl show collector -p MemoryCurrent,ActiveState --no-pager 2>/dev/null || true',
                { timeout: 5000 }
            ).stdout;
            const m = {};
            out.split('\n').forEach((l) => {
                const i = l.indexOf('=');
                if (i > 0) m[l.slice(0, i)] = l.slice(i + 1);
            });
            return {
                memMB: m.MemoryCurrent && m.MemoryCurrent !== '[not set]'
                    ? Math.round(+m.MemoryCurrent / 1048576) : 0,
                active: m.ActiveState === 'active',
            };
        } catch (_) {}
        return { memMB: 0, active: false };
    }
    function tick() {
        const total = os.totalmem() / 1048576;
        const free = os.freemem() / 1048576;
        const used = total - free;
        const load = os.loadavg()[0];
        const node = getNodeStats();
        const coll = getCollectorStats();
        const line = `[${tsLocal()}] ` +
            `Node:${node.rssMB}M(${node.cpu}%) rst:${node.restarts} | ` +
            `Coll:${coll.memMB}M ${coll.active ? '✓' : '✗'} | ` +
            `RAM:${used.toFixed(0)}/${total.toFixed(0)}M free:${free.toFixed(0)}M | ` +
            `Load:${load.toFixed(2)}`;
        appendLog('monitor.log', line);
        if (isMarketHours()) {
            const day = new Date().toISOString().slice(0, 10);
            appendLog(`market-${day}.log`, line);
        }
        if (node.rssMB > 750) appendLog('monitor.log', `[${tsLocal()}] ⚠️ Node RAM: ${node.rssMB}M`);
        if (free < 150) appendLog('monitor.log', `[${tsLocal()}] ⚠️ RAM free: ${free.toFixed(0)}M`);
        if (node.restarts > 50) appendLog('monitor.log', `[${tsLocal()}] ⚠️ Restarts: ${node.restarts}`);
    }
    console.log(`[${tsLocal()}] monitor.js (daemon mode) started, PID=${process.pid}`);
    tick();
    const timer = setInterval(tick, 30000);
    process.on('SIGTERM', () => { clearInterval(timer); process.exit(0); });
    process.on('SIGINT', () => { clearInterval(timer); process.exit(0); });
}

// ============================================================
// 🚀 DISPATCH
// ============================================================
console.log(`[monitor.js] mode=${MODE} (pm2=${_underPm2}, args=[${ARGV.join(' ')}])`);
if (MODE === 'daemon') {
    runDaemon();
} else {
    runDoctor().catch((e) => { console.error('FATAL:', e); process.exit(2); });
}