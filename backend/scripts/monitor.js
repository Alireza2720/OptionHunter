'use strict';
// ============================================================
// monitor.js — رصد مصرف سرور هر ۳۰ ثانیه
// ============================================================
// اجرا با PM2 به‌عنوان سرویس جدا
// فایل لاگ: logs/monitor.log

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const LOG_FILE = path.join(__dirname, '..', '..', 'logs', 'monitor.log');
const INTERVAL_MS = 30000;
const MAX_LOG_LINES = 5000;
const KEEP_LOG_LINES = 2000;

function safe(cmd, fallback = '?') {
    try { return execSync(cmd, { timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
    catch { return fallback; }
}

function getNodeRss() {
    try {
        const jlist = safe('pm2 jlist');
        const arr = JSON.parse(jlist);
        const me = arr.find(x => x.name === 'OptionHunter');
        return me ? Math.round(me.monit.memory / 1048576) : '?';
    } catch { return '?'; }
}

function getNodeRestarts() {
    try {
        const jlist = safe('pm2 jlist');
        const arr = JSON.parse(jlist);
        const me = arr.find(x => x.name === 'OptionHunter');
        return me ? (me.pm2_env.restart_time || 0) : '?';
    } catch { return '?'; }
}

function getCollectorRss() {
    const v = safe('systemctl show collector -p MemoryCurrent');
    const m = v.match(/MemoryCurrent=(\d+)/);
    return m ? Math.round(+m[1] / 1048576) : '?';
}

function getMongoCpu() {
    const out = safe("top -bn1 | grep mongod | head -1 | awk '{print $9}'");
    return out || '?';
}

function getMongoConn() {
    const out = safe("ss -tan 2>/dev/null | grep -c ':27017'");
    return out || '0';
}

function getCpu() {
    // 🆕 vmstat با ۲ نمونه — قابل اعتماد برای batch mode
    const out = safe("vmstat 1 2 | tail -1 | awk '{print 100 - $15}'");
    return out ? Math.round(parseFloat(out)) : '?';
}

function getMemory() {
    const out = safe("free -m | awk 'NR==2 {print $3, $4}'");
    const parts = out.split(/\s+/);
    return { used: parts[0] || '?', free: parts[1] || '?' };
}

function getSwap() {
    const out = safe("free -m | awk 'NR==3 {print $3}'");
    return out || '0';
}

function snapshot() {
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const cpu = getCpu();
    const nodeRss = getNodeRss();
    const collRss = getCollectorRss();
    const mongoCpu = getMongoCpu();
    const mongoConn = getMongoConn();
    const mem = getMemory();
    const swap = getSwap();
    const restarts = getNodeRestarts();

    const line = `${ts} | CPU:${cpu}% | Node:${nodeRss}M | Coll:${collRss}M | Mongo:${mongoCpu}% conn:${mongoConn} | RAM used:${mem.used} free:${mem.free} | swap:${swap} | restarts:${restarts}`;

    const dir = path.dirname(LOG_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    fs.appendFileSync(LOG_FILE, line + '\n');

    try {
        const content = fs.readFileSync(LOG_FILE, 'utf-8');
        const lines = content.split('\n');
        if (lines.length > MAX_LOG_LINES) {
            fs.writeFileSync(LOG_FILE, lines.slice(-KEEP_LOG_LINES).join('\n'));
        }
    } catch (_) {}

    console.log(line);
}

console.log('🚀 monitor.js started — every 30s, log:', LOG_FILE);
snapshot();
setInterval(snapshot, INTERVAL_MS);