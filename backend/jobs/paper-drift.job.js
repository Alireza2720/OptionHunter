'use strict';
// ============================================================
// paper-drift.job.js — weekly Paper vs Backtest drift alert
// ============================================================

const cron = require('node-cron');
const driftService = require('../services/paper-drift.service');

let deps = { getDB: null, logger: null, notify: null };
function init(d) { deps = Object.assign({}, deps, d || {}); }

async function run() {
    try {
        const r = await driftService.computeDrift(deps.getDB, { days: 30 });
        if (deps.logger) {
            deps.logger.info(
                'paper-drift: severity=' + r.severity +
                ' ratio=' + r.ratio +
                ' paperPF=' + (r.paper.statsWindow.profitFactor != null ? r.paper.statsWindow.profitFactor : '-') +
                ' btPF=' + (r.backtest.pf != null ? r.backtest.pf : '-') +
                ' closed30d=' + r.paper.closed +
                ' open=' + r.paper.open
            );
        }
        if (!deps.notify) return r;

        if (r.severity === 'critical') {
            await deps.notify(
                '[DRIFT CRITICAL] Paper vs Backtest\n' +
                'Paper PF (30d): ' + (r.paper.statsWindow.profitFactor != null ? r.paper.statsWindow.profitFactor : '-') + '\n' +
                'Backtest PF: ' + r.backtest.pf + '\n' +
                'Ratio: ' + (r.ratio != null ? (r.ratio * 100).toFixed(0) + '%' : '-') + '\n' +
                'closed 30d: ' + r.paper.closed + ' | open: ' + r.paper.open + '\n' +
                (r.message || '')
            ).catch(function () {});
        } else if (r.severity === 'warn') {
            await deps.notify(
                '[DRIFT WARN]\n' +
                'Paper PF: ' + (r.paper.statsWindow.profitFactor != null ? r.paper.statsWindow.profitFactor : '-') +
                ' | Backtest PF: ' + r.backtest.pf + '\n' +
                'Ratio: ' + (r.ratio != null ? (r.ratio * 100).toFixed(0) + '%' : '-')
            ).catch(function () {});
        }
        return r;
    } catch (e) {
        deps.logger && deps.logger.error('paper-drift.job: ' + e.message);
        return { error: e.message };
    }
}

let task = null;
function start() {
    if (task) return;
    task = cron.schedule('0 10 * * 0', run, { timezone: 'Asia/Tehran' });
    deps.logger && deps.logger.info('paper-drift.job started (weekly Sun 10:00 Tehran)');
}
function stop() { if (task) { task.stop(); task = null; } }

module.exports = { init: init, start: start, stop: stop, run: run };