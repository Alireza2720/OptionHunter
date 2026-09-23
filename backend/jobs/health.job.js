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
// 🆕 چک tick در ساعات بازار
const { SESSION_START_MIN, SESSION_END_MIN } = require('../config/constants');

let _tickAlertSent = false;
async function checkTickFreshness() {
    try {
        const db = deps.getDB();
        const now = new Date();
        const tehranMs = now.getTime() + (3.5 * 3600 * 1000);
        const tehran = new Date(tehranMs);
        const wd = tehran.getUTCDay();
        const isTradingDay = [6, 0, 1, 2, 3].includes(wd);
        const mins = tehran.getUTCHours() * 60 + tehran.getUTCMinutes();
        const isMarket = isTradingDay && mins >= SESSION_START_MIN && mins <= SESSION_END_MIN;

        if (!isMarket) {
            _tickAlertSent = false;
            return;
        }

        const today = tehran.toISOString().slice(0, 10);
        const stats = await db.collection('meta').findOne({ _id: `daystats_${today}` });
        const ticksOk = (stats && stats.ticksOk) || 0;

        const minutesSinceOpen = mins - SESSION_START_MIN;
        // اگه ۱۵ دقیقه از شروع گذشته و کمتر از ۵ tick موفق داشتیم
        if (minutesSinceOpen >= 15 && ticksOk < 5 && !_tickAlertSent) {
            _tickAlertSent = true;
            await deps.telegram.notify(
                `🚨 هشدار tick\n` +
                `${minutesSinceOpen} دقیقه از باز شدن بازار گذشته، فقط ${ticksOk} تیک موفق!\n` +
                `بررسی:\n  pm2 logs OptionHunter --lines 50\n  sudo systemctl status collector`
            ).catch(() => {});
        } else if (ticksOk >= 5) {
            _tickAlertSent = false;
        }
    } catch (e) {
        deps.logger && deps.logger.warn('tick freshness: ' + e.message);
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
    task = cron.schedule('*/2 * * * *', checkHealth);
    cron.schedule('0 * * * *', checkBackendMemory);
    cron.schedule('*/5 * * * *', checkTickFreshness);   // 🆕
    deps.logger && deps.logger.info('health.job started');
}

function stop() {
    if (task) { task.stop(); task = null; }
}

module.exports = { init, start, stop, checkHealth, checkTickFreshness };