'use strict';
// ============================================================
// correlation.job.js — محاسبه‌ی شبانه‌ی ماتریس همبستگی
// ============================================================

const cron = require('node-cron');

let deps = { correlationService: null, logger: null };
function init(d) { deps = { ...deps, ...d }; }

async function refresh() {
    try {
        const r = await deps.correlationService.computeAndStore(30);
        deps.logger && deps.logger.info(
            `correlation refreshed: ${r.symbols} sym, ${r.clusters} clusters`
        );
        return r;
    } catch (e) {
        deps.logger && deps.logger.error('correlation refresh: ' + e.message);
        return null;
    }
}

let task = null;
function start() {
    if (task) return;
    // هر شب ساعت 03:30 تهران
    task = cron.schedule('30 3 * * *', refresh, { timezone: 'Asia/Tehran' });
    deps.logger && deps.logger.info('correlation.job started');
}
function stop() { if (task) { task.stop(); task = null; } }

module.exports = { init, refresh, start, stop };