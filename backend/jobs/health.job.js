'use strict';
// ============================================================
// health.job.js — Health monitoring با alert تلگرام
// ============================================================

const cron = require('node-cron');

let deps = {
    algotik: null,
    telegram: null,
    logger: null,
    getDB: null
};

function init(d) { deps = { ...deps, ...d }; }

// تعداد failure های پی‌درپی
let consecutiveFails = 0;
let alertSent = false;
const ALERT_THRESHOLD = 3;   // ۳ بار پشت سر هم → alert

async function checkHealth() {
    try {
        const online = await deps.algotik.isOnline();
        if (online) {
            if (alertSent) {
                // Recovery
                await deps.telegram.notify(
                    '✅ Collector به حالت عادی برگشت'
                ).catch(() => {});
                alertSent = false;
            }
            consecutiveFails = 0;
            return;
        }

        consecutiveFails++;
        deps.logger && deps.logger.warn(`health: collector offline (${consecutiveFails}/${ALERT_THRESHOLD})`);

        if (consecutiveFails >= ALERT_THRESHOLD && !alertSent) {
            alertSent = true;
            await deps.telegram.notify(
                `🚨 Collector ${consecutiveFails} بار پشت سر هم آفلاین!\n` +
                `زمان: ${new Date().toISOString()}\n` +
                `دستور بررسی:\n` +
                `  sudo systemctl status collector\n` +
                `  sudo journalctl -u collector -n 50 --no-pager`
            ).catch(() => {});
        }
    } catch (e) {
        deps.logger && deps.logger.error('health check: ' + e.message);
    }
}

async function checkBackendMemory() {
    try {
        const memMB = Math.round(process.memoryUsage().rss / 1048576);
        if (memMB > 1500) {  // > 1.5GB
            await deps.telegram.notify(
                `⚠️ Backend RAM بالا: ${memMB}MB`
            ).catch(() => {});
        }
    } catch (_) {}
}

let task = null;
function start() {
    if (task) return;
    task = cron.schedule('*/2 * * * *', checkHealth);           // هر ۲ دقیقه
    cron.schedule('0 * * * *', checkBackendMemory);             // هر ساعت
    deps.logger && deps.logger.info('health.job started');
}

function stop() {
    if (task) { task.stop(); task = null; }
}

module.exports = { init, start, stop, checkHealth };