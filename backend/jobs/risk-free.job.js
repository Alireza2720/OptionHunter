'use strict';
// ============================================================
// risk-free.job.js — خواندن نرخ بدون ریسک از DB
// ============================================================
// Collector نرخ رو از اخزا می‌گیره و در risk_free_cache ذخیره می‌کنه.
// این job فقط می‌خونه و به settings تزریق می‌کنه.

const cron = require('node-cron');

let deps = { getDB: null, settings: null, logger: null };
function init(d) { deps = { ...deps, ...d }; }

async function refresh() {
    try {
        const db = deps.getDB();
        const doc = await db.collection('risk_free_cache')
            .find({}).sort({ date: -1 }).limit(1).next();

        if (!doc) {
            deps.logger && deps.logger.warn('risk-free: cache empty');
            return null;
        }

        const rate = doc.rate;
        if (!Number.isFinite(rate) || rate <= 0) return null;

        deps.settings.setRiskFreeRate(rate, doc.date);
        deps.logger && deps.logger.info(
            `risk-free: ${rate.toFixed(4)} (${doc.date}, ${doc.count} bonds)`
        );
        return { rate, date: doc.date };
    } catch (e) {
        deps.logger && deps.logger.error('risk-free refresh: ' + e.message);
        return null;
    }
}

let task = null;
function start() {
    if (task) return;
    task = cron.schedule('0 */2 * * *', refresh, { timezone: 'Asia/Tehran' });
    deps.logger && deps.logger.info('risk-free.job started');
}
function stop() { if (task) { task.stop(); task = null; } }

module.exports = { init, refresh, start, stop };