'use strict';
// ============================================================
// daily-backfill.job.js — Backfill روزانه بعد از بازار
// ============================================================
// هر روز ساعت 13:15 تهران:
// - کل 1m و daily سهام رو به‌روز کن
// - آپشن daily هم
// ============================================================

const cron = require('node-cron');

let deps = {
    logger: null,
    algotik: null,   // infra/algotik (proxy به collector)
    notify: null
};
function init(d) { deps = { ...deps, ...d }; }

// تبدیل تاریخ به شمسی برای collector
function gregorianToJalali(gy, gm, gd) {
    const g_d_m = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
    let jy = (gy <= 1600) ? 0 : 979;
    gy -= (gy <= 1600) ? 621 : 1600;
    const gy2 = (gm > 2) ? (gy + 1) : gy;
    let days = (365 * gy) + Math.floor((gy2 + 3) / 4) - Math.floor((gy2 + 99) / 100)
        + Math.floor((gy2 + 399) / 400) - 80 + gd + g_d_m[gm - 1];
    jy += 33 * Math.floor(days / 12053);
    days %= 12053;
    jy += 4 * Math.floor(days / 1461);
    days %= 1461;
    if (days > 365) {
        jy += Math.floor((days - 1) / 365);
        days = (days - 1) % 365;
    }
    const jm = (days < 186) ? 1 + Math.floor(days / 31) : 7 + Math.floor((days - 186) / 30);
    const jd = 1 + ((days < 186) ? (days % 31) : ((days - 186) % 30));
    return { jy, jm, jd };
}

function dateToJalaliStr(d) {
    const j = gregorianToJalali(d.getFullYear(), d.getMonth() + 1, d.getDate());
    return `${j.jy}/${String(j.jm).padStart(2, '0')}/${String(j.jd).padStart(2, '0')}`;
}

async function run() {
    try {
        const today = new Date();
        const from = new Date(today.getTime() - 3 * 86400 * 1000);   // 3 روز عقب برای امنیت

        const fromJ = dateToJalaliStr(from);
        const toJ = dateToJalaliStr(today);

        deps.logger && deps.logger.info(`daily-backfill: ${fromJ} → ${toJ}`);

        const result = await deps.algotik.startFullBackfill({
            dateFrom: fromJ,
            dateTo: toJ,
            includeStockIntraday: true,
            includeStockDaily: true,
            includeOptionHistory: true,
            includeOptionSnapshot: false,    // snapshot سنگین — فقط دستی
            includeAggregate: true,
            includeOptionMigration: false
        });

        deps.logger && deps.logger.info(`daily-backfill job: ${result.jobId || '?'}`);
        // notify فقط در صورت خطا
        return { ok: true, jobId: result.jobId };
    } catch (e) {
        deps.logger && deps.logger.error('daily-backfill: ' + e.message);
        if (deps.notify) {
            await deps.notify(`❌ daily-backfill خطا:\n${e.message}`).catch(() => {});
        }
        return { ok: false, error: e.message };
    }
}

let task = null;
function start() {
    if (task) return;
    // هر روز 13:15 تهران — بعد از بسته شدن بازار
    task = cron.schedule('15 13 * * 6,0,1,2,3', run, { timezone: 'Asia/Tehran' });
    deps.logger && deps.logger.info('daily-backfill.job started');
}
function stop() { if (task) { task.stop(); task = null; } }

module.exports = { init, run, start, stop, dateToJalaliStr };