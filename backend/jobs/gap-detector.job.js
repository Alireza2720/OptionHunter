'use strict';
// ============================================================
// gap-detector.job.js — تشخیص و پر کردن خودکار شکاف دیتا
// ============================================================
// هر شب ساعت 13:30 تهران: نمادهای ناقص رو پیدا می‌کنه و backfill می‌زنه

const cron = require('node-cron');

let deps = { getDB: null, algotik: null, logger: null, notify: null };
function init(d) { deps = { ...deps, ...d }; }

const MIN_1M = 10000;
const MIN_DAILY = 20;

function toJalaliDash(isoDate) {
    const d = new Date(isoDate + 'T00:00:00Z');
    const fmt = new Intl.DateTimeFormat('en-US-u-ca-persian', {
        timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit'
    });
    const p = {};
    fmt.formatToParts(d).forEach(x => p[x.type] = x.value);
    return `${p.year}-${p.month}-${p.day}`;   // 🆕 dash
}

async function checkAndFix() {
    try {
        const db = deps.getDB();
        const { COLLECTIONS } = require('../config/constants');
        const monitored = await db.collection(COLLECTIONS.MONITORED_SYMBOLS)
            .find({ enabled: true }).toArray();

        const cov = await deps.algotik.getCoverage();
        const covMap = {};
        for (const c of (cov.symbols || [])) covMap[c.symbol] = c;

        // نمادهایی که دیتای کافی ندارن
        const bad = [];
        for (const m of monitored) {
            const c = covMap[m.symbol] || {};
            const c1m = (c.stock_base && c.stock_base.count) || 0;
            const cDaily = (c.stock_daily && c.stock_daily.count) || 0;
            if (c1m < MIN_1M || cDaily < MIN_DAILY) bad.push(m.symbol);
        }

        if (!bad.length) {
            deps.logger && deps.logger.info('gap-detector: همه نمادها سالم');
            return { checked: monitored.length, fixed: 0, bad: [] };
        }

        const today = new Date().toISOString().slice(0, 10);
        const from30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
        const fromJ = toJalaliSlash(from30);
        const toJ = toJalaliSlash(today);

        // 🆕 یک backfill واحد برای همه‌ی نمادها (نه N بار موازی)
        try {
            deps.logger && deps.logger.info(
                `gap-detector: backfill واحد برای ${bad.length} نماد (${fromJ} → ${toJ})`
            );
            await deps.algotik.startFullBackfill({
                symbols: bad,
                dateFrom: fromJ, dateTo: toJ,
                includeStockIntraday: true,
                includeStockDaily: true,
                includeOptionHistory: true,
                includeOptionSnapshot: false,
                includeOptionMigration: false,
                includeAggregate: true
            });

            if (deps.notify) {
                await deps.notify(
                    `🔧 Gap Detector\nbackfill واحد برای ${bad.length} نماد شروع شد:\n${bad.slice(0, 20).join('، ')}${bad.length > 20 ? ' و...' : ''}`
                ).catch(() => {});
            }

            return { checked: monitored.length, fixed: bad.length, bad, fixedSymbols: bad };
        } catch (e) {
            deps.logger && deps.logger.error('gap-detector startFullBackfill: ' + e.message);
            return { checked: monitored.length, fixed: 0, bad, error: e.message };
        }
    } catch (e) {
        deps.logger && deps.logger.error('gap-detector: ' + e.message);
        return { error: e.message };
    }
}

let task = null;
function start() {
    if (task) return;
    // هر شب 13:30 تهران (بعد از بازار و gap از بازار جدید)
    task = cron.schedule('30 13 * * 6,0,1,2,3', checkAndFix, { timezone: 'Asia/Tehran' });
    deps.logger && deps.logger.info('gap-detector.job started');
}
function stop() { if (task) { task.stop(); task = null; } }

module.exports = { init, start, stop, checkAndFix };