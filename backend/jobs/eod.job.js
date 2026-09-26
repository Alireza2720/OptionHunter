'use strict';
// ============================================================
// eod.job.js — وظایف پایان روز
// ============================================================
// - 12:32 → ارزیابی نهایی + EOD آپشن + persist TF
// - 12:35 → خلاصه روزانه
// ============================================================

const cron = require('node-cron');
const { COLLECTIONS } = require('../config/constants');

let deps = {
    getDB: null,
    signalService: null,
    dataService: null,
    options: null,
    settings: null,
    configService: null,
    logger: null,
    notify: null
};

function init(d) { deps = { ...deps, ...d }; }

let tasks = [];

async function eodEvaluation() {
    const holiday = deps.signalService.getHoliday();
    const today = deps.signalService.todayDateStr();
    if (holiday === today) return;

    try {
        // 1. ارزیابی نهایی استراتژی‌ها
        await deps.signalService.tick();

        // 2. persist TF candles برای فردا
        const configs = await deps.configService.listEnabled();
        const written = await deps.dataService.persistTfCandles(configs);
        deps.logger && deps.logger.info(`persistTfCandles: ${written} candle`);

        // 3. EOD آپشن
        const monitored = await deps.getDB().collection(COLLECTIONS.MONITORED_SYMBOLS)
            .find({}).toArray();
        const mset = new Set(monitored.map(m => deps.options.norm(m.symbol)));

        const chain = await deps.options.fetchChain ? await deps.options.fetchChain(0) : null;
        if (chain) {
            await deps.options.storeEOD(chain, mset);
            await deps.options.managePositions(chain);
        }

        // 4. flush پیام‌های در صف
        await deps.telegram?.flush?.().catch(() => {});
    } catch (e) {
        deps.logger && deps.logger.error('EOD: ' + e.message);
    }
}

async function dailySummary() {
    const holiday = deps.signalService.getHoliday();
    const today = deps.signalService.todayDateStr();
    const isHoliday = (holiday === today);

    try {
        const db = deps.getDB();
        const stats = await db.collection(COLLECTIONS.META)
            .findOne({ _id: `daystats_${today}` }) || {};

        const ticksOk = stats.ticksOk || 0;
        const ticksFail = stats.ticksFail || 0;
        const totalTicks = ticksOk + ticksFail;

        // 🆕 تعداد رکوردهای stock_ticks امروز
        let stockTickCount = 0;
        try {
            const todayStart = new Date();
            todayStart.setHours(0, 0, 0, 0);
            stockTickCount = await db.collection('stock_ticks')
                .countDocuments({ time: { $gte: todayStart } });
        } catch (_) {}

        let optLine = '';
        let portLine = '';
        try {
            const list = await db.collection(COLLECTIONS.OPTION_POSITIONS).find({}).toArray();
            const s = deps.options.positionStats(list);
            optLine = `\nآپشن: باز ${s.open} | بسته ${s.closed} | وین ریت ${s.winRate.toFixed(0)}% | بازده کل ${s.totalPnl.toFixed(0)}%`;
        } catch (_) {}

        try {
            const open = await db.collection(COLLECTIONS.OPTION_POSITIONS)
                .find({ status: 'open' }).toArray();
            let totalExposure = 0;
            for (const p of open) {
                totalExposure += (p.entryAsk || 0) * (p.positionSize || 1) * (p.size || 1000);
            }
            const capital = deps.settings.capital();
            portLine = `\nسرمایه: ${Math.round(capital).toLocaleString()} | درگیری: ${Math.round(totalExposure).toLocaleString()} (${capital > 0 ? (totalExposure / capital * 100).toFixed(1) : 0}%)`;
        } catch (_) {}

        // 🆕 خلاصه تیک سالم
        const text = `📊 خلاصه روز ${today}${isHoliday ? ' (تعطیل رسمی)' : ''}\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `✅ تیک موفق: ${ticksOk}\n` +
            `❌ تیک ناموفق: ${ticksFail}\n` +
            `📈 نرخ موفقیت: ${totalTicks > 0 ? ((ticksOk / totalTicks) * 100).toFixed(1) : 0}%\n` +
            `📉 رکورد tick ذخیره‌شده: ${stockTickCount.toLocaleString()}\n` +
            `🔔 سیگنال: ${stats.signals || 0} | لغو: ${stats.cancels || 0}` +
            optLine + portLine;

        await deps.notify(text);
    } catch (e) {
        deps.logger && deps.logger.error('summary: ' + e.message);
    }
}

function start() {
    if (tasks.length) return;

    // 12:32 EOD
    tasks.push(cron.schedule('32 12 * * 6,0,1,2,3', eodEvaluation, { timezone: 'Asia/Tehran' }));

    // 12:35 خلاصه روزانه
    tasks.push(cron.schedule('35 12 * * 6,0,1,2,3', dailySummary, { timezone: 'Asia/Tehran' }));

    deps.logger && deps.logger.info('eod.job started');
}

function stop() {
    for (const t of tasks) t.stop();
    tasks = [];
}

module.exports = { init, start, stop, eodEvaluation, dailySummary };