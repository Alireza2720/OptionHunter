'use strict';
// ============================================================
// multiple-testing.js — تصحیح Multiple Testing
// ============================================================
// وقتی ۳۷۵ ترکیب تست می‌کنیم، با p<0.05 خام، ~۱۹ pair شانسی
// قبول می‌شن. Benjamini-Hochberg این رو تصحیح می‌کنه.
//
// مرجع: Benjamini, Y., & Hochberg, Y. (1995)
// ============================================================

/**
 * BH FDR correction
 * @param {Array<{key: string, p: number}>} pvalues
 * @param {number} q — سطح FDR (پیش‌فرض 0.05)
 * @returns {{ pass: Set<string>, qvalues: Map<string, number>, threshold: number, n: number, q: number }}
 */
function benjaminiHochberg(pvalues, q = 0.05) {
    if (!Array.isArray(pvalues) || !pvalues.length) {
        return { pass: new Set(), qvalues: new Map(), threshold: 0, n: 0, q };
    }
    // فیلتر مقادیر معتبر
    const valid = pvalues.filter(x => x && x.key && Number.isFinite(x.p) && x.p >= 0 && x.p <= 1);
    if (!valid.length) {
        return { pass: new Set(), qvalues: new Map(), threshold: 0, n: 0, q };
    }

    const sorted = [...valid].sort((a, b) => a.p - b.p);
    const n = sorted.length;

    // پیدا کردن بزرگ‌ترین rank که p_(k) <= (k/n) * q
    let maxK = 0;
    for (let i = 0; i < n; i++) {
        const rank = i + 1;
        if (sorted[i].p <= (rank / n) * q) maxK = rank;
    }

    const pass = new Set();
    const qvalues = new Map();
    for (let i = 0; i < n; i++) {
        const rank = i + 1;
        // q-value = p * n / rank (adjustشده)
        const qval = Math.min(1, sorted[i].p * n / rank);
        qvalues.set(sorted[i].key, Math.round(qval * 100000) / 100000);
        if (rank <= maxK) pass.add(sorted[i].key);
    }

    return {
        pass,
        qvalues,
        threshold: maxK > 0 ? sorted[maxK - 1].p : 0,
        n,
        q
    };
}

/**
 * Bonferroni ساده (اختیاری — سختگیرانه‌تر)
 */
function bonferroni(pvalues, alpha = 0.05) {
    if (!Array.isArray(pvalues) || !pvalues.length) {
        return { pass: new Set(), threshold: 0, n: 0 };
    }
    const valid = pvalues.filter(x => x && x.key && Number.isFinite(x.p));
    const n = valid.length;
    const threshold = n > 0 ? alpha / n : 0;
    const pass = new Set();
    for (const x of valid) if (x.p <= threshold) pass.add(x.key);
    return { pass, threshold, n };
}

module.exports = { benjaminiHochberg, bonferroni };