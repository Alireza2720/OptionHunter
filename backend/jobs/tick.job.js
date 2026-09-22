'use strict';
// ============================================================
// tick.job.js — اجرای دوره‌ای tick در ساعات بازار
// ============================================================
// - cron هر دقیقه
// - چک ساعت بازار و تعطیلی
// - فراخوانی signalService.tick()
// ============================================================

const cron = require('node-cron');
const {
    SESSION_START_MIN,
    SESSION_END_MIN,
    COLLECTIONS
} = require('../config/constants');

let deps = {
    getDB: null,
    signalService: null,
    dataService: null,
    logger: null,
    notify: null
};

function init(d) { deps = { ...deps, ...d }; }

let task = null;

function isTradingDay(t) {
    return ['Sat', 'Sun', 'Mon', 'Tue', 'Wed'].includes(t.weekday);
}

function isMarketOpen(t) {
    const min = t.hour * 60 + t.minute;
    return isTradingDay(t) && min >= SESSION_START_MIN && min <= SESSION_END_MIN;
}

async function runTick() {
    const t = deps.dataService.getTehranParts();
    const holiday = deps.signalService.getHoliday();
    const today = deps.signalService.todayDateStr(t);

    // چک تعطیلی: فقط هر ۵ دقیقه یک‌بار بررسی
    if (holiday === today) {
        if (t.minute % 5 !== 0) return;
        // آیا بازار واقعاً فعال شده؟
        try {
            const raw = await deps.algotik.getLiveMarket(true);
            const active = raw.filter(s => +s.tno > 0).length;
            if (active >= 20) {
                await deps.signalService.clearHoliday();
                await deps.notify('بازار فعال شد.');
            } else {
                return;
            }
        } catch (_) {
            return;
        }
    }

    await deps.signalService.tick();
}

function start() {
    if (task) return;

    // هر دقیقه، در ثانیه 0
            const raw = await deps.algotik.getLiveMarket();
        try {
            const t = deps.dataService.getTehranParts();
            if (!isMarketOpen(t)) return;
            await runTick();
        } catch (e) {
            deps.logger && deps.logger.error('tick job: ' + e.message);
        }
    }, { timezone: 'Asia/Tehran' });

    deps.logger && deps.logger.info('tick.job started');
}

function stop() {
    if (task) { task.stop(); task = null; }
}

module.exports = { init, start, stop, runTick, isMarketOpen, isTradingDay };