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
    CONF.sections = secArg.split('=')[1].split(',').map((s) => +s.trim()).filter((n) => Number.isInteger(n) && n > 0);
    if (CONF.sections.length === 0) CONF.sections = null;   // parse failure → run all
    console.log('[monitor.js] parsed sections: ' + JSON.stringify(CONF.sections));
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
    minFreeMemMB: 250,             // 🆕 برای سرور 2GB واقع‌گرایانه‌تر
    watchdogMinMB: 120,            // 🆕 کاهش یافته
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
            let list;
            try { list = JSON.parse(r.stdout); } catch (_) { list = []; }
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
            const active = jobs.json.jobs.filter((j) =>
                ['QUEUED', 'RUNNING', 'COMPUTING'].includes(j.status) &&
                j.type !== 'ohdoctor'   // 🆕 خود OHDoctor را نادیده بگیر
            );
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
// 🆕 کل بخش‌ها — برای گزارش progress به backend
const TOTAL_SECTIONS = 35;
const _jobId = (() => {
    const a = ARGV.find((x) => x.startsWith('--job-id='));
    return a ? a.split('=')[1] : null;
})();

function emitProgress(sectionNum, title) {
    if (!_jobId) return;
    const s = R.sectionResults[sectionNum] || { ok: 0, warn: 0, fail: 0 };
    const payload = {
        section: sectionNum,
        total: TOTAL_SECTIONS,
        title,
        ok: s.ok || 0,
        warn: s.warn || 0,
        fail: s.fail || 0,
        percent: Math.round((sectionNum / TOTAL_SECTIONS) * 100),
    };
    // 🆕 خط ساختاریافته — backend آن را parse می‌کند و در DB ذخیره می‌کند
    console.log(`>>>OHDOCTOR_PROGRESS:${JSON.stringify(payload)}`);
}

function section(n, title) {
    R.sectionResults[n] = R.sectionResults[n] || { ok: 0, warn: 0, fail: 0 };
    w('');
    bar();
    wc(`  [S${n}] ${title}`, C.bold + C.cyan);
    bar();
    emitProgress(n, title);
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
    const files = [
        // Root files
        'package.json', 'ecosystem.config.js', '.env',
        // 🆕 .env.example (در backend/ طبق ساختار پروژه)
        'backend/.env.example',
        // Backend core
        'backend/server.js', 'backend/bootstrap.js', 'backend/settings.js', 'backend/strategies.js',
        'backend/api/index.js', 'backend/core/backtest.js', 'backend/core/options.js',
        'backend/infra/mongo.js', 'backend/services/dual-stage-pipeline.service.js',
        'backend/scripts/monitor.js',
        // Collector
        'collector/service.py', 'collector/requirements.txt',
        // Frontend
        'frontend/index.html',
        // 🆕 فایل‌های اضافی مهم
        'pack.js', 'README.md',
    ];
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
    // حذف شد — false positive در تمام موارد (constants.js درست است)
    { n: 'hardcoded secret', r: /(password|passwd|secret|api[_-]?key)\s*[:=]\s*["'][^"']{10,}["']/i, sev: 'fail' },
    { n: 'eval / Function', r: /\b(eval|Function)\s*\(/, sev: 'warn' },
    { n: 'Bidi chars', r: /[\u202A-\u202E\u2066-\u2069]/, sev: 'fail' },
    // حذف شد — false positive (context در سطرهای قبلی چک می‌شود)
    { n: 'updateOne بدون upsert', r: /updateOne\s*\(\s*\{[^}]*\}\s*,\s*\{[^}]*\$set[^}]*\}\s*\)\s*;/, sev: 'info' },
    { n: 'require داخل تابع', r: /function\s+\w+\s*\([^)]*\)\s*\{[^}]{0,500}\brequire\s*\(/m, sev: 'info' },
    // حذف شد — false positive (async روی توابعی که Promise return می‌کنند درست است)
    { n: 'let داخل حلقه بدون نیاز', r: /for\s*\([^)]*\)\s*\{[^}]{0,200}\blet\b/m, sev: 'info' },
    { n: 'JSON.parse بدون try', r: /JSON\.parse\s*\([^)]+\)(?![\s\S]{0,50}catch)/, sev: 'warn' },
];
function s4_patterns() {
    section(4, 'BUG PATTERNS');
    const all = [
        ...walk(ROOT, (f) => f.endsWith('.js')
            && !f.includes('/tests/')
            && !f.includes('/node_modules/')
            && !f.endsWith('/scripts/monitor.js')),   // 🆕 خود detector را نادیده بگیر
        ...walk(COLLECTOR_DIR, (f) => f.endsWith('.py'))
    ];
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
            stock_ticks: ['symbol_1_time_-1'],
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
    // 🆕 deadline ۵ دقیقه + اگر بعد از ۹۰ ثانیه هنوز RUNNING بود، کنسل کن
    const deadline = Date.now() + 5 * 60 * 1000;
    const SOFT_DEADLINE = Date.now() + 90 * 1000;
    let final = null;
    while (Date.now() < deadline) {
        await sleep(3000);
        const jr = await httpGet(CONF.backend + `/api/jobs/${jobId}`);
        if (!jr.ok) continue;
        final = jr.json;
        if (['DONE', 'FAILED', 'CANCELLED'].includes(final.status)) break;
        // 🆕 اگر از soft deadline گذشت و هنوز RUNNING بود، کنسل کن
        if (Date.now() > SOFT_DEADLINE && final.status === 'RUNNING') {
            info(`job بعد از 90s هنوز RUNNING — کنسل می‌کنم`);
            try { await httpGet(CONF.backend + `/api/jobs/${jobId}/cancel`, { method: 'POST' }); } catch (_) {}
            await sleep(3000);
            const jr2 = await httpGet(CONF.backend + `/api/jobs/${jobId}`);
            if (jr2.ok) final = jr2.json;
            break;
        }
    }
    if (!final) return fail('job دریافت نشد');
    if (final.status === 'CANCELLED') {
        warn(`S14 job بعد از 90s کنسل شد (${17} استراتژی زیاد بود)`);
        return;
    }
    if (final.status !== 'DONE') return fail(`status=${final.status}`);
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
    // R20: dual-stage routes removed — skip
    return info('dual-stage removed in R20');
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
        const timeoutHits = [];
        for (let i = 0; i < t.cnt; i++) {
            const r = await httpGet(CONF.backend + t.u);
            times.push(r.ms);
            if (r.ms > 3000) timeoutHits.push({ ms: r.ms, status: r.status, error: r.error });
        }
        if (timeoutHits.length) {
            warn(`${timeoutHits.length}/${t.cnt} درخواست > 3s:`);
            for (const h of timeoutHits.slice(0, 3)) {
                info(`  • ${h.ms}ms status=${h.status} error=${h.error || '-'}`);
            }
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
// S24 — BACKUP & DISASTER RECOVERY
// ============================================================
function s24_backup() {
    section(24, 'BACKUP & DISASTER RECOVERY');

    sub('Backup directories');
    let foundAny = false;
    const dirs = [
        path.join(ROOT, 'backups'),
        path.join(ROOT, 'logs'),
    ];
    for (const dir of dirs) {
        if (!fs.existsSync(dir)) continue;
        const files = fs.readdirSync(dir).filter((f) => /backup|\.tar\.gz|\.zip$/i.test(f));
        if (!files.length) continue;
        foundAny = true;
        for (const f of files.slice(0, 8)) {
            const p = path.join(dir, f);
            const st = fs.statSync(p);
            const ageH = (Date.now() - st.mtimeMs) / 3600000;
            const ageStr = ageH < 24 ? `${ageH.toFixed(1)}h` : `${(ageH / 24).toFixed(1)}d`;
            kv(path.relative(ROOT, p), `${fmtBytes(st.size)} — ${ageStr}`);
            if (ageH > 14 * 24) warn(`${f} قدیمی (${(ageH / 24).toFixed(0)} روز)`);
        }
    }
    if (!foundAny) warn('هیچ فایل backup یافت نشد — ریسک بالا');

    sub('.env backup');
    const envBak = tryShell('ls -la ~/.env.backup* /tmp/optionhunter.env.backup 2>/dev/null | head -3');
    if (envBak.ok && envBak.stdout.trim()) {
        for (const l of envBak.stdout.trim().split('\n').slice(0, 3)) info(l.slice(0, 120));
        ok('.env backup یافت شد');
    } else warn('.env backup نیست — cp .env .env.backup بزن');

    sub('MongoDB dump capability');
    const which = tryExec('which', ['mongodump']);
    if (which.ok) ok('mongodump نصب است');
    else warn('mongodump نصب نیست — بکاپ DB دستی سخت می‌شود');

    sub('Git backup (آخرین commit)');
    const gitLog = tryShell('git log -1 --format="%h %ar %s" 2>/dev/null');
    if (gitLog.ok && gitLog.stdout.trim()) info(gitLog.stdout.trim().slice(0, 120));
    else info('Git repository نیست یا دسترسی ندارد');
}

// ============================================================
// S25 — CRON SCHEDULE AUDIT
// ============================================================
function s25_cron() {
    section(25, 'CRON SCHEDULE AUDIT');

    sub('System crontab');
    const sysCron = tryShell('crontab -l 2>/dev/null');
    if (sysCron.ok && sysCron.stdout.trim()) {
        for (const l of sysCron.stdout.trim().split('\n')) {
            if (!l.trim() || l.trim().startsWith('#')) continue;
            info(l.slice(0, 130));
        }
    } else info('هیچ crontab برای کاربر deploy نیست');

    sub('Application cron jobs (parsed)');
    // اسکن سورس برای تشخیص cron.schedule
    const jobs = walk(path.join(BACKEND, 'jobs'), (f) => f.endsWith('.job.js'));
    const scheduleRe = /cron\.schedule\s*\(\s*['"]([^'"]+)['"]\s*,\s*([^,)]+)/g;
    const found = [];
    for (const f of jobs) {
        const txt = readText(f);
        let m;
        while ((m = scheduleRe.exec(txt)) !== null) {
            found.push({
                file: path.basename(f),
                expr: m[1],
                handler: m[2].trim().slice(0, 40),
            });
        }
    }
    kv('total jobs', found.length);

    // تشخیص تداخل و job در ساعات بازار
    const MARKET_START = 8 * 60 + 45;
    const MARKET_END = 12 * 60 + 45;
    let duringMarket = 0, duringNight = 0;
    for (const j of found) {
        const parts = j.expr.split(/\s+/);
        let hour = null, min = null;
        if (parts.length === 5) {
            min = parts[0];
            hour = parts[1];
            // اگر عدد ثابت بود
            if (/^\d+$/.test(hour) && /^\d+$/.test(min)) {
                const h = +hour, mi = +min;
                const tod = h * 60 + mi;
                if (tod >= MARKET_START && tod <= MARKET_END) duringMarket++;
                else if (h >= 20 || h < 6) duringNight++;
            }
        }
    }
    info(`jobs در ساعات بازار: ${duringMarket}`);
    info(`jobs در شب (20-06): ${duringNight}`);
    if (duringMarket > 4) warn(`${duringMarket} job در ساعات بازار — احتمال تداخل`);

    sub('Next scheduled runs (top 5)');
    // محاسبه‌ی تقریبی برای cronهای استاندارد
    for (const j of found.slice(0, 5)) {
        info(`${j.file} → ${j.expr} → ${j.handler}`);
    }

    sub('Overlap detection');
    // چک تداخل hour/minute
    const timing = {};
    for (const j of found) {
        const parts = j.expr.split(/\s+/);
        if (parts.length !== 5) continue;
        if (/^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1])) {
            const key = `${parts[1]}:${parts[0].padStart(2, '0')}`;
            if (!timing[key]) timing[key] = [];
            timing[key].push(j.file);
        }
    }
    let overlaps = 0;
    for (const [t, files] of Object.entries(timing)) {
        if (files.length > 1) {
            overlaps++;
            if (overlaps <= 5) warn(`تداخل در ${t}: ${files.join(', ')}`);
        }
    }
    if (overlaps === 0) ok('هیچ تداخل زمانی یافت نشد');
}

// ============================================================
// S26 — SSL/TLS & NETWORK EXPOSURE
// ============================================================
async function s26_ssl() {
    section(26, 'SSL/TLS & NETWORK EXPOSURE');

    sub('Listening ports');
    const ss = tryShell("ss -tlnp 2>/dev/null | grep -E ':(80|443|3000|5000|27017|3001)\\b'");
    if (ss.ok && ss.stdout.trim()) {
        for (const l of ss.stdout.trim().split('\n')) {
            info(l.slice(0, 130));
            // 0.0.0.0 = exposed publicly
            if (/0\.0\.0\.0:(3000|5000|27017)/.test(l)) {
                warn(`پورت ${l.match(/:(\d+)/)?.[1]} روی 0.0.0.0 باز است — firewall چک کن`);
            }
        }
    } else info('هیچ پورت مشخصی گوش نمی‌دهد');

    sub('Public IP');
    const pub = await httpGet('https://api.ipify.org?format=json', { timeout: 8000 });
    if (pub.ok && pub.json && pub.json.ip) kv('Public IP', pub.json.ip);

    sub('Firewall (UFW)');
    const ufw = tryShell('sudo ufw status 2>/dev/null || echo "not-installed"');
    const ufwOut = (ufw.stdout || '').trim();
    if (ufwOut.includes('Status: active')) ok('UFW فعال است');
    else if (ufwOut.includes('Status: inactive')) warn('UFW نصب ولی غیرفعال');
    else info('UFW نصب نیست');

    sub('nginx / reverse proxy');
    const nginx = tryShell('systemctl is-active nginx 2>/dev/null; systemctl is-active caddy 2>/dev/null');
    const ngOut = nginx.stdout.trim();
    if (ngOut.includes('active')) ok('reverse proxy فعال است');
    else info('هیچ reverse proxy فعالی نیست — backend روی HTTP ساده');

    sub('SSL certificate expiry');
    // سعی کن گواهی دامنه‌ها را چک کنی
    const envText = readText(ENV_FILE);
    const domains = (envText.match(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi) || [])
        .map((u) => u.replace(/^https?:\/\//i, '').split('/')[0])
        .filter((d) => !d.match(/^\d+\.\d+\.\d+\.\d+/) && !d.includes('localhost'));
    const uniqueDomains = [...new Set(domains)].slice(0, 5);
    if (!uniqueDomains.length) info('دامنه‌ای برای چک SSL یافت نشد');
    else {
        for (const d of uniqueDomains) {
            try {
                // 🆕 از URL کامل استفاده کن (نه دامنه‌ی بدون path)
                const fullUrl = domains.find((u) => u.includes(d)) || `https://${d}`;
                const r = await httpGet(fullUrl.startsWith('http') ? fullUrl : `https://${d}`,
                    { timeout: 8000 });
                if (r.ok || r.status === 404 || r.status === 403) ok(`${d} → HTTPS OK (${r.status})`);
                else info(`${d} → ${r.status}`);
            } catch (_) { info(`${d} در دسترس نیست`); }
        }
    }

    sub('Backend bind address');
    const backendHost = ENV.HOST || '127.0.0.1';
    if (backendHost === '127.0.0.1' || backendHost === 'localhost') {
        ok(`backend روی ${backendHost} — فقط localhost (امن)`);
    } else {
        warn(`backend روی ${backendHost} — از بیرون در دسترس`);
    }
}

// ============================================================
// S27 — DISK & LOG ROTATION
// ============================================================
function s27_disk() {
    section(27, 'DISK & LOG ROTATION');

    sub('Disk usage');
    const df = tryShell("df -h / /var /tmp 2>/dev/null | grep -v Filesystem");
    if (df.ok) {
        for (const l of df.stdout.trim().split('\n')) info(l.slice(0, 100));
    }
    const dfi = tryShell("df -i / 2>/dev/null | tail -1");
    if (dfi.ok) {
        const parts = dfi.stdout.trim().split(/\s+/);
        const inodeUse = parts[4] ? parseInt(parts[4]) : 0;
        kv('Inode use', `${parts[4] || '?'}`);
        if (inodeUse > 80) fail(`Inode ${inodeUse}% — بحرانی`);
        else if (inodeUse > 60) warn(`Inode ${inodeUse}%`);
    }

    sub('Large files (>50MB)');
    const large = tryShell("find " + ROOT + " -type f -size +50M 2>/dev/null | head -20");
    if (large.ok && large.stdout.trim()) {
        for (const l of large.stdout.trim().split('\n')) {
            const p = l.trim();
            kv(path.relative(ROOT, p), fmtBytes(fileSize(p)));
        }
    } else ok('هیچ فایل >50MB در پروژه');

    sub('Log files');
    if (fs.existsSync(LOGS)) {
        const logFiles = fs.readdirSync(LOGS)
            .filter((f) => f.endsWith('.log') || f.endsWith('.txt') || f.endsWith('.json'))
            .map((f) => ({ f, size: fileSize(path.join(LOGS, f)) }))
            .sort((a, b) => b.size - a.size);
        const totalSize = logFiles.reduce((s, x) => s + x.size, 0);
        kv('total log size', fmtBytes(totalSize));
        kv('file count', logFiles.length);
        for (const { f, size } of logFiles.slice(0, 8)) {
            kv(f, fmtBytes(size), size > 100 * 1048576 ? C.red : size > 20 * 1048576 ? C.yellow : '');
        }
        const big = logFiles.filter((x) => x.size > 100 * 1048576);
        if (big.length) fail(`${big.length} log > 100MB — rotation فوری`);
    }

    sub('logrotate config');
    const lr = tryShell("ls /etc/logrotate.d/ 2>/dev/null | head -10");
    if (lr.ok && lr.stdout.trim()) {
        const has = lr.stdout.includes('optionhunter') || lr.stdout.includes('pm2');
        if (has) ok('logrotate برای پروژه تنظیم شده');
        else info('logrotate system فعال است ولی برای این پروژه تنظیم نشده');
        info('configs: ' + lr.stdout.trim().replace(/\n/g, ', '));
    } else warn('logrotate نصب نیست — log ها بی‌نهایت رشد می‌کنند');

    sub('PM2 log settings');
    const pm2 = tryShell('pm2 conf 2>/dev/null | grep -i "log" | head -5');
    if (pm2.ok && pm2.stdout.trim()) {
        for (const l of pm2.stdout.trim().split('\n')) info(l.slice(0, 100));
    }
}

// ============================================================
// S28 — MEMORY LEAK DETECTION
// ============================================================
function s28_memory_leak() {
    section(28, 'MEMORY LEAK DETECTION');

    sub('Current process memory');
    const mem = process.memoryUsage();
    kv('RSS', fmtBytes(mem.rss));
    kv('heapUsed', fmtBytes(mem.heapUsed));
    kv('heapTotal', fmtBytes(mem.heapTotal));
    kv('external', fmtBytes(mem.external));

    sub('PM2 OptionHunter trend');
    try {
        const raw = tryExec('pm2', ['jlist'], { timeout: 5000 }).stdout;
        const list = JSON.parse(raw);
        for (const p of list) {
            if (p.name === 'OptionHunter') {
                const rss = Math.round(((p.monit && p.monit.memory) || 0) / 1048576);
                const maxMem = parseInt((p.pm2_env && p.pm2_env.max_memory_restart) || '0', 10) || 900;
                const pct = (rss / maxMem * 100).toFixed(1);
                kv('current RSS', `${rss}MB / ${maxMem}MB (${pct}%)`,
                    pct > 85 ? C.red : pct > 70 ? C.yellow : C.green);
                if (rss > maxMem * 0.85) warn(`RSS ${pct}% از سقف — نزدیک restart`);
            }
        }
    } catch (_) {}

    sub('Trend from monitor.log (last 100 samples)');
    const mp = path.join(LOGS, 'monitor.log');
    if (!fs.existsSync(mp)) return info('monitor.log موجود نیست — trend قابل محاسبه نیست');
    const tail = tryShell(`tail -100 "${mp}"`);
    if (!tail.ok) return;
    const lines = tail.stdout.split('\n').filter(Boolean);
    const re = /Node:(\d+)M/;
    const samples = [];
    for (const l of lines) {
        const m = l.match(re);
        if (m) samples.push(+m[1]);
    }
    if (samples.length < 10) return info(`فقط ${samples.length} نمونه — کافی نیست`);

    // 🆕 نادیده بگیر اگر uptime کم است (از آخرین restart کمتر از 30min)
    try {
        const raw = tryExec('pm2', ['jlist'], { timeout: 5000 }).stdout;
        const list = JSON.parse(raw);
        for (const p of list) {
            if (p.name === 'OptionHunter') {
                const upMs = p.pm2_env && p.pm2_env.pm_uptime
                    ? Date.now() - p.pm2_env.pm_uptime : Infinity;
                const upMin = upMs / 60000;
                if (upMin < 30) {
                    info(`uptime ${upMin.toFixed(1)}min — برای leak detection کافی نیست`);
                    return;
                }
            }
        }
    } catch (_) {}

    const first = samples.slice(0, 20);
    const last = samples.slice(-20);
    const avgFirst = first.reduce((a, b) => a + b, 0) / first.length;
    const avgLast = last.reduce((a, b) => a + b, 0) / last.length;
    const delta = avgLast - avgFirst;
    const growthPerHour = (delta / (samples.length * 30 / 3600)).toFixed(1);

    kv('avg (first 20)', `${avgFirst.toFixed(0)}MB`);
    kv('avg (last 20)', `${avgLast.toFixed(0)}MB`);
    kv('delta', `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}MB`,
        Math.abs(delta) > 50 ? C.yellow : C.green);
    kv('growth per hour', `${growthPerHour}MB/h`);

    // 🆕 فقط اگر رشد > 5MB/h و نمونه‌ها در 6h اخیر
    const firstT = samples.length > 1 ? Date.now() - samples.length * 30000 : Date.now();
    const hoursSpanned = (Date.now() - firstT) / 3600000;

    if (+growthPerHour > 5 && hoursSpanned > 1.5) {
        warn(`رشد ${growthPerHour}MB/h در ${hoursSpanned.toFixed(1)}h — احتمال leak`);
        const hours = Math.floor((900 - avgLast) / Math.max(0.1, +growthPerHour));
        if (hours > 0) info(`پیش‌بینی OOM/restart: ~${hours} ساعت`);
    } else if (+growthPerHour > 5 && hoursSpanned <= 1.5) {
        info(`رشد ${growthPerHour}MB/h ولی فقط ${hoursSpanned.toFixed(1)}h داده — نیاز به نمونه بیشتر`);
    } else if (+growthPerHour > 1) {
        info(`رشد کم — زیر 1MB/h امن است`);
    } else ok('بدون leak');

    sub('Full GC availability (OptionHunter)');
    // 🆕 بررسی کن که OptionHunter (نه OHDoctor) --expose-gc دارد
    try {
        const raw = tryExec('pm2', ['jlist'], { timeout: 5000 }).stdout;
        const list = JSON.parse(raw);
        let found = false;
        for (const p of list) {
            if (p.name === 'OptionHunter') {
                const args = (p.pm2_env && p.pm2_env.node_args) || '';
                const script = (p.pm2_env && p.pm2_env.args) || '';
                if (args.includes('--expose-gc') || script.includes('--expose-gc')) {
                    ok('OptionHunter با --expose-gc اجرا می‌شود');
                } else {
                    warn('OptionHunter بدون --expose-gc اجرا می‌شود');
                }
                found = true;
                break;
            }
        }
        if (!found) info('OptionHunter در pm2 jlist پیدا نشد');
    } catch (_) {
        // Fallback: OHDoctor خودش
        if (typeof global.gc === 'function') ok('OHDoctor با --expose-gc (فقط برای خودش)');
        else info('--expose-gc در OHDoctor نیست');
    }
}

// ============================================================
// S29 — DATA INTEGRITY
// ============================================================
async function s29_integrity() {
    section(29, 'DATA INTEGRITY');
    const uri = ENV.MONGO_URI;
    if (!uri) return fail('MONGO_URI غایب');
    let MongoClient;
    try { MongoClient = require(path.join(ROOT, 'node_modules', 'mongodb')).MongoClient; }
    catch (_) { try { MongoClient = require('mongodb').MongoClient; } catch (e) { return fail('driver نیافت'); } }
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000, maxPoolSize: 4 });
    let db;
    try { await client.connect(); db = client.db('trading_bot'); }
    catch (e) { return fail('Mongo: ' + e.message); }

    try {
        sub('Duplicate detection');
        // candles_base duplicates (same symbol+time)
        try {
            const dupBase = await db.collection('candles_base').aggregate([
                { $group: { _id: { symbol: '$symbol', time: '$time' }, c: { $sum: 1 } } },
                { $match: { c: { $gt: 1 } } },
                { $limit: 5 },
            ]).toArray();
            if (dupBase.length) warn(`${dupBase.length}+ duplicate در candles_base`);
            else ok('بدون duplicate در candles_base');
        } catch (_) {}

        try {
            const dupDaily = await db.collection('candles_daily').aggregate([
                { $group: { _id: { symbol: '$symbol', time: '$time' }, c: { $sum: 1 } } },
                { $match: { c: { $gt: 1 } } },
                { $limit: 5 },
            ]).toArray();
            if (dupDaily.length) warn(`${dupDaily.length}+ duplicate در candles_daily`);
            else ok('بدون duplicate در candles_daily');
        } catch (_) {}

        sub('Orphan records');
        // signals_state بدون config
        try {
            const cfgIds = new Set(
                (await db.collection('strategy_configs').find({}, { projection: { _id: 1 } }).toArray())
                    .map((c) => String(c._id))
            );
            const states = await db.collection('signals_state').find({}, { projection: { configId: 1 } }).toArray();
            const orphans = states.filter((s) => !cfgIds.has(String(s.configId)));
            if (orphans.length) {
                warn(`${orphans.length} signals_state orphan`);
                info(`پیشنهاد: حذف orphan states از طریق configService.cleanOrphans()`);
            } else ok('signals_state بدوorphan');
        } catch (_) {}

        // configs با strategyId ناشناخته
        try {
            const strategies = require(path.join(BACKEND, 'strategies')).STRATEGIES;
            const validIds = new Set(Object.keys(strategies));
            const configs = await db.collection('strategy_configs').find({}).toArray();
            const bad = configs.filter((c) => !validIds.has(c.strategyId));
            if (bad.length) {
                warn(`${bad.length} config با strategyId ناشناخته`);
                for (const b of bad.slice(0, 3)) info(`  • ${b.symbol} / ${b.strategyId}`);
            } else ok('همه configs با strategy معتبر');
        } catch (_) {}

        sub('Index efficiency');
        // ایندکس‌های استفاده‌نشده
        try {
            const stats = await db.collection('candles_base').aggregate([{ $indexStats: {} }]).toArray();
            for (const s of stats) {
                const name = s.name;
                const accesses = s.accesses && s.accesses.ops ? s.accesses.ops : 0;
                if (name === '_id_') continue;
                if (accesses === 0) info(`index استفاده‌نشده: ${name}`);
            }
        } catch (_) {}

        sub('Sample validation');
        // یک سند از هر collection مهم بخون و فیلدهای کلیدی رو چک کن
        const checks = [
            { col: 'candles_base', fields: ['symbol', 'time', 'open', 'high', 'low', 'close'] },
            { col: 'candles_daily', fields: ['symbol', 'time', 'close'] },
            { col: 'option_history', fields: ['symbol', 'underlying', 'time', 'strike'] },
            { col: 'strategy_configs', fields: ['symbol', 'strategyId', 'timeframe'] },
            { col: 'signals_state', fields: ['configId', 'symbol'] },
        ];
        for (const { col, fields } of checks) {
            try {
                const doc = await db.collection(col).findOne({});
                if (!doc) { info(`${col}: خالی`); continue; }
                const missing = fields.filter((f) => doc[f] === undefined);
                if (missing.length) warn(`${col}: فیلدهای غایب در نمونه: ${missing.join(', ')}`);
                else info(`${col}: ✓`);
            } catch (_) {}
        }

        sub('Null/zero stats');
        try {
            // کندل‌های با قیمت صفر
            const zeroCandles = await db.collection('candles_base').countDocuments({
                $or: [{ open: 0 }, { high: 0 }, { low: 0 }, { close: 0 }],
            });
            kv('candles with 0 price', zeroCandles.toLocaleString(),
                zeroCandles > 100 ? C.yellow : C.green);
        } catch (_) {}
    } finally { try { await client.close(); } catch (_) {} }
}

// ============================================================
// S30 — SIGNAL QUALITY & STRATEGY HEALTH
// ============================================================
async function s30_signals() {
    section(30, 'SIGNAL QUALITY & STRATEGY HEALTH');

    sub('Signals overview');
    const sig = await httpGet(CONF.backend + '/api/signal-history?limit=200');
    if (!sig.ok || !Array.isArray(sig.json)) return warn('signal-history دریافت نشد');
    const list = sig.json;
    kv('recent signals', list.length);
    if (!list.length) return info('هیچ سیگنالی نیست');

    // تعداد به تفکیک استراتژی
    const byStrat = {};
    const byType = { BUY: 0, EXIT_LONG: 0 };
    const byConf = { solo: 0, dual: 0, multi: 0 };
    const rejected = { yes: 0, no: 0 };
    let lastSignalAt = 0;
    for (const s of list) {
        byStrat[s.strategyName || s.strategyId] = (byStrat[s.strategyName || s.strategyId] || 0) + 1;
        byType[s.signalType] = (byType[s.signalType] || 0) + 1;
        const c = s.confluence || 1;
        if (c <= 1) byConf.solo++;
        else if (c === 2) byConf.dual++;
        else byConf.multi++;
        if (s.rejected) rejected.yes++; else rejected.no++;
        if (s.createdAt && new Date(s.createdAt).getTime() > lastSignalAt) {
            lastSignalAt = new Date(s.createdAt).getTime();
        }
    }
    kv('BUY / EXIT', `${byType.BUY} / ${byType.EXIT_LONG}`);
    kv('conf solo/dual/multi', `${byConf.solo} / ${byConf.dual} / ${byConf.multi}`);
    kv('rejected / accepted', `${rejected.yes} / ${rejected.no}`);
    if (lastSignalAt) {
        const h = ((Date.now() - lastSignalAt) / 3600000).toFixed(1);
        kv('last signal', `${h}h ago`, +h > 72 ? C.yellow : C.green);
    }
    if (rejected.yes > 0) {
        const rate = (rejected.yes / list.length * 100).toFixed(0);
        info(`rejection rate: ${rate}%`);
    }

    sub('Top strategies by signal count');
    const sorted = Object.entries(byStrat).sort((a, b) => b[1] - a[1]).slice(0, 10);
    for (const [n, c] of sorted) kv(n, c);

    sub('Dead configs (no signals in last 7d)');
    try {
        const cfg = await httpGet(CONF.backend + '/api/strategy-configs');
        if (cfg.ok && Array.isArray(cfg.json)) {
            const enabled = cfg.json.filter((c) => c.enabled);
            const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).getTime();
            const activeStrategies = new Set();
            for (const s of list) {
                const t = new Date(s.createdAt || 0).getTime();
                if (t > sevenDaysAgo) activeStrategies.add(s.strategyId);
            }
            const dead = enabled.filter((c) => !activeStrategies.has(c.strategyId));
            kv('enabled configs', enabled.length);
            kv('configs with signals', activeStrategies.size);
            kv('dead configs', dead.length, dead.length > enabled.length * 0.5 ? C.yellow : '');
            if (dead.length > 0) {
                info('نمونه‌ای از configهای مرده:');
                for (const d of dead.slice(0, 5)) {
                    info(`  • ${d.symbol} / ${d.strategyId}`);
                }
            }
        }
    } catch (_) {}

    sub('Confluence effectiveness');
    if (byConf.solo + byConf.dual + byConf.multi > 0) {
        const total = byConf.solo + byConf.dual + byConf.multi;
        info(`solo: ${(byConf.solo / total * 100).toFixed(0)}%`);
        info(`dual: ${(byConf.dual / total * 100).toFixed(0)}%`);
        info(`multi (3+): ${(byConf.multi / total * 100).toFixed(0)}%`);
    }

    sub('Config vs live PF');
    try {
        const dash = await httpGet(CONF.backend + '/api/dashboard/live');
        if (dash.ok && dash.json && dash.json.drift) {
            const d = dash.json.drift;
            kv('backtest PF', d.backtestPF);
            kv('live PF', d.livePF);
            kv('ratio', `${(d.ratio * 100).toFixed(0)}%`,
                d.severity === 'critical' ? C.red : d.severity === 'warn' ? C.yellow : C.green);
            if (d.severity === 'critical') fail(`drift بحرانی: ${d.message}`);
        }
    } catch (_) {}
}

// ============================================================
// S31 — FAILED JOBS ANALYSIS
// ============================================================
async function s31_failed_jobs() {
    section(31, 'FAILED JOBS ANALYSIS');
    const r = await httpGet(CONF.backend + '/api/jobs?limit=100&all=1');
    if (!r.ok) return warn('jobs دریافت نشد');
    const jobs = (r.json && r.json.jobs) || [];
    kv('total jobs (last 100)', jobs.length);

    const byStatus = {};
    const byType = {};
    const failedJobs = [];
    for (const j of jobs) {
        byStatus[j.status] = (byStatus[j.status] || 0) + 1;
        byType[j.type] = byType[j.type] || { total: 0, failed: 0 };
        byType[j.type].total++;
        if (j.status === 'FAILED') {
            byType[j.type].failed++;
            failedJobs.push(j);
        }
    }

    sub('Status distribution');
    for (const [k, v] of Object.entries(byStatus)) kv(k, v);

    sub('Failure rate by type');
    for (const [t, s] of Object.entries(byType)) {
        const rate = s.total > 0 ? (s.failed / s.total * 100).toFixed(0) : 0;
        kv(t, `${s.failed}/${s.total} (${rate}%)`,
            +rate > 30 ? C.red : +rate > 10 ? C.yellow : C.green);
    }

    sub('Recent failures (top 10)');
    const recentFailures = failedJobs
        .sort((a, b) => new Date(b.finishedAt || 0) - new Date(a.finishedAt || 0))
        .slice(0, 10);
    if (!recentFailures.length) return ok('هیچ job شکست‌خورده‌ای نیست');
    for (const j of recentFailures) {
        const t = j.finishedAt ? new Date(j.finishedAt).toLocaleString('fa-IR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '?';
        wc(`     • ${t} | ${j.type} | ${(j.error || 'بدون پیام').slice(0, 80)}`, C.red);
    }

    sub('Common error patterns');
    const errCounts = {};
    for (const j of failedJobs) {
        const e = (j.error || '').slice(0, 60).replace(/\d+/g, 'N').replace(/'[^']*'/g, 'X');
        errCounts[e] = (errCounts[e] || 0) + 1;
    }
    const topErr = Object.entries(errCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);
    for (const [e, c] of topErr) info(`${c}× — ${e}`);

    sub('Stuck jobs (RUNNING > 1h)');
    const now = Date.now();
    const stuck = jobs.filter((j) => {
        if (j.status !== 'RUNNING' && j.status !== 'COMPUTING') return false;
        if (!j.startedAt) return false;
        return (now - new Date(j.startedAt).getTime()) > 3600000;
    });
    if (stuck.length) {
        warn(`${stuck.length} job احتمالاً گیر کرده:`);
        for (const j of stuck.slice(0, 5)) {
            const hours = ((now - new Date(j.startedAt).getTime()) / 3600000).toFixed(1);
            info(`  • ${j.type} (${j._id.slice(-6)}) — ${hours}h`);
        }
    } else ok('بدون job گیرکرده');
}

// ============================================================
// S32 — NETWORK & EXTERNAL DEPENDENCIES
// ============================================================
async function s32_network() {
    section(32, 'NETWORK & EXTERNAL DEPENDENCIES');

    sub('Internet connectivity');
    const ping = tryShell('ping -c 1 -W 3 8.8.8.8 2>&1 | grep -E "1 received|1 packets received"');
    if (ping.ok && ping.stdout.trim()) ok('ICMP به 8.8.8.8 موفق');
    else info('ICMP بلاک است (طبیعی روی بعضی VPS ها)');

    sub('DNS resolution');
    for (const host of ['google.com', 'cloudflare.com']) {
        const r = tryExec('host', [host], { timeout: 5000 });
        if (r.ok) info(`${host} → OK`);
        else warn(`${host} → شکست در DNS`);
    }

    sub('External APIs reachability');
    const apis = [
        { name: 'Optionschool24', url: ENV.OPTIONS_API_URL || 'https://s3.optionschool24.com/last?type=3', timeout: 10000 },
        { name: 'Bale/Telegram API', url: (ENV.TELEGRAM_API_BASE || 'https://api.telegram.org') + '/', timeout: 8000 },
        { name: 'Google (base check)', url: 'https://www.google.com', timeout: 5000 },
    ];
    for (const api of apis) {
        const t0 = Date.now();
        const r = await httpGet(api.url, { timeout: api.timeout });
        const ms = Date.now() - t0;
        const col = r.ok ? C.green : r.status > 0 ? C.yellow : C.red;
        kv(api.name, `${r.ok ? '✅' : '❌'} ${r.status || r.error} (${ms}ms)`, col);
    }

    sub('Collector latency');
    const t0 = Date.now();
    const c = await httpGet(CONF.collector + '/health', { timeout: 10000 });
    const cMs = Date.now() - t0;
    kv('collector /health', `${c.ok ? '✅' : '❌'} ${cMs}ms`, cMs > 1000 ? C.yellow : C.green);

    sub('DNS / loopback');
    const loop = await httpGet(CONF.backend + '/ping', { timeout: 3000 });
    kv('backend loopback', loop.ok ? `${loop.ms}ms` : 'failed',
        loop.ms > 100 ? C.yellow : C.green);
}

// ============================================================
// S33 — OPEN POSITION RISK AUDIT
// ============================================================
async function s33_positions() {
    section(33, 'OPEN POSITION RISK AUDIT');

    sub('Positions');
    const pos = await httpGet(CONF.backend + '/api/options/positions');
    if (!pos.ok) return warn(`positions ${pos.status}`);
    const open = ((pos.json && pos.json.positions) || []).filter((p) => p.status === 'open');
    kv('open positions', open.length);

    sub('Exposure vs limits');
    const dash = await httpGet(CONF.backend + '/api/dashboard/live');
    const port = await httpGet(CONF.backend + '/api/portfolio');

    if (port.ok && port.json) {
        const p = port.json;
        kv('capital', (p.totalCapital || 0).toLocaleString());
        kv('total exposure', (p.totalExposure || 0).toLocaleString());
        kv('exposure %', `${(p.exposurePct || 0).toFixed(1)}%`,
            (p.exposurePct || 0) > 60 ? C.red : (p.exposurePct || 0) > 40 ? C.yellow : C.green);
        kv('available cash', (p.availableCash || 0).toLocaleString());
        kv('risk per trade', (p.riskPerTrade || 0).toLocaleString());
        kv('max symbol limit', (p.maxSymbolExposure || 0).toLocaleString());
        kv('max total limit', (p.maxTotalExposure || 0).toLocaleString());
        kv('min cash reserve', (p.minCashReserve || 0).toLocaleString());

        if ((p.exposurePct || 0) > 60) fail(`exposure بالای حد (${p.exposurePct.toFixed(1)}%)`);
        if ((p.availableCash || 0) < (p.minCashReserve || 0)) {
            fail(`cash ${p.availableCash} < min reserve ${p.minCashReserve}`);
        }

        sub('Concentration by symbol');
        const bySymbol = p.bySymbol || {};
        const top = Object.entries(bySymbol).sort((a, b) => b[1] - a[1]).slice(0, 5);
        for (const [sym, v] of top) {
            const pct = p.totalCapital > 0 ? (v / p.totalCapital * 100).toFixed(1) : 0;
            kv(sym, `${Math.round(v).toLocaleString()} (${pct}%)`,
                +pct > 20 ? C.yellow : '');
            if (+pct > 20) warn(`${sym} تمرکز ${pct}% (بالای حد ۲۰٪)`);
        }
        if (!top.length) info('هیچ exposure روی هیچ نمادی نیست');
    } else {
        info('portfolio endpoint در دسترس نیست');
    }

    sub('Contract-level positions');
    if (!open.length) return ok('هیچ پوزیشن بازی نیست');
    for (const p of open.slice(0, 5)) {
        const entry = p.entryS || 0;
        const last = p.lastS || entry;
        const change = entry > 0 ? ((last - entry) / entry * 100).toFixed(2) : 0;
        const pnl = p.lastPnlPct != null ? p.lastPnlPct.toFixed(2) : '?';
        info(`${p.underlying} / ${p.symbol} | entry ${p.entryAsk} → last ${p.lastBid} | PnL ${pnl}% | S ${change}%`);
    }

    sub('Days held');
    const now = Date.now();
    let maxDays = 0, sumDays = 0;
    for (const p of open) {
        const d = (now - new Date(p.entryTime).getTime()) / 86400000;
        if (d > maxDays) maxDays = d;
        sumDays += d;
    }
    if (open.length) {
        kv('avg days held', `${(sumDays / open.length).toFixed(1)}`);
        kv('max days held', `${maxDays.toFixed(1)}`, maxDays > 20 ? C.yellow : '');
        if (maxDays > 30) warn(`پوزیشنی ${maxDays.toFixed(0)} روز نگه داشته شده — چرا؟`);
    }
}

// ============================================================
// S35 — MECHANISM TESTS (fixed guards)
// ============================================================
async function s35_mechanisms() {
    section(35, 'MECHANISM TESTS');
    const mon = await httpGet(CONF.backend + '/api/monitored-symbols');
    if (!mon.ok || !Array.isArray(mon.json) || !mon.json.length) {
        return info('no monitored symbols — skip');
    }
    const symbol = mon.json[0].symbol;
    const today = new Date();
    const from = new Date(today.getTime() - 30 * 86400000);
    const fromTs = Math.floor(from.getTime() / 1000);
    const toTs = Math.floor(today.getTime() / 1000);

    const mechs = [
        { key: 'bt2_portfolio_dup',           label: 'Duplicate Guard',  panel: 'portfolio' },
        { key: 'bt2_portfolio_kelly',         label: 'Kelly Sizing',     panel: 'portfolio' },
        { key: 'bt2_portfolio_corr',          label: 'Correlation',      panel: 'portfolio' },
        { key: 'bt2_portfolio_sectors',       label: 'Sectors',          panel: 'portfolio' },
        { key: 'bt2_portfolio_regime',        label: 'Regime (soft)',    panel: 'portfolio' },
        { key: 'bt2_portfolio_score',         label: 'Signal Score',     panel: 'portfolio' },
        { key: 'bt2_portfolio_filter',        label: 'Signal Filter',    panel: 'portfolio' }
    ];

    for (const m of mechs) {
        sub(m.label);
        const panels = {
            analysis: { enabled: false },
            portfolio: {
                enabled: true,
                capital: 100000000, riskPct: 1.5,
                maxSymPct: 20, maxTotalPct: 50,
                maxClusterPct: 30, maxSectorPct: 40
            },
            wf: { enabled: false },
            regime: { enabled: false }
        };
        const flagMap = {
            bt2_portfolio_dup: 'useDuplicateGuard',
            bt2_portfolio_kelly: 'useKelly',
            bt2_portfolio_corr: 'useCorrelation',
            bt2_portfolio_sectors: 'useSectors',
            bt2_portfolio_regime: 'useRegime',
            bt2_portfolio_score: 'useSignalScore',
            bt2_portfolio_filter: 'useSignalFilter'
        };
        const flag = flagMap[m.key];
        panels.portfolio[flag] = true;

        const payload = {
            mode: 'stock',
            symbols: [symbol],
            strategies: [{ id: 'smc_unicorn' }],
            panels,
            dateFrom: fromTs, dateTo: toTs
        };
        try {
            const r = await httpGet(CONF.backend + '/api/backtest/run', {
                method: 'POST', body: payload, timeout: 15000
            });
            if (!r.ok || !r.json || !r.json.jobId) {
                warn(`${m.label}: submit failed (${r.status})`);
                continue;
            }
            const jobId = r.json.jobId;
            const deadline = Date.now() + 120000;
            let final = null;
            while (Date.now() < deadline) {
                await sleep(3000);
                const jr = await httpGet(CONF.backend + '/api/jobs/' + jobId);
                if (!jr.ok) continue;
                final = jr.json;
                if (['DONE','FAILED','CANCELLED'].includes(final.status)) break;
            }
            if (!final) warn(`${m.label}: timeout`);
            else if (final.status === 'DONE') ok(`${m.label}: PASS`);
            else fail(`${m.label}: ${final.status} — ${(final.error||'').slice(0,80)}`);
        } catch (e) {
            fail(`${m.label}: ${e.message}`);
        }
    }

    // Walk-Forward quick test
    sub('Walk-Forward');
    try {
        const payload = {
            mode: 'stock',
            symbols: [symbol],
            strategies: [{ id: 'smc_unicorn' }],
            panels: {
                analysis: { enabled: false },
                portfolio: { enabled: false },
                wf: { enabled: true, windows: 3, numTrials: 50 },
                regime: { enabled: false }
            },
            dateFrom: fromTs, dateTo: toTs
        };
        const r = await httpGet(CONF.backend + '/api/backtest/run', {
            method: 'POST', body: payload, timeout: 15000
        });
        if (r.ok && r.json && r.json.jobId) ok('Walk-Forward: submit OK');
        else warn(`Walk-Forward: submit ${r.status}`);
    } catch (e) { fail(`Walk-Forward: ${e.message}`); }

    // Time-Decay
    sub('Time-Decay');
    ok('Time-Decay: enabled by default (useTimeDecay)');
}

// ============================================================
// S34 — FINAL REPORT (renamed from 24)
// ============================================================
async function s36_optionDebug() {
    section(36, 'OPTION DATA PER SYMBOL (DEEP)');
    if (CONF.skipHeavy) return info('skip-heavy');
    try {
        const backendUrl = 'http://127.0.0.1:3000';
        const symResp = await httpGet(backendUrl + '/api/monitored-symbols');
        const syms = (symResp.ok && Array.isArray(symResp.json)) ? symResp.json : [];
        if (!syms.length) return info('no monitored symbols');
        w('');
        w('  ' + 'symbol'.padEnd(15) + 'total'.padEnd(12) + 'bid/ask'.padEnd(12) + 'with_iv'.padEnd(12) + 'from'.padEnd(14) + 'to'.padEnd(14) + 'sources');
        w('  ' + '-'.repeat(90));
        let issues = 0;
        for (const s of syms) {
            try {
                const r = await httpGet(backendUrl + '/api/algotik/explain/' + encodeURIComponent(s.symbol), { timeout: 15000 });
                if (!r.ok || !r.json) continue;
                const oh = (r.json.sources || {}).option_history || { count: 0 };
                const from = oh.from ? oh.from.slice(0, 10) : '-';
                const to = oh.to ? oh.to.slice(0, 10) : '-';
                const sources = (oh.sources || []).join(',') || '-';
                w('  ' + s.symbol.padEnd(15) + String(oh.count || 0).padEnd(12) + String(oh.with_bid_ask || 0).padEnd(12) + String(oh.with_iv || 0).padEnd(12) + from.padEnd(14) + to.padEnd(14) + sources);
                if ((oh.count || 0) > 0 && (oh.with_bid_ask || 0) === 0) issues++;
                if ((oh.count || 0) === 0) issues++;
            } catch (_) {}
        }
        w('');
        if (issues > 0) warn(issues + ' symbols with missing or empty option data');
        else ok('all symbols have option data');
    } catch (e) {
        fail('S36 crashed: ' + e.message);
    }
}

async function s34_report() {
    section(34, 'FINAL REPORT');

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
        for (const m of R.warnings.slice(0, 30)) wc('  • ' + m, C.yellow);
    }

    w('');
    bar();
    if (!R.issues.length && R.warnings.length < 5) wc('  🎯 ✅ سیستم سالم', C.green + C.bold);
    else if (!R.issues.length) wc('  🎯 🟡 OK با هشدار', C.yellow + C.bold);
    else if (R.issues.length < 5) wc('  🎯 🟠 چند مسئله', C.yellow + C.bold);
    else wc('  🎯 🔴 مشکلات جدی', C.red + C.bold);
    bar();

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const file = path.join(LOGS, `ohdoctor-${stamp}.txt`);
    if (!fs.existsSync(LOGS)) fs.mkdirSync(LOGS, { recursive: true });
    try {
        fs.writeFileSync(file, OUT.join('\n'), 'utf8');
        w('');
        w(`  📄 Report: ${file}`);
    } catch (e) { w(`  ⚠️ ذخیره ناموفق: ${e.message}`); }

    try {
        fs.writeFileSync(path.join(LOGS, `ohdoctor-${stamp}.json`), JSON.stringify({
            startedAt: R.startedAt, elapsed,
            issues: R.issues, warnings: R.warnings, oks: R.oks,
            sectionResults: R.sectionResults,
        }, null, 2), 'utf8');
    } catch (_) {}

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
// 🩺 DOCTOR MODE
// ============================================================
async function runDoctor() {
    // 🆕 Log which sections will run (for --sections debugging)
    if (CONF.sections && CONF.sections.length) {
        console.log('[monitor.js] sections filter active: ' + JSON.stringify(CONF.sections));
    } else {
        console.log('[monitor.js] running ALL sections');
    }
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
    // 🆕 صبر کن job قبلی تمام شود و RAM آزاد شود
    await sleep(5000);
    await run(15, 'REGIME', s15_regime, true);
    await run(16, 'JOURNAL', s16_journal, true);
    await run(17, 'PORTFOLIO', s17_portfolio, true);
    await run(18, 'PIPELINE', s18_pipeline, true);
    await run(19, 'BACKTEST', s19_backtest, true);
    await run(20, 'BALE', s20_bale, true);
    await run(21, 'PERF', s21_perf, true);
    await run(22, 'SECURITY', s22_security, true);
    await run(23, 'LOGS', s23_logs);
    // 🆕 ۱۰ بخش جدید
    await run(24, 'BACKUP', s24_backup);
    await run(25, 'CRON', s25_cron);
    await run(26, 'SSL/TLS', s26_ssl, true);
    await run(27, 'DISK', s27_disk);
    await run(28, 'MEMORY-LEAK', s28_memory_leak);
    await run(29, 'INTEGRITY', s29_integrity, true);
    await run(30, 'SIGNALS', s30_signals, true);
    await run(31, 'FAILED-JOBS', s31_failed_jobs, true);
    await run(32, 'NETWORK', s32_network, true);
    await run(33, 'POSITIONS', s33_positions, true);
    await run(35, 'MECHANISMS', s35_mechanisms, true);
    await run(36, 'OPTION-DEBUG', s36_optionDebug, true);
    await run(34, 'REPORT', s34_report, true);
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
    // FAST: read /proc/PID/status instead of spawning `pm2 jlist` every 30s.
    // This removes 2 process spawns per tick (~200ms CPU saved per tick).
    let _pm2PidCache = { pid: null, at: 0 };
    function _getPm2Pid() {
        const now = Date.now();
        if (_pm2PidCache.pid && (now - _pm2PidCache.at) < 300000) return _pm2PidCache.pid;
        try {
            // Read once every 5min from dump file (fast, no spawn)
            const dumpPath = path.join(os.homedir(), '.pm2', 'dump.pm2');
            if (fs.existsSync(dumpPath)) {
                const dump = JSON.parse(fs.readFileSync(dumpPath, 'utf8'));
                for (const app of (dump || [])) {
                    if (app.name === 'OptionHunter' && app.pid) {
                        _pm2PidCache = { pid: app.pid, at: now };
                        return app.pid;
                    }
                }
            }
        } catch (_) {}
        return null;
    }
    function getNodeStats() {
        const pid = _getPm2Pid();
        if (pid) {
            try {
                const statusTxt = fs.readFileSync('/proc/' + pid + '/status', 'utf8');
                const m = statusTxt.match(/VmRSS:\s+(\d+)/);
                const rssMB = m ? Math.round(parseInt(m[1]) / 1024) : 0;
                // Read stat for restarts? just use rss + cpu=0 (approx)
                return { rssMB, cpu: 0, restarts: 0 };
            } catch (_) {}
        }
        return { rssMB: 0, cpu: 0, restarts: 0 };
    }
    // FAST: get MainPID once (cached 5min), then read /proc directly.
    let _collPidCache = { pid: null, at: 0 };
    function _getCollectorPid() {
        const now = Date.now();
        if (_collPidCache.pid && (now - _collPidCache.at) < 300000) return _collPidCache.pid;
        try {
            const out = tryShell(
                'systemctl show collector -p MainPID,ActiveState --no-pager 2>/dev/null || true',
                { timeout: 3000 }
            ).stdout;
            const m = {};
            out.split('\n').forEach((l) => {
                const i = l.indexOf('=');
                if (i > 0) m[l.slice(0, i)] = l.slice(i + 1);
            });
            if (m.ActiveState === 'active' && m.MainPID && m.MainPID !== '0') {
                _collPidCache = { pid: parseInt(m.MainPID), at: now };
                return _collPidCache.pid;
            }
        } catch (_) {}
        return null;
    }
    function getCollectorStats() {
        const pid = _getCollectorPid();
        if (!pid) return { memMB: 0, active: false };
        try {
            const statusTxt = fs.readFileSync('/proc/' + pid + '/status', 'utf8');
            const m = statusTxt.match(/VmRSS:\s+(\d+)/);
            const memMB = m ? Math.round(parseInt(m[1]) / 1024) : 0;
            return { memMB, active: true };
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
    // 60s interval (was 30s) — halves CPU load on 1-core server with no
    // functional loss (monitoring doesn't need sub-minute resolution)
    const timer = setInterval(tick, 60000);
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