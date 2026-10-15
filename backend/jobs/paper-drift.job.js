'use strict';
const cron = require('node-cron');
const driftService = require('../services/paper-drift.service');
const paperTradingService = require('../services/paper-trading.service');
let deps = { getDB: null, logger: null, notify: null };
function init(d) { deps = Object.assign({}, deps, d || {}); }
async function run() {
    try {
        const r = await driftService.computeDrift(deps.getDB, { days: 30 });
        if (deps.logger) deps.logger.info('paper-drift: severity=' + r.severity + ' ratio=' + r.ratio + ' paperPF=' + (r.paper.statsWindow.profitFactor != null ? r.paper.statsWindow.profitFactor : '-') + ' btPF=' + (r.backtest.pf != null ? r.backtest.pf : '-') + ' closed30d=' + r.paper.closed + ' open=' + r.paper.open);
        if (!deps.notify) return r;
        if (r.severity === 'critical') await deps.notify('[DRIFT CRITICAL] Paper PF=' + (r.paper.statsWindow.profitFactor != null ? r.paper.statsWindow.profitFactor : '-') + ' btPF=' + r.backtest.pf + ' ratio=' + (r.ratio != null ? (r.ratio * 100).toFixed(0) + '%' : '-')).catch(function(){});
        else if (r.severity === 'warn') await deps.notify('[DRIFT WARN] Paper PF=' + (r.paper.statsWindow.profitFactor != null ? r.paper.statsWindow.profitFactor : '-') + ' btPF=' + r.backtest.pf + ' ratio=' + (r.ratio != null ? (r.ratio * 100).toFixed(0) + '%' : '-')).catch(function(){});
        return r;
    } catch (e) { deps.logger && deps.logger.error('paper-drift.job: ' + e.message); return { error: e.message }; }
}
let task = null;
let syncTask = null;

// [PAPER-SYNC-CRON] daily sync: close expired paper positions after market close
async function runSync() {
    try {
        const r = await paperTradingService.dailySync();
        deps.logger && deps.logger.info('paper-sync: ' + JSON.stringify(r || {}));
        return r;
    } catch (e) {
        deps.logger && deps.logger.warn('paper-sync: ' + e.message);
        return { error: e.message };
    }
}

function start() {
    if (task) return;
    task = cron.schedule('0 10 * * 0', run, { timezone: 'Asia/Tehran' });
    deps.logger && deps.logger.info('paper-drift.job started (weekly Sun 10:00 Tehran)');
    if (syncTask) return;
    // [PAPER-SYNC-CRON] 13:00 Tehran — 30 min after market close
    syncTask = cron.schedule('0 13 * * 6,0,1,2,3', runSync, { timezone: 'Asia/Tehran' });
    deps.logger && deps.logger.info('paper-sync started (daily 13:00 Tehran)');
}
function stop() {
    if (task) { task.stop(); task = null; }
    if (syncTask) { syncTask.stop(); syncTask = null; }
}
module.exports = { init: init, start: start, stop: stop, run: run, runSync: runSync };