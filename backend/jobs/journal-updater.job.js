'use strict';
const cron = require('node-cron');
const marketHours = require('../infra/market-hours');
let deps = { journalService: null, logger: null };
function init(d) { deps = { ...deps, ...d }; }

async function run() {
    // 🆕 تو ساعات بازار اجرا نشه
    if (marketHours.isMarketHourOrNear()) {
        deps.logger && deps.logger.info('journal-updater: skipped (market open)');
        return;
    }
    try {
        if (deps.journalService) await deps.journalService.sync();
    } catch (e) {
        deps.logger && deps.logger.warn('journal-updater: ' + e.message);
    }
}

let task = null;
function start() {
    if (task) return;
    // 🆕 ۳ بار در روز، بعد از بازار
    task = cron.schedule('45 12,15,18 * * 6,0,1,2,3', run, { timezone: 'Asia/Tehran' });
    deps.logger && deps.logger.info('journal-updater.job started (post-market only)');
}
function stop() { if (task) { task.stop(); task = null; } }
module.exports = { init, start, stop, run };