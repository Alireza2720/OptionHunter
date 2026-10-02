'use strict';
// ============================================================
// signal-correlation.js — همبستگی سیگنال‌ها
// ============================================================
// مسئله: leader و confirmers نباید همیشه با هم سیگنال بدن.
// راه‌حل: Jaccard similarity بین زمان‌های ورود (entryTime).
//
// مثال:
//   SMC Unicorn:   [t1, t5, t10, t20]
//   OB + Sweep:    [t1, t5, t10, t20]    ← Jaccard = 1.0 (بدرد نمیخوره)
//   Donchian:      [t2, t7, t15]         ← Jaccard ~ 0 (عالی)
// ============================================================

/**
 * Jaccard similarity با tolerance زمانی
 * @param {Array<number>} timesA — unix timestamps
 * @param {Array<number>} timesB
 * @param {number} toleranceSec — پیش‌فرض 300s (5min)
 * @returns {number} بین 0 و 1
 */
function jaccardTimes(timesA, timesB, toleranceSec = 300) {
    if (!timesA || !timesB || !timesA.length || !timesB.length) return 0;
    const A = [...timesA].sort((a, b) => a - b);
    const B = [...timesB].sort((a, b) => a - b);

    // Two-pointer matching با tolerance
    let i = 0, j = 0, matches = 0;
    const usedA = new Set();
    const usedB = new Set();

    while (i < A.length && j < B.length) {
        const diff = A[i] - B[j];
        if (Math.abs(diff) <= toleranceSec) {
            matches++;
            usedA.add(i);
            usedB.add(j);
            i++; j++;
        } else if (diff < 0) {
            i++;
        } else {
            j++;
        }
    }

    const union = A.length + B.length - matches;
    return union > 0 ? matches / union : 0;
}

/**
 * ماتریس correlation برای یک نماد
 * @param {Object} timesByStrategy — { strategyId: [t1, t2, ...] }
 * @returns {Object} — { s1: { s2: corr, ... }, ... }
 */
function buildSignalCorrelationMatrix(timesByStrategy, toleranceSec = 300) {
    const strategies = Object.keys(timesByStrategy || {});
    const matrix = {};
    for (const s of strategies) matrix[s] = {};

    for (let i = 0; i < strategies.length; i++) {
        const s1 = strategies[i];
        matrix[s1][s1] = 1;
        for (let j = i + 1; j < strategies.length; j++) {
            const s2 = strategies[j];
            const c = jaccardTimes(timesByStrategy[s1], timesByStrategy[s2], toleranceSec);
            const rounded = Math.round(c * 1000) / 1000;
            matrix[s1][s2] = rounded;
            matrix[s2][s1] = rounded;
        }
    }
    return matrix;
}

/**
 * انتخاب confirmers مستقل از leader
 * @param {string} leaderId
 * @param {Array<{strategyId: string, pf: number}>} candidates — مرتب‌شده بر اساس pf (نزولی)
 * @param {Object} corrMatrix
 * @param {number} threshold — حداکثر همبستگی مجاز (پیش‌فرض 0.5)
 * @param {number} maxCount — حداکثر تعداد confirmers
 * @returns {{ confirmers: string[], rejected: Array<{sid: string, reason: string}> }}
 */
function selectIndependentConfirmers(leaderId, candidates, corrMatrix, threshold = 0.5, maxCount = 2) {
    const confirmers = [];
    const rejected = [];

    for (const cand of candidates) {
        const sid = cand.strategyId;
        if (sid === leaderId) continue;
        if (confirmers.length >= maxCount) {
            rejected.push({ sid, reason: 'به حداکثر confirmers رسیدیم' });
            continue;
        }
        // چک مستقل از leader
        const cLeader = (corrMatrix[leaderId] && corrMatrix[leaderId][sid]) || 0;
        if (cLeader >= threshold) {
            rejected.push({ sid, reason: `همبستگی با leader (${cLeader.toFixed(2)} ≥ ${threshold})` });
            continue;
        }
        // چک مستقل از بقیه confirmers
        let conflictWith = null;
        for (const existing of confirmers) {
            const c2 = (corrMatrix[existing] && corrMatrix[existing][sid]) || 0;
            if (c2 >= threshold) { conflictWith = { sid: existing, corr: c2 }; break; }
        }
        if (conflictWith) {
            rejected.push({ sid, reason: `همبستگی با ${conflictWith.sid} (${conflictWith.corr.toFixed(2)})` });
            continue;
        }
        confirmers.push(sid);
    }

    return { confirmers, rejected };
}

module.exports = {
    jaccardTimes,
    buildSignalCorrelationMatrix,
    selectIndependentConfirmers
};