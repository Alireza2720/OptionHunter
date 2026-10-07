'use strict';
// ============================================================
// market-hours.js — تشخیص ساعات بازار تهران
// ============================================================

// 🆕 از constants بیاد — یک منبع حقیقت
const { SESSION_START_MIN, SESSION_END_MIN } = require('../config/constants');
// توجه: constants.js → 12:30، live.py → 12:35، tick.job → 12:35
// توصیه: همه به 12:35 تغییر کنن. در constants.js:
//   SESSION_END_MIN = 12 * 60 + 35

function getTehranNow() {
    const now = new Date();
    const tehran = new Date(now.getTime() + 3.5 * 3600 * 1000);
    return {
        weekday: tehran.getUTCDay(),      // 0=Sun..6=Sat
        minutesOfDay: tehran.getUTCHours() * 60 + tehran.getUTCMinutes(),
    };
}

function isMarketOpen() {
    const { weekday, minutesOfDay } = getTehranNow();
    const isTradingDay = [6, 0, 1, 2, 3].includes(weekday);
    return isTradingDay && minutesOfDay >= SESSION_START_MIN && minutesOfDay <= SESSION_END_MIN;
}

/** ساعات بازار ± ۳۰ دقیقه */
function isMarketHourOrNear() {
    const { weekday, minutesOfDay } = getTehranNow();
    const isTradingDay = [6, 0, 1, 2, 3].includes(weekday);
    return isTradingDay
        && minutesOfDay >= SESSION_START_MIN - 30
        && minutesOfDay <= SESSION_END_MIN + 30;
}

function marketStateLabel() {
    const { weekday, minutesOfDay } = getTehranNow();
    const isTradingDay = [6, 0, 1, 2, 3].includes(weekday);
    if (!isTradingDay) return 'holiday';
    if (minutesOfDay < SESSION_START_MIN) return 'pre-market';
    if (minutesOfDay > SESSION_END_MIN) return 'after-market';
    return 'open';
}

// 🆕 TTL مناسب برای cache پرهزینه (coverage, quality)
// تو ساعات بازار: ۳۰ دقیقه (پولینگ فعال)
// خارج از بازار: ۶ ساعت (بی‌کاری طولانی)
function expensiveCacheTTL() {
    // During market: 30min. Outside market: 12h (was 6h) — since data doesn't
    // change outside trading hours, longer cache saves CPU.
    return isMarketHourOrNear() ? 30 * 60 * 1000 : 12 * 60 * 60 * 1000;
}

module.exports = {
    isMarketOpen,
    isMarketHourOrNear,
    marketStateLabel,
    expensiveCacheTTL,
    SESSION_START_MIN,
    SESSION_END_MIN,
};