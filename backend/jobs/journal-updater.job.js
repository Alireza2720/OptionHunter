'use strict';
const cron = require('node-cron');
let deps = { journalService: null, logger: null };
function init(d) { deps = { ...deps, ...d }; }

async function run() {
    try {
        if (deps.journalService) await deps.journalService.sync();
    } catch (e) {
        deps.logger && deps.logger.warn('journal-updater: ' + e.message);
    }
}

let task = null;
function start() {
    if (task) return;
    // هر ۲ ساعت
    task = cron.schedule('0 */2 * * *', run, { timezone: 'Asia/Tehran' });
    deps.logger && deps.logger.info('journal-updater.job started');
    // اولین اجرا بعد از ۹۰ ثانیه
    setTimeout(run, 90000);
}
function stop() { if (task) { task.stop(); task = null; } }
module.exports = { init, start, stop, run };