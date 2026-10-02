'use strict';
// ============================================================
// monitor.js — رصد منابع سرور و ساعات بازار
// ============================================================
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const LOG_DIR = path.join(ROOT, 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function ts() { return new Date().toISOString(); }
function tehranNow() {
    const now = new Date();
    return new Date(now.getTime() + 3.5 * 3600 * 1000);
}
function isMarketHours() {
    const t = tehranNow();
    const wd = t.getUTCDay();
    const mins = t.getUTCHours() * 60 + t.getUTCMinutes();
    return [6, 0, 1, 2, 3].includes(wd) && mins >= 9 * 60 && mins <= 12 * 60 + 35;
}
function appendLog(file, line) {
    try { fs.appendFileSync(path.join(LOG_DIR, file), line + '\n'); } catch (_) {}
}
function snapshot() {
    const total = os.totalmem() / 1048576;
    const free = os.freemem() / 1048576;
    const used = total - free;
    const load = os.loadavg()[0];
    const cores = os.cpus().length;
    const cpu = Math.min(100, Math.round((load / cores) * 100));
    let nodeRAM = 0, nodeCPU = 0, restarts = 0;
    try {
        const raw = execSync('pm2 jlist 2>/dev/null || echo "[]"').toString();
        const list = JSON.parse(raw);
        for (const p of list) {
            if (p.name === 'OptionHunter') {
                nodeRAM = Math.round((p.monit?.memory || 0) / 1048576);
                nodeCPU = p.monit?.cpu || 0;
                restarts = p.pm2_env?.restart_time || 0;
            }
        }
    } catch (_) {}
    let collRAM = 0;
    try {
        const out = execSync(
            'systemctl show collector -p MemoryCurrent --no-pager 2>/dev/null || true'
        ).toString();
        const m = out.match(/MemoryCurrent=(\d+)/);
        if (m && m[1] !== '[not set]') collRAM = Math.round(+m[1] / 1048576);
    } catch (_) {}
    return {
        cpu: Math.round(100 - cpu) === 0 ? 100 : Math.round(100 - cpu),
        nodeRAM, nodeCPU, collRAM, restarts,
        ramUsed: Math.round(used), ramFree: Math.round(free), total: Math.round(total),
        swap: Math.round((os.totalmem() - os.freemem()) / 1048576),
    };
}
function tick() {
    const s = snapshot();
    const day = new Date().toISOString().slice(0, 10);
    const line = `[${ts()}] CPU:${s.cpu}% Node:${s.nodeRAM}M(${s.nodeCPU}%) Coll:${s.collRAM}M RAM:${s.ramUsed}/${s.ramFree}/${s.total}M restarts:${s.restarts}`;
    appendLog('monitor.log', line);
    if (isMarketHours()) appendLog(`market-${day}.log`, line);
    if (s.nodeRAM > 750) appendLog('monitor.log', `[${ts()}] ⚠️ Node RAM high: ${s.nodeRAM}M`);
    if (s.ramFree < 100) appendLog('monitor.log', `[${ts()}] ⚠️ RAM free low: ${s.ramFree}M`);
}
console.log(`OHMonitor started at ${ts()}`);
tick();
setInterval(tick, 30000);
setInterval(tick, 120000);
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));