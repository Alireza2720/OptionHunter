'use strict';
// ============================================================
// regime.job.js — refresh روزانه
// ============================================================

const cron = require('node-cron');

let deps = { regimeService: null, logger: null };
function init(d) { deps = { ...deps, ...d }; }

async function refresh() {
    try {
        const r = await deps.regimeService.refreshAll();
        return r.length;
    } catch (e) {
        deps.logger && deps.logger.error('regime job: ' + e.message);
        return 0;
    }
}

let task = null;
function start() {
    if (task) return;
    // هر روز ساعت 13:00 تهران — بعد از بسته شدن بازار
    task = cron.schedule('0 13 * * 6,0,1,2,3', refresh, { timezone: 'Asia/Tehran' });
    deps.logger && deps.logger.info('regime.job started');
}
function stop() { if (task) { task.stop(); task = null; } }

module.exports = { init, refresh, start, stop };