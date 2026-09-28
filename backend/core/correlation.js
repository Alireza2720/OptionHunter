'use strict';
// ============================================================
// correlation.js — ماتریس همبستگی از candles_daily
// ============================================================
// - Pearson correlation روی log returns
// - فقط dates مشترک
// - Cache در meta.correlation_matrix
// ============================================================

function pearson(xs, ys) {
    const n = Math.min(xs.length, ys.length);
    if (n < 5) return 0;
    const mx = xs.reduce((s, x) => s + x, 0) / n;
    const my = ys.reduce((s, y) => s + y, 0) / n;
    let num = 0, dx = 0, dy = 0;
    for (let i = 0; i < n; i++) {
        const a = xs[i] - mx;
        const b = ys[i] - my;
        num += a * b;
        dx += a * a;
        dy += b * b;
    }
    const denom = Math.sqrt(dx * dy);
    return denom > 0 ? num / denom : 0;
}

function computeMatrixFromSeries(seriesBySymbol, minCommon = 10) {
    const symbols = Object.keys(seriesBySymbol);

    // 🆕 ۱) ساخت بازار (میانگین همه نمادها به‌ازای هر تاریخ)
    const marketByDate = new Map();   // date → array of log returns
    const allDates = new Set();
    for (const s of symbols) {
        for (const d of seriesBySymbol[s].keys()) allDates.add(d);
    }
    const sortedDates = [...allDates].sort();

    // ساخت return هر نماد
    const returnsBySymbol = {};
    for (const s of symbols) {
        const m = seriesBySymbol[s];
        const ret = new Map();   // date → log return
        let prevDate = null, prevClose = null;
        for (const d of sortedDates) {
            const c = m.get(d);
            if (c == null || c <= 0) continue;
            if (prevClose != null && prevDate != null) {
                ret.set(d, Math.log(c / prevClose));
            }
            prevDate = d; prevClose = c;
        }
        returnsBySymbol[s] = ret;
    }

    // میانگین returns برای هر date → market return
    for (const d of sortedDates) {
        const vals = [];
        for (const s of symbols) {
            const r = returnsBySymbol[s].get(d);
            if (r != null && isFinite(r)) vals.push(r);
        }
        if (vals.length >= 5) {
            marketByDate.set(d, vals.reduce((a, b) => a + b, 0) / vals.length);
        }
    }

    // 🆕 ۲) محاسبه beta و residuals هر نماد
    const residuals = {};   // symbol → Map<date, residual>
    const betas = {};
    for (const s of symbols) {
        const ret = returnsBySymbol[s];
        const xs = [], ys = [];
        for (const [d, r] of ret) {
            const m = marketByDate.get(d);
            if (m != null) { xs.push(m); ys.push(r); }
        }
        if (xs.length < minCommon) { residuals[s] = new Map(); betas[s] = 1; continue; }

        const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
        const my = ys.reduce((a, b) => a + b, 0) / ys.length;
        let num = 0, den = 0;
        for (let i = 0; i < xs.length; i++) {
            num += (xs[i] - mx) * (ys[i] - my);
            den += (xs[i] - mx) ** 2;
        }
        const beta = den > 0 ? num / den : 1;
        betas[s] = beta;

        const res = new Map();
        for (const [d, r] of ret) {
            const m = marketByDate.get(d);
            if (m != null) res.set(d, r - beta * m);
        }
        residuals[s] = res;
    }

    // 🆕 ۳) correlation روی residuals
    const matrix = {};
    for (const s of symbols) matrix[s] = {};

    for (let i = 0; i < symbols.length; i++) {
        const s1 = symbols[i];
        matrix[s1][s1] = 1;
        for (let j = i + 1; j < symbols.length; j++) {
            const s2 = symbols[j];
            const m1 = residuals[s1];
            const m2 = residuals[s2];

            const dates = [];
            for (const d of m1.keys()) if (m2.has(d)) dates.push(d);
            dates.sort();

            if (dates.length < minCommon) {
                matrix[s1][s2] = 0; matrix[s2][s1] = 0; continue;
            }

            const r1 = [], r2 = [];
            for (const d of dates) {
                r1.push(m1.get(d));
                r2.push(m2.get(d));
            }
            const c = pearson(r1, r2);
            matrix[s1][s2] = Math.round(c * 10000) / 10000;
            matrix[s2][s1] = matrix[s1][s2];
        }
    }
    return matrix;
}

// ------------------------------------------------------------
// یافتن خوشه‌های همبسته
// ------------------------------------------------------------
function findClusters(matrix, threshold = 0.7) {
    const symbols = Object.keys(matrix);
    const visited = new Set();
    const clusters = [];

    for (const s of symbols) {
        if (visited.has(s)) continue;
        const cluster = [s];
        visited.add(s);
        const queue = [s];

        while (queue.length) {
            const cur = queue.shift();
            for (const t of symbols) {
                if (visited.has(t)) continue;
                const corr = (matrix[cur] && matrix[cur][t]) || 0;
                if (Math.abs(corr) >= threshold) {
                    visited.add(t);
                    cluster.push(t);
                    queue.push(t);
                }
            }
        }
        if (cluster.length > 1) clusters.push(cluster);
    }
    return clusters;
}

module.exports = { pearson, computeMatrixFromSeries, findClusters };