'use strict';
// ============================================================
// ga-sampler.service.js — simplified TPE (Tree-structured Parzen)
// ============================================================
// Maintains history of (params, fitness). Splits into "good" (top
// quantile) and "bad". For each param, samples 24 candidates, keeps
// one with highest likelihood-ratio l(x)/g(x) (KDE-based).
// ============================================================

const GOOD_QUANTILE = 0.25;
const MIN_HISTORY_FOR_KDE = 15;
const N_CANDIDATES = 24;

function sampleUniform(range) {
    if (!range) return null;
    // BUG-40 fix: support banned values (from ParamPruner)
    const banned = range.banned || [];
    const bannedSet = banned.length ? new Set(banned.map(String)) : null;

    if (range.type === 'choice') {
        const arr = (range.values || []).filter(v => !bannedSet || !bannedSet.has(String(v)));
        if (!arr.length) return null;
        return arr[Math.floor(Math.random() * arr.length)];
    }
    if (range.type === 'float') {
        if (!bannedSet) return range.min + Math.random() * (range.max - range.min);
        for (let k = 0; k < 30; k++) {
            const v = range.min + Math.random() * (range.max - range.min);
            if (!bannedSet.has(v.toFixed(6)) && !bannedSet.has(String(v))) return v;
        }
        return range.min + Math.random() * (range.max - range.min);
    }
    if (range.type === 'int') {
        const span = range.max - range.min + 1;
        if (!bannedSet) return Math.floor(range.min + Math.random() * span);
        for (let k = 0; k < 50; k++) {
            const v = Math.floor(range.min + Math.random() * span);
            if (!bannedSet.has(String(v))) return v;
        }
        return Math.floor(range.min + Math.random() * span);
    }
    return null;
}

function _kde1D(samples, x, bandwidth) {
    if (!samples.length) return 0;
    const bw = bandwidth || 1e-3;
    let sum = 0;
    for (const s of samples) {
        const d = (x - s) / bw;
        sum += Math.exp(-0.5 * d * d);
    }
    return sum / (samples.length * bw * Math.sqrt(2 * Math.PI));
}

function _defaultBandwidth(values, range) {
    if (values.length < 2) return (range.max - range.min) / 10 || 0.1;
    const m = values.reduce((a, b) => a + b, 0) / values.length;
    const v = values.reduce((a, b) => a + (b - m) * (b - m), 0) / (values.length - 1);
    const sd = Math.sqrt(v) || (range.max - range.min) / 10 || 0.1;
    return Math.max(0.01, 1.06 * sd * Math.pow(values.length, -0.2));
}

function TPESampler(searchSpace) {
    this.space = searchSpace || {};
    this.history = [];
}

TPESampler.prototype.addPoint = function (params, fitness) {
    this.history.push({ params: Object.assign({}, params), fitness: fitness });
};

TPESampler.prototype.sample = function () {
    const out = {};
    const n = this.history.length;

    if (n < MIN_HISTORY_FOR_KDE) {
        for (const k of Object.keys(this.space)) {
            out[k] = sampleUniform(this.space[k]);
        }
        return out;
    }

    const sorted = this.history.slice().sort((a, b) => b.fitness - a.fitness);
    const nGood = Math.max(3, Math.floor(n * GOOD_QUANTILE));
    const good = sorted.slice(0, nGood);
    const bad = sorted.slice(nGood);

    for (const k of Object.keys(this.space)) {
        const range = this.space[k];

        if (range.type === 'choice') {
            out[k] = this._sampleChoice(k, range, good);
            continue;
        }

        const goodVals = good.map(h => h.params[k]).filter(Number.isFinite);
        const badVals = bad.map(h => h.params[k]).filter(Number.isFinite);

        if (!goodVals.length) {
            out[k] = sampleUniform(range);
            continue;
        }

        const bwGood = _defaultBandwidth(goodVals, range);
        const bwBad = badVals.length ? _defaultBandwidth(badVals, range) : bwGood;

        let bestX = null;
        let bestRatio = -Infinity;
        for (let i = 0; i < N_CANDIDATES; i++) {
            const x = sampleUniform(range);
            const lGood = _kde1D(goodVals, x, bwGood);
            const lBad = _kde1D(badVals, x, bwBad);
            const ratio = lGood / (lBad + 1e-9);
            if (ratio > bestRatio) {
                bestRatio = ratio;
                bestX = x;
            }
        }
        if (bestX === null) bestX = sampleUniform(range);
        out[k] = range.type === 'int' ? Math.round(bestX) : bestX;
        if (range.min !== undefined && out[k] < range.min) out[k] = range.min;
        if (range.max !== undefined && out[k] > range.max) out[k] = range.max;
    }
    return out;
};

TPESampler.prototype._sampleChoice = function (k, range, good) {
    const freq = {};
    for (const h of good) {
        const v = h.params[k];
        freq[v] = (freq[v] || 0) + 1;
    }
    const vals = Object.keys(freq);
    if (!vals.length) return sampleUniform(range);
    const total = vals.reduce((s, v) => s + freq[v], 0);
    let r = Math.random() * total;
    for (const v of vals) {
        r -= freq[v];
        if (r <= 0) {
            const orig = (range.values || []).find(x => String(x) === String(v));
            return orig !== undefined ? orig : v;
        }
    }
    return sampleUniform(range);
};

TPESampler.prototype.export = function () {
    return { space: this.space, history: this.history };
};

TPESampler.import = function (state) {
    const s = new TPESampler(state.space || {});
    s.history = state.history || [];
    return s;
};

module.exports = { TPESampler, sampleUniform };