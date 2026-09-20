'use strict';
// ============================================================
// risk-free.job.js — نرخ بدون ریسک روزانه
// ============================================================
// - از MongoDB (risk_free_cache) می‌خونه
// - به settings تزریق می‌کنه
// - هر ۶ ساعت refresh
// ============================================================

const cron = require('node-cron');

let deps = { getDB: null, settings: null, logger: null };

function init(d) { deps = { ...deps, ...d }; }

async function refresh() {
    try {
        const db = deps.getDB();
        const docs = await db.collection('risk_free_cache')
            .find({}).sort({ date: -1 }).limit(1).toArray();

        if (!docs.length) {
            deps.logger && deps.logger.warn('risk-free: cache خالیه');
            return null;
        }

        const { date, rate, count, source } = docs[0];

        if (!Number.isFinite(rate) || rate <= 0) {
            deps.logger && deps.logger.warn(`risk-free: rate نامعتبر ${rate}`);
            return null;
        }

        deps.settings.setRiskFreeRate(rate, date);
        deps.logger && deps.logger.info(
            `risk-free: ${rate.toFixed(4)} (${date}, ${count} bonds, source=${source})`
        );

        return { rate, date, count, source };
    } catch (e) {
        deps.logger && deps.logger.error('risk-free refresh: ' + e.message);
        return null;
    }
}

let task = null;

function start() {
    if (task) return;
    // هر ۶ ساعت (00:00, 06:00, 12:00, 18:00 تهران)
    task = cron.schedule('0 */6 * * *', refresh, { timezone: 'Asia/Tehran' });
    deps.logger && deps.logger.info('risk-free.job started (every 6h)');
}

function stop() {
    if (task) { task.stop(); task = null; }
}

module.exports = { init, refresh, start, stop };