'use strict';
// ============================================================
// drift.job.js — چک drift روزانه
// ============================================================

const cron = require('node-cron');

let deps = { getDB: null, logger: null, notify: null };
function init(d) { deps = { ...deps, ...d }; }

async function check() {
    try {
        const db = deps.getDB();
        const since30 = new Date(Date.now() - 30 * 86400 * 1000);

        // live stats
        const closed = await db.collection('option_positions').find({
            status: 'closed',
            exitTime: { $gte: since30 }
        }).toArray();

        if (closed.length < 10) return { ok: true, note: 'sample کم' };

        const wins = closed.filter(p => p.pnlPct > 0);
        const losses = closed.filter(p => p.pnlPct <= 0);
        const gp = wins.reduce((s, p) => s + p.pnlPct, 0);
        const gl = -losses.reduce((s, p) => s + p.pnlPct, 0);
        const livePF = gl > 0 ? gp / gl : (gp > 0 ? 999 : 0);

        // backtest PF
        const meta = await db.collection('meta').findOne({ _id: 'last_backtest_pf' });
        if (!meta || !meta.pf) return { ok: true, note: 'backtest PF ثبت نشده' };

        const backtestPF = meta.pf;
        const ratio = livePF / backtestPF;

        let severity = 'ok';
        let message = null;
        if (ratio < 0.3) {
            severity = 'critical';
            message = `🚨 DRIFT CRITICAL\nLive PF = ${livePF.toFixed(2)} (${(ratio*100).toFixed(0)}% از backtest)\nBacktest PF = ${backtestPF.toFixed(2)}\n${closed.length} معامله در ۳۰ روز`;
        } else if (ratio < 0.5) {
            severity = 'warn';
            message = `⚠️ DRIFT WARN\nLive PF = ${livePF.toFixed(2)} (${(ratio*100).toFixed(0)}% از backtest)`;
        }

        if (message && deps.notify) {
            await deps.notify(message).catch(() => {});
        }

        deps.logger && deps.logger.info(`drift: live=${livePF.toFixed(2)} bt=${backtestPF.toFixed(2)} ratio=${(ratio*100).toFixed(0)}%`);
        return { livePF, backtestPF, ratio, severity, closedCount: closed.length };
    } catch (e) {
        deps.logger && deps.logger.warn('drift check: ' + e.message);
        return { ok: false, error: e.message };
    }
}

let task = null;
function start() {
    if (task) return;
    // هر روز 13:00 تهران (بعد از بازار)
    task = cron.schedule('0 13 * * 6,0,1,2,3', check, { timezone: 'Asia/Tehran' });
    deps.logger && deps.logger.info('drift.job started');
}
function stop() { if (task) { task.stop(); task = null; } }

module.exports = { init, check, start, stop };