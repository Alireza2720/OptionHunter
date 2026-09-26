'use strict';
// ============================================================
// tick.job.js — اجرای دوره‌ای tick در ساعات بازار
// ============================================================
// - cron هر ۱۰ ثانیه
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
    algotik: null,
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
            const raw = await deps.algotik.getLiveMarket();
            // 🆕 algotik-tse: TradeCount (نه tno)
            const active = raw.filter(s => +(s.TradeCount || s.Volume || 0) > 0).length;
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

let _lastTickerCheck = 0;

async function ensureCollectorTickerRunning() {
    // حداکثر هر ۵ دقیقه چک کن (نه هر ۱۰ ثانیه)
    const now = Date.now();
    if (now - _lastTickerCheck < 5 * 60 * 1000) return;

    try {
        const s = await deps.algotik.getStatus();
        const t = (s && s.ticker) || {};
        if (t.running) {
            _lastTickerCheck = now;
            return;
        }
        deps.logger && deps.logger.info('auto-starting collector ticker');
        await deps.algotik.controlTicker('start', 10);
        _lastTickerCheck = now;
    } catch (e) {
        deps.logger && deps.logger.warn('auto-start collector ticker: ' + e.message);
    }
}

function start() {
    if (task) return;

    // 🆕 در استارتاپ، ticker collector رو روشن کن (حتی اگه بازار بسته باشه — فقط می‌خوابه)
    deps.algotik.controlTicker('start', 10).catch(e =>
        deps.logger && deps.logger.warn('startup ticker: ' + e.message)
    );

    // هر ۱۰ ثانیه
    task = cron.schedule('*/10 * * * * *', async () => {
        try {
            const t = deps.dataService.getTehranParts();
            if (!isMarketOpen(t)) return;
            // 🆕 اطمینان از روشن بودن ticker جمع‌آورنده
            await ensureCollectorTickerRunning();
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