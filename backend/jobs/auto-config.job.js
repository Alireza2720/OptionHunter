'use strict';
// ============================================================
// auto-config.job.js — cron های سیستمی
// ============================================================
// - هر شب 03:00 پاکسازی job های قدیمی
// - هر چهارشنبه 10:00 بکاپ هفتگی
// - هر 15 دقیقه flush تلگرام
// - هر شب 02:00 rolling performance check
// ============================================================

const cron = require('node-cron');

let deps = {
    getDB: null,
    backtestService: null,
    configService: null,
    settings: null,
    notify: null,
    telegram: null,
    logger: null
};

function init(d) { deps = { ...deps, ...d }; }

let tasks = [];

async function cleanupOldJobs() {
    try {
    const n = await deps.backtestService.cleanupOldJobs(90);
        deps.logger && deps.logger.info(`cleaned ${n} old jobs`);
    } catch (e) {
        deps.logger && deps.logger.error('cleanup jobs: ' + e.message);
    }
}

async function weeklyBackup() {
    try {
        const db = deps.getDB();
        const [symbols, configs, optSettings, stratDefaults] = await Promise.all([
            db.collection('monitored_symbols').find({}).toArray(),
            db.collection('strategy_configs').find({}).toArray(),
            db.collection('meta').findOne({ _id: 'option_settings' }),
            db.collection('meta').findOne({ _id: 'strategy_defaults' })
        ]);

        const json = {
            exportedAt: new Date(),
            monitoredSymbols: symbols,
            strategyConfigs: configs,
            optionSettings: optSettings || null,
            strategyDefaults: stratDefaults || null
        };

        const dateStr = new Date().toISOString().slice(0, 10);
        await deps.telegram.sendDocument(
            `backup_${dateStr}.json`,
            json,
            `بکاپ ${dateStr}`
        );
        deps.logger && deps.logger.info('weekly backup sent');
    } catch (e) {
        deps.logger && deps.logger.error('backup: ' + e.message);
    }
}

async function flushTelegram() {
    try { await deps.telegram.flush(); } catch (_) {}
}

async function rollingPerformanceCheck() {
    try {
        const perf = await deps.configService.rollingPerformance(30);
        const toDisable = perf.filter(p => p.action === 'disable' && p.status === 'computed');
        const toPromote = perf.filter(p => p.action === 'promote' && p.status === 'computed');

        if (toDisable.length) {
            const ids = toDisable.map(p => p.configId);
            await deps.configService.bulkUpdate(ids, { enabled: false });
            deps.logger && deps.logger.info(`auto-disabled ${ids.length} configs`);
            if (deps.notify) {
                await deps.notify(`غیرفعال شدن خودکار ${ids.length} استراتژی به دلیل عملکرد ضعیف (PF < 0.8)`).catch(() => {});
            }
        }

        if (toPromote.length) {
            deps.logger && deps.logger.info(`promote candidates: ${toPromote.length}`);
        }
    } catch (e) {
        deps.logger && deps.logger.error('rolling perf: ' + e.message);
    }
}

function start() {
    if (tasks.length) return;

    // هر شب 03:00
    tasks.push(cron.schedule('0 3 * * *', cleanupOldJobs, { timezone: 'Asia/Tehran' }));

    // هر چهارشنبه 10:00
    tasks.push(cron.schedule('0 10 * * 4', weeklyBackup, { timezone: 'Asia/Tehran' }));

    // هر 2 دقیقه flush
    tasks.push(cron.schedule('*/2 * * * *', flushTelegram));

    // هر شب 02:00 (rolling performance)
    tasks.push(cron.schedule('0 2 * * *', rollingPerformanceCheck, { timezone: 'Asia/Tehran' }));

    deps.logger && deps.logger.info('auto-config.job started');
}

function stop() {
    for (const t of tasks) t.stop();
    tasks = [];
}

module.exports = { init, start, stop, cleanupOldJobs, weeklyBackup, rollingPerformanceCheck };