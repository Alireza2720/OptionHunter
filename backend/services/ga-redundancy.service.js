'use strict';
// ============================================================
// ga-redundancy.service.js — cosine filter on equity curves
// ============================================================
// Compares pairs of strategies by equity-curve cosine similarity.
// similarity > threshold → drop the weaker (lower fitness).
// ============================================================

const DEFAULT_THRESHOLD = 0.95;

function _normalize(curve) {
    if (!Array.isArray(curve) || curve.length < 2) return null;
    const base = curve[0];
    const arr = curve.map(x => x - base);
    const mag = Math.sqrt(arr.reduce((s, x) => s + x * x, 0));
    if (mag < 1e-9) return null;
    return arr.map(x => x / mag);
}

function cosineSimilarity(curve1, curve2) {
    const a = _normalize(curve1);
    const b = _normalize(curve2);
    if (!a || !b) return 0;
    const n = Math.min(a.length, b.length);
    let dot = 0;
    for (let i = 0; i < n; i++) dot += a[i] * b[i];
    return Math.max(-1, Math.min(1, dot));
}

function findRedundant(items, threshold) {
    threshold = threshold || DEFAULT_THRESHOLD;
    const pairs = [];
    for (let i = 0; i < items.length; i++) {
        for (let j = i + 1; j < items.length; j++) {
            const a = items[i], b = items[j];
            if (!a.equityCurve || !b.equityCurve) continue;
            const sim = cosineSimilarity(a.equityCurve, b.equityCurve);
            if (sim >= threshold) {
                const weaker = (a.fitness || 0) < (b.fitness || 0) ? a : b;
                pairs.push({
                    a: a.strategyId, b: b.strategyId,
                    similarity: Math.round(sim * 10000) / 10000,
                    drop: weaker.strategyId
                });
            }
        }
    }
    const toDrop = new Set(pairs.map(p => p.drop));
    return { pairs: pairs, toDrop: Array.from(toDrop), threshold: threshold };
}

module.exports = { cosineSimilarity, findRedundant, DEFAULT_THRESHOLD };