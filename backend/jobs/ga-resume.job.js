'use strict';
// ============================================================
// ga-resume.job.js — cron every 5 min, resumes paused GA runs
// ============================================================
const cron = require('node-cron');

let deps = { getDB: null, logger: null };
function init(d) {
    deps = Object.assign({}, deps, d || {});
    if (!task) start();
}

async function run() {
    try {
        const orch = require('../services/ga-orchestrator.service');
        const r = await orch.resumeReady();
        if (r && r.resumed > 0) {
            deps.logger && deps.logger.info('ga-resume: resumed ' + r.resumed + ' strategies');
        }
    } catch (e) {
        deps.logger && deps.logger.warn('ga-resume: ' + e.message);
    }
}

let task = null;
function start() {
    if (task) return;
    task = cron.schedule('*/5 * * * *', run);
    deps.logger && deps.logger.info('ga-resume.job started (every 5 min)');
}
function stop() { if (task) { task.stop(); task = null; } }

module.exports = { init, start, stop, run };