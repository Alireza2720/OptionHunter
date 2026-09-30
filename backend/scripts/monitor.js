'use strict';
// ============================================================
// monitor.js — رصد مداوم + جمع‌آوری ساعات بازار
// ============================================================
// - هر ۳۰ ثانیه snapshot → logs/monitor.log
// - در ساعات بازار → logs/market-YYYY-MM-DD.log (با جزئیات)
// - آخر روز بازار (12:40) → logs/market-summary-YYYY-MM-DD.txt
// - نگه‌داری ۷ روز

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const LOG_DIR = path.join(__dirname, '..', '..', 'logs');
const MAIN_LOG = path.join(LOG_DIR, 'monitor.log');
const INTERVAL_MS = 120000;   // 🆕 از 30s به 120s (کاهش CPU)
const MAX_MAIN_LINES = 5000;
const KEEP_MAIN_LINES = 2000;
const RETENTION_DAYS = 7;

// ─── helpers ───
function safe(cmd, fallback = '?') {
    try { return execSync(cmd, { timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
    catch { return fallback; }
}

function ensureDir() {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

function getTehranNow() {
    const now = new Date();
    const tehran = new Date(now.getTime() + 3.5 * 3600 * 1000);
    return {
        year: tehran.getUTCFullYear(),
        month: tehran.getUTCMonth() + 1,
        day: tehran.getUTCDate(),
        weekday: tehran.getUTCDay(),
        hours: tehran.getUTCHours(),
        minutes: tehran.getUTCMinutes(),
        minutesOfDay: tehran.getUTCHours() * 60 + tehran.getUTCMinutes(),
    };
}

function dateKey() {
    const t = getTehranNow();
    return `${t.year}-${String(t.month).padStart(2, '0')}-${String(t.day).padStart(2, '0')}`;
}

function isTradingDay(t) {
    return [6, 0, 1, 2, 3].includes(t.weekday);
}

function isMarketOpen(t) {
    return isTradingDay(t) && t.minutesOfDay >= 9 * 60 && t.minutesOfDay <= 12 * 60 + 35;
}

function isMarketSummaryTime(t) {
    // ۱۲:۴۰ — بعد از بسته شدن بازار
    return isTradingDay(t) && t.hours === 12 && t.minutes === 40;
}

// ─── collectors ───
function getNodeRss() {
    try {
        const arr = JSON.parse(safe('pm2 jlist'));
        const me = arr.find(x => x.name === 'OptionHunter');
        return me ? Math.round(me.monit.memory / 1048576) : '?';
    } catch { return '?'; }
}

function getNodeCpu() {
    try {
        const arr = JSON.parse(safe('pm2 jlist'));
        const me = arr.find(x => x.name === 'OptionHunter');
        return me ? (me.monit.cpu || 0) : '?';
    } catch { return '?'; }
}

function getNodeRestarts() {
    try {
        const arr = JSON.parse(safe('pm2 jlist'));
        const me = arr.find(x => x.name === 'OptionHunter');
        return me ? (me.pm2_env.restart_time || 0) : '?';
    } catch { return '?'; }
}

function getCollectorRss() {
    const v = safe('systemctl show collector -p MemoryCurrent');
    const m = v.match(/MemoryCurrent=(\d+)/);
    return m ? Math.round(+m[1] / 1048576) : '?';
}

function getCollectorCpu() {
    const out = safe("ps -C python -o pcpu= 2>/dev/null | head -1");
    return out ? parseFloat(out).toFixed(1) : '?';
}

function getMongoCpu() {
    const out = safe("top -bn1 | grep mongod | head -1 | awk '{print $9}'");
    return out || '0.0';
}

function getMongoConn() {
    return safe("ss -tan 2>/dev/null | grep -c ':27017'") || '0';
}

function getCpuTotal() {
    const out = safe("vmstat 1 2 | tail -1 | awk '{print 100 - $15}'");
    return out ? Math.round(parseFloat(out)) : '?';
}

function getMemory() {
    const out = safe("free -m | awk 'NR==2 {print $3, $4, $7}'");
    const parts = out.split(/\s+/);
    return { used: parts[0] || '?', free: parts[1] || '?', avail: parts[2] || '?' };
}

function getSwap() {
    return safe("free -m | awk 'NR==3 {print $3}'") || '0';
}

function getLoad() {
    return safe("uptime | awk -F'load average:' '{print $2}' | xargs");
}

// ─── main snapshot ───
function snapshot() {
    const t = getTehranNow();
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const lines = [];

    const cpu = getCpuTotal();
    const nodeRss = getNodeRss();
    const nodeCpu = getNodeCpu();
    const collRss = getCollectorRss();
    const collCpu = getCollectorCpu();
    const mongoCpu = getMongoCpu();
    const mongoConn = getMongoConn();
    const mem = getMemory();
    const swap = getSwap();
    const restarts = getNodeRestarts();
    const load = getLoad();

    const marketFlag = isMarketOpen(t) ? 'MARKET' : (isTradingDay(t) ? 'TRADING' : 'CLOSED');

    const line = `${ts} | ${marketFlag} | CPU:${cpu}% Node:${nodeRss}M(${nodeCpu}%) | Coll:${collRss}M(${collCpu}%) | Mongo:${mongoCpu}%c${mongoConn} | RAM:${mem.used}/${mem.free}/${mem.avail}M | swap:${swap} | restarts:${restarts} | load:${load}`;

    // 1) log اصلی
    ensureDir();
    fs.appendFileSync(MAIN_LOG, line + '\n');

    // prune main log
    try {
        const content = fs.readFileSync(MAIN_LOG, 'utf-8');
        const arr = content.split('\n');
        if (arr.length > MAX_MAIN_LINES) {
            fs.writeFileSync(MAIN_LOG, arr.slice(-KEEP_MAIN_LINES).join('\n'));
        }
    } catch (_) {}

    // 2) log ساعات بازار
    if (isMarketOpen(t)) {
        const marketLog = path.join(LOG_DIR, `market-${dateKey()}.log`);
        fs.appendFileSync(marketLog, line + '\n');
    }

    // 3) خلاصه‌ی روز در ۱۲:۴۰
    if (isMarketSummaryTime(t)) {
        generateSummary();
    }

    // 4) پاک‌سازی فایل‌های قدیمی (فقط یک‌بار در روز — ساعت ۱۳:۰۰)
    if (isTradingDay(t) && t.hours === 13 && t.minutes === 0) {
        pruneOldFiles();
    }

    console.log(line);
}

// ─── خلاصه‌ی روز ───
function generateSummary() {
    const key = dateKey();
    const marketLog = path.join(LOG_DIR, `market-${key}.log`);
    const summaryFile = path.join(LOG_DIR, `market-summary-${key}.txt`);

    if (!fs.existsSync(marketLog)) {
        fs.writeFileSync(summaryFile, `خلاصه‌ی ${key}\nهیچ داده‌ای ثبت نشد.\n`);
        return;
    }

    const lines = fs.readFileSync(marketLog, 'utf-8').split('\n').filter(Boolean);
    if (!lines.length) {
        fs.writeFileSync(summaryFile, `خلاصه‌ی ${key}\nهیچ نمونه‌ای ثبت نشد.\n`);
        return;
    }

    // استخراج اعداد
    function extract(regex, line) {
        const m = line.match(regex);
        return m ? parseFloat(m[1]) : null;
    }

    const samples = lines.map(l => ({
        line: l,
        cpu: extract(/CPU:(\d+)%/, l),
        nodeRss: extract(/Node:(\d+)M/, l),
        nodeCpu: extract(/Node:\d+M\(([\d.]+)%\)/, l),
        collRss: extract(/Coll:(\d+)M/, l),
        mongoCpu: extract(/Mongo:([\d.]+)%/, l),
        mongoConn: extract(/c(\d+)/, l),
        ramUsed: extract(/RAM:(\d+)/, l),
        ramFree: extract(/RAM:\d+\/(\d+)/, l),
        swap: extract(/swap:(\d+)/, l),
        restarts: extract(/restarts:(\d+)/, l),
        load: extract(/load:([\d.]+)/, l),
    }));

    const valid = samples.filter(s => s.cpu !== null && s.nodeRss !== null);
    if (!valid.length) {
        fs.writeFileSync(summaryFile, `خلاصه‌ی ${key}\nهیچ نمونه‌ی معتبری نیست.\n`);
        return;
    }

    const stat = (arr, fn) => {
        const vals = arr.map(fn).filter(v => v !== null && Number.isFinite(v));
        if (!vals.length) return { min: '-', max: '-', avg: '-', p95: '-' };
        vals.sort((a, b) => a - b);
        const sum = vals.reduce((a, b) => a + b, 0);
        return {
            min: Math.round(vals[0] * 10) / 10,
            max: Math.round(vals[vals.length - 1] * 10) / 10,
            avg: Math.round((sum / vals.length) * 10) / 10,
            p95: Math.round(vals[Math.floor(vals.length * 0.95)] * 10) / 10,
        };
    };

    const startLine = valid[0].line.split('|')[0].trim();
    const endLine = valid[valid.length - 1].line.split('|')[0].trim();

    const stats = {
        samples: valid.length,
        duration: `از ${startLine} تا ${endLine}`,
        cpu: stat(valid, s => s.cpu),
        nodeRss: stat(valid, s => s.nodeRss),
        nodeCpu: stat(valid, s => s.nodeCpu),
        collRss: stat(valid, s => s.collRss),
        mongoCpu: stat(valid, s => s.mongoCpu),
        mongoConn: stat(valid, s => s.mongoConn),
        ramUsed: stat(valid, s => s.ramUsed),
        ramFree: stat(valid, s => s.ramFree),
        swap: stat(valid, s => s.swap),
        load: stat(valid, s => s.load),
    };

    const restartsStart = valid[0].restarts;
    const restartsEnd = valid[valid.length - 1].restarts;

    let verdict = '✅';
    const problemList = [];
    if (stats.cpu.p95 > 70) problemList.push(`CPU بالا (p95=${stats.cpu.p95}%)`);
    if (stats.nodeRss.p95 > 300) problemList.push(`Node RAM بالا (p95=${stats.nodeRss.p95}M)`);
    if (stats.mongoCpu.p95 > 60) problemList.push(`Mongo CPU بالا (p95=${stats.mongoCpu.p95}%)`);
    if (stats.swap.max > 500) problemList.push(`Swap بالا (max=${stats.swap.max}M)`);
    if (restartsEnd - restartsStart > 2) problemList.push(`ری‌استارت زیاد (${restartsEnd - restartsStart} بار)`);
    if (problemList.length) verdict = '⚠️';

    const report = `
══════════════════════════════════════════════════════════════
  خلاصه‌ی روز معاملاتی ${key}
══════════════════════════════════════════════════════════════

  تعداد نمونه : ${stats.samples}
  بازه        : ${stats.duration}

  ─── CPU (%) ───
    min: ${stats.cpu.min}   avg: ${stats.cpu.avg}   p95: ${stats.cpu.p95}   max: ${stats.cpu.max}

  ─── Node.js ───
    RAM (M) : min=${stats.nodeRss.min}  avg=${stats.nodeRss.avg}  p95=${stats.nodeRss.p95}  max=${stats.nodeRss.max}
    CPU (%) : min=${stats.nodeCpu.min}  avg=${stats.nodeCpu.avg}  p95=${stats.nodeCpu.p95}  max=${stats.nodeCpu.max}
    Restarts: ${restartsStart} → ${restartsEnd} (delta: ${restartsEnd - restartsStart})

  ─── Collector ───
    RAM (M) : min=${stats.collRss.min}  avg=${stats.collRss.avg}  p95=${stats.collRss.p95}  max=${stats.collRss.max}

  ─── MongoDB ───
    CPU (%)    : min=${stats.mongoCpu.min}  avg=${stats.mongoCpu.avg}  p95=${stats.mongoCpu.p95}  max=${stats.mongoCpu.max}
    Connections: min=${stats.mongoConn.min}  avg=${stats.mongoConn.avg}  p95=${stats.mongoConn.p95}  max=${stats.mongoConn.max}

  ─── Memory ───
    Used (M): min=${stats.ramUsed.min}  avg=${stats.ramUsed.avg}  max=${stats.ramUsed.max}
    Free (M): min=${stats.ramFree.min}  avg=${stats.ramFree.avg}  max=${stats.ramFree.max}
    Swap (M): min=${stats.swap.min}  avg=${stats.swap.avg}  max=${stats.swap.max}

  ─── Load ───
    min: ${stats.load.min}   avg: ${stats.load.avg}   max: ${stats.load.max}

  ─── قضاوت ───
    ${verdict} ${problemList.length ? problemList.join(' · ') : 'همه‌ی شاخص‌ها نرمال'}

══════════════════════════════════════════════════════════════
  پایان خلاصه — ${new Date().toISOString()}
══════════════════════════════════════════════════════════════
`;

    fs.writeFileSync(summaryFile, report);
    console.log(`📊 خلاصه‌ی روز ساخته شد: ${summaryFile}`);

    // ارسال به تلگرام اگر ممکنه
    try {
        const url = safe("grep TELEGRAM_BOT_TOKEN ~/apps/OptionHunter/.env | cut -d= -f2 | tr -d '\"'");
        const chat = safe("grep TELEGRAM_CHAT_ID ~/apps/OptionHunter/.env | cut -d= -f2 | tr -d '\"'");
        if (url && chat && url !== '' && chat !== '') {
            const text = encodeURIComponent(report);
            safe(`curl -s "https://api.telegram.org/bot${url}/sendMessage?chat_id=${chat}&text=${text}" > /dev/null 2>&1`);
            console.log('📤 خلاصه به تلگرام ارسال شد');
        }
    } catch (_) {}
}

// ─── پاک‌سازی فایل‌های قدیمی ───
function pruneOldFiles() {
    try {
        const files = fs.readdirSync(LOG_DIR);
        const cutoff = Date.now() - RETENTION_DAYS * 86400 * 1000;
        let deleted = 0;
        for (const f of files) {
            if (!f.startsWith('market-')) continue;
            const full = path.join(LOG_DIR, f);
            const stat = fs.statSync(full);
            if (stat.mtimeMs < cutoff) {
                fs.unlinkSync(full);
                deleted++;
            }
        }
        if (deleted) console.log(`🧹 ${deleted} فایل قدیمی پاک شد`);
    } catch (_) {}
}

// ─── اجرا ───
ensureDir();
console.log(`🚀 OHMonitor started — interval 30s`);
console.log(`   main log      : ${MAIN_LOG}`);
console.log(`   market logs   : ${LOG_DIR}/market-YYYY-MM-DD.log`);
console.log(`   daily summary : ${LOG_DIR}/market-summary-YYYY-MM-DD.txt`);

snapshot();
setInterval(snapshot, INTERVAL_MS);