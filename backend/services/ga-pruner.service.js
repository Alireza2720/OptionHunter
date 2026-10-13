'use strict';
// ============================================================
// ga-pruner.service.js — Median pruner + permanent param pruning
// ============================================================
// 1) MedianPruner: prune trial if running value < median at same step.
// 2) ParamPruner: track (param, value) streak of being in bottom
//    quantile. After N consecutive bad, drop that value permanently.
// ============================================================

const BAD_QUANTILE = 0.20;
const CONSECUTIVE_BAD_TO_PRUNE = 3;
const MIN_HISTORY = 5;

function MedianPruner() {
    this.trials = [];
}
MedianPruner.prototype.shouldPrune = function (step, value) {
    const sameStep = this.trials.filter(t => t.step === step).map(t => t.value);
    this.trials.push({ step: step, value: value });
    if (step === 0 || sameStep.length < 3) return false;
    const sorted = sameStep.slice().sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    return value < median;
};

function ParamPruner(searchSpace) {
    this.space = searchSpace || {};
    this.history = [];
    this.badStreak = {};
    this.pruned = {};
    for (const k of Object.keys(this.space)) {
        this.badStreak[k] = {};
        this.pruned[k] = new Set();
    }
}

ParamPruner.prototype.report = function (params, fitness) {
    this.history.push({ params: Object.assign({}, params), fitness: fitness });
    if (this.history.length < MIN_HISTORY) return this.snapshot();

    const sorted = this.history.slice().sort((a, b) => b.fitness - a.fitness);
    const cutoff = Math.max(1, Math.floor(sorted.length * BAD_QUANTILE));
    const worst = sorted.slice(-cutoff);
    const worstSet = new Set(worst.map(w => JSON.stringify(w.params)));
    const currentIsBad = worstSet.has(JSON.stringify(params));

    for (const k of Object.keys(this.space)) {
        const v = params[k];
        const key = String(v);
        if (this.pruned[k].has(v)) continue;
        if (currentIsBad) {
            this.badStreak[k][key] = (this.badStreak[k][key] || 0) + 1;
            if (this.badStreak[k][key] >= CONSECUTIVE_BAD_TO_PRUNE) {
                const remaining = this._countRemaining(k);
                if (remaining > 2) this.pruned[k].add(v);
            }
        } else {
            this.badStreak[k][key] = 0;
        }
    }
    return this.snapshot();
};

ParamPruner.prototype._countRemaining = function (k) {
    const range = this.space[k];
    if (!range) return 0;
    if (range.type === 'choice') {
        return (range.values || []).filter(v => !this.pruned[k].has(v)).length;
    }
    const total = range.type === 'int'
        ? (range.max - range.min + 1)
        : Math.ceil((range.max - range.min) / (range.step || 0.1));
    return Math.max(0, total - this.pruned[k].size);
};

ParamPruner.prototype.reducedSpace = function () {
    const out = {};
    for (const k of Object.keys(this.space)) {
        const range = this.space[k];
        if (range.type === 'choice') {
            const vals = (range.values || []).filter(v => !this.pruned[k].has(v));
            if (vals.length < 2) {
                out[k] = Object.assign({}, range);
            } else {
                out[k] = Object.assign({}, range, { values: vals });
            }
        } else {
            out[k] = Object.assign({}, range);
        }
    }
    return out;
};

ParamPruner.prototype.snapshot = function () {
    let prunedCount = 0;
    const pruned = {};
    for (const [k, set] of Object.entries(this.pruned)) {
        prunedCount += set.size;
        pruned[k] = Array.from(set);
    }
    return { prunedCount: prunedCount, pruned: pruned, historySize: this.history.length };
};

ParamPruner.prototype.export = function () {
    const pruned = {};
    for (const [k, set] of Object.entries(this.pruned)) {
        pruned[k] = Array.from(set);
    }
    return { space: this.space, history: this.history, badStreak: this.badStreak, pruned: pruned };
};

ParamPruner.import = function (state) {
    const p = new ParamPruner(state.space || {});
    p.history = state.history || [];
    p.badStreak = state.badStreak || {};
    p.pruned = {};
    for (const [k, arr] of Object.entries(state.pruned || {})) {
        p.pruned[k] = new Set(arr);
    }
    return p;
};

module.exports = { MedianPruner, ParamPruner };