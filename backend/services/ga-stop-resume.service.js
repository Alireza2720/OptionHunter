'use strict';
// ============================================================
// ga-stop-resume.service.js — market-hours aware GA controller
// ============================================================
// Safe windows (Tehran):
//   - Before 08:45 → safe
//   - 08:45-12:45 → DANGER (server busy / tick priority)
//   - After 12:45 → safe
// Friday closed. Non-trading days → always safe.
// ============================================================

const SAFE_END_MIN = 12 * 60 + 45;    // 12:45
const SAFE_START_MIN = 8 * 60 + 45;   // 08:45

function _tehranParts() {
    const now = new Date();
    const t = new Date(now.getTime() + 3.5 * 3600 * 1000);
    return {
        wd: t.getUTCDay(), // 0=Sun..6=Sat
        mins: t.getUTCHours() * 60 + t.getUTCMinutes()
    };
}

function isTradingDay(wd) {
    return [6, 0, 1, 2, 3].includes(wd);
}

function isDangerWindow() {
    const { wd, mins } = _tehranParts();
    if (!isTradingDay(wd)) return false;
    return mins >= SAFE_START_MIN && mins <= SAFE_END_MIN;
}

function nextSafeTime() {
    const { wd, mins } = _tehranParts();
    const now = new Date();
    if (!isTradingDay(wd)) return now;
    if (mins < SAFE_START_MIN) return now; // already safe
    // After danger starts → next safe is today 12:45
    const today = new Date(now.getTime() + 3.5 * 3600 * 1000);
    today.setUTCHours(12, 45, 0, 0);
    return new Date(today.getTime() - 3.5 * 3600 * 1000);
}

async function saveState(getDB, strategyId, state) {
    const db = getDB();
    await db.collection('meta').updateOne(
        { _id: 'ga_state_' + strategyId },
        { $set: Object.assign({}, state, { strategyId: strategyId, updatedAt: new Date() }) },
        { upsert: true }
    );
}

async function loadState(getDB, strategyId) {
    const db = getDB();
    return db.collection('meta').findOne({ _id: 'ga_state_' + strategyId });
}

async function listPaused(getDB) {
    const db = getDB();
    return db.collection('meta')
        .find({ _id: { $regex: '^ga_state_' }, status: 'paused' })
        .toArray();
}

module.exports = {
    isDangerWindow, isTradingDay, nextSafeTime,
    saveState, loadState, listPaused,
    SAFE_START_MIN, SAFE_END_MIN
};