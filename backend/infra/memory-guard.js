'use strict';
// ============================================================
// memory-guard.js — محافظت از سرور در برابر OOM
// ============================================================
const os = require('os');

const SAFETY_MARGIN_MB = 300;   // حداقل RAM آزاد مورد نیاز
const MAX_RSS_MB = 800;          // حداکثر RSS مجاز برای Node

function getMemoryStatus() {
    const total = os.totalmem() / 1048576;
    const free = os.freemem() / 1048576;
    const used = total - free;
    const proc = process.memoryUsage();
    return {
        systemTotalMB: Math.round(total),
        systemFreeMB: Math.round(free),
        systemUsedMB: Math.round(used),
        systemUsedPct: Math.round((used / total) * 100),
        processRssMB: Math.round(proc.rss / 1048576),
        processHeapMB: Math.round(proc.heapUsed / 1048576),
    };
}

/**
 * چک کن که RAM کافی هست برای شروع یه کار سنگین
 * @returns {{ok: boolean, reason?: string, status}}
 */
function canStartHeavyJob() {
    const s = getMemoryStatus();

    if (s.systemFreeMB < SAFETY_MARGIN_MB) {
        return {
            ok: false,
            reason: `RAM آزاد کم است (${s.systemFreeMB}MB < ${SAFETY_MARGIN_MB}MB) — صبر کنید یا کار سبک‌تری بزنید`,
            status: s,
        };
    }
    if (s.processRssMB > MAX_RSS_MB) {
        return {
            ok: false,
            reason: `Node الان ${s.processRssMB}MB مصرف دارد — صبر کنید آرام شود`,
            status: s,
        };
    }
    return { ok: true, status: s };
}

/**
 * اگر heap به 80% سقف رسیده، GC کن
 */
function maybeGC() {
    if (typeof global.gc === 'function') {
        const s = getMemoryStatus();
        if (s.processHeapMB > 600) {
            try { global.gc(); } catch (_) {}
        }
    }
}

/** @returns {number} pct heap استفاده‌شده نسبت به max */
function getHeapPct() {
    const proc = process.memoryUsage();
    const heapTotal = proc.heapTotal / 1048576;
    const heapUsed = proc.heapUsed / 1048576;
    return Math.round((heapUsed / heapTotal) * 100);
}

module.exports = {
    getMemoryStatus,
    canStartHeavyJob,
    maybeGC,
    getHeapPct,
    SAFETY_MARGIN_MB,
    MAX_RSS_MB,
};