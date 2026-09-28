'use strict';
// ============================================================
// retention.job.js — پاکسازی خودکار دیتای قدیمی
// ============================================================
const cron = require('node-cron');

let deps = { getDB: null, logger: null };
function init(d) { deps = { ...deps, ...d }; }

const RETENTION = {
    option_snapshots: 90,     // ۹۰ روز
    stock_ticks: 90,
    logs: 30,
    collector_log: 60,
    telegram_outbox: 14,
};

async function run() {
    const db = deps.getDB();
    const results = {};
    const now = Date.now();

    for (const [colName, days] of Object.entries(RETENTION)) {
        try {
            const cutoff = new Date(now - days * 86400000);
            const field = colName === 'logs' ? 'at'
                       : colName === 'collector_log' ? 'at'
                       : colName === 'telegram_outbox' ? 'sentAt'
                       : colName === 'option_snapshots' ? 'timestamp'
                       : 'time';
            const q = { [field]: { $lt: cutoff } };
            if (colName === 'telegram_outbox') q.sentAt = { $ne: null, $lt: cutoff };
            const r = await db.collection(colName).deleteMany(q);
            if (r.deletedCount > 0) results[colName] = r.deletedCount;
        } catch (e) {
            deps.logger && deps.logger.warn(`retention ${colName}: ${e.message}`);
        }
    }

    if (Object.keys(results).length) {
        deps.logger && deps.logger.info('retention: ' + JSON.stringify(results));
    }
    return results;
}

let task = null;
function start() {
    if (task) return;
    // هر شب 03:30
    task = cron.schedule('30 3 * * *', run, { timezone: 'Asia/Tehran' });
    deps.logger && deps.logger.info('retention.job started');
    setTimeout(run, 5 * 60 * 1000);   // اولین اجرا بعد ۵ دقیقه
}
function stop() { if (task) { task.stop(); task = null; } }
module.exports = { init, start, stop, run };