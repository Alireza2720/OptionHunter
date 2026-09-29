'use strict';
// ============================================================
// market-hours.js — تشخیص ساعات بازار تهران
// ============================================================

const SESSION_START_MIN = 9 * 60;        // 09:00
const SESSION_END_MIN = 12 * 60 + 35;    // 12:35

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

module.exports = {
    isMarketOpen,
    isMarketHourOrNear,
    marketStateLabel,
    SESSION_START_MIN,
    SESSION_END_MIN,
};