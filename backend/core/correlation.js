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
    const matrix = {};
    for (const s of symbols) matrix[s] = {};

    for (let i = 0; i < symbols.length; i++) {
        const s1 = symbols[i];
        matrix[s1][s1] = 1;
        for (let j = i + 1; j < symbols.length; j++) {
            const s2 = symbols[j];
            const m1 = seriesBySymbol[s1];
            const m2 = seriesBySymbol[s2];

            // تاریخ‌های مشترک
            const dates = [];
            for (const d of m1.keys()) {
                if (m2.has(d)) dates.push(d);
            }
            dates.sort();

            if (dates.length < minCommon) {
                matrix[s1][s2] = 0;
                matrix[s2][s1] = 0;
                continue;
            }

            const r1 = [], r2 = [];
            for (let k = 1; k < dates.length; k++) {
                const a1 = m1.get(dates[k - 1]), b1 = m1.get(dates[k]);
                const a2 = m2.get(dates[k - 1]), b2 = m2.get(dates[k]);
                if (a1 > 0 && b1 > 0 && a2 > 0 && b2 > 0) {
                    r1.push(Math.log(b1 / a1));
                    r2.push(Math.log(b2 / a2));
                }
            }
            const c = r1.length >= minCommon ? pearson(r1, r2) : 0;
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