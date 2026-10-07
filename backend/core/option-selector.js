'use strict';
// ============================================================
// option-selector.js — Unified option selection for ALL paths
// ============================================================
// Used by:
//   - core/options.js   (runHybridOptionBacktest — backtest)
//   - core/options.js   (onBuySignal — live)
//   - services/paper-trading.service.js
//
// Quality levels (A+ strictest → D loosest):
//   A+ : delta 0.45-0.65, days 14-45, spread <= 8%,  oi >= 200, real only
//   A  : delta 0.35-0.75, days 10-55, spread <= 10%, oi >= 100, real only
//   B  : delta 0.25-0.85, days 7-70,  spread <= 15%, oi >= 50,  real+enriched (DEFAULT)
//   C  : delta 0.15-0.90, days 3-90,  spread <= 20%, oi >= 20,  real+enriched
//   D  : delta 0.05-0.98, days 1-180, spread <= 30%, oi >= 0,   real+enriched
// ============================================================

const QUALITY_LEVELS = {
    'A+': { deltaMin: 0.45, deltaMax: 0.65, minDays: 14, maxDays: 45,  maxSpreadPct: 8,  minOI: 200, minPremium: 500, allowEnriched: false, allowMissingDelta: false },
    'A':  { deltaMin: 0.35, deltaMax: 0.75, minDays: 10, maxDays: 55,  maxSpreadPct: 10, minOI: 100, minPremium: 300, allowEnriched: false, allowMissingDelta: false },
    'B':  { deltaMin: 0.25, deltaMax: 0.85, minDays: 7,  maxDays: 70,  maxSpreadPct: 15, minOI: 50,  minPremium: 150, allowEnriched: true,  allowMissingDelta: true  },
    'C':  { deltaMin: 0.15, deltaMax: 0.90, minDays: 3,  maxDays: 90,  maxSpreadPct: 20, minOI: 20,  minPremium: 80,  allowEnriched: true,  allowMissingDelta: true  },
    'D':  { deltaMin: 0.05, deltaMax: 0.98, minDays: 1,  maxDays: 180, maxSpreadPct: 30, minOI: 0,   minPremium: 30,  allowEnriched: true,  allowMissingDelta: true  },
};

const DEFAULT_LEVEL = 'B';

function getQualityParams(level) {
    const key = String(level || DEFAULT_LEVEL).toUpperCase();
    const base = QUALITY_LEVELS[key] || QUALITY_LEVELS[DEFAULT_LEVEL];
    return { ...base, level: key in QUALITY_LEVELS ? key : DEFAULT_LEVEL };
}

function computeSpreadPct(bid, ask) {
    const mid = (bid + ask) / 2;
    return mid > 0 ? ((ask - bid) / mid * 100) : 100;
}

/**
 * Check whether a single contract satisfies quality params.
 * @returns { ok: bool, reason?: string, delta?: number, spreadPct?: number }
 */
function isValidContract(c, params) {
    if (!c) return { ok: false, reason: 'null contract' };
    const bid = Number(c.bid) || 0;
    const ask = Number(c.ask) || 0;
    if (!(ask > 0)) return { ok: false, reason: 'no ask' };
    if (!(bid > 0)) return { ok: false, reason: 'no bid' };

    const spreadPct = computeSpreadPct(bid, ask);
    if (spreadPct > (params.maxSpreadPct || 100)) {
        return { ok: false, reason: 'spread ' + spreadPct.toFixed(1) + '% > ' + params.maxSpreadPct + '%' };
    }
    if (ask < (params.minPremium || 0)) {
        return { ok: false, reason: 'premium ' + ask + ' < ' + params.minPremium };
    }
    if ((c.oi || 0) < (params.minOI || 0)) {
        return { ok: false, reason: 'OI ' + (c.oi || 0) + ' < ' + params.minOI };
    }
    if (params.minDays != null && (c.daysLeft || 0) < params.minDays) {
        return { ok: false, reason: 'daysLeft ' + c.daysLeft + ' < ' + params.minDays };
    }
    if (params.maxDays != null && (c.daysLeft || 9999) > params.maxDays) {
        return { ok: false, reason: 'daysLeft ' + c.daysLeft + ' > ' + params.maxDays };
    }

    const delta = Number(c.delta);
    if (!Number.isFinite(delta)) {
        if (!params.allowMissingDelta) return { ok: false, reason: 'missing delta' };
        // accept with neutral delta
    } else {
        if (delta < params.deltaMin) return { ok: false, reason: 'delta ' + delta.toFixed(2) + ' < ' + params.deltaMin };
        if (delta > params.deltaMax) return { ok: false, reason: 'delta ' + delta.toFixed(2) + ' > ' + params.deltaMax };
    }

    if (!params.allowEnriched) {
        const dq = c.dataQuality || 'real';
        if (dq !== 'real') return { ok: false, reason: 'quality ' + dq };
    }

    return { ok: true, delta: Number.isFinite(delta) ? delta : 0.5, spreadPct };
}

function scoreContract(c, info, params) {
    // delta score: closer to 0.55 is better
    const deltaScore = 1 - Math.abs(info.delta - 0.55) / 0.5;
    // spread score: tighter is better
    const spreadScore = 1 - Math.min(1, info.spreadPct / (params.maxSpreadPct || 30));
    // OI score: log scale
    const oiScore = Math.min(1, Math.log10(Math.max(1, c.oi || 1)) / 4);
    // quality score: real preferred
    const dqScore = (c.dataQuality === 'real') ? 1.0 : 0.85;
    // volume score
    const volScore = Math.min(1, Math.log10(Math.max(1, c.volume || 1)) / 5);

    return deltaScore * 0.35 + spreadScore * 0.25 + oiScore * 0.20 + dqScore * 0.10 + volScore * 0.10;
}

/**
 * Pick the best option from a list of candidates.
 * @param {Array} candidates — [{ symbol, bid, ask, delta, oi, daysLeft, dataQuality, volume, ... }]
 * @param {Object} opts — { qualityLevel: 'A+'|'A'|'B'|'C'|'D', overrideParams?: {...} }
 * @returns { pick: contract|null, level, candidates, rejected, stats }
 */
function selectBestOption(candidates, opts = {}) {
    const params = getQualityParams(opts.qualityLevel);
    if (opts.overrideParams) Object.assign(params, opts.overrideParams);

    const valid = [];
    const rejected = [];

    for (const c of (candidates || [])) {
        const check = isValidContract(c, params);
        if (check.ok) {
            const score = scoreContract(c, check, params);
            valid.push({ ...c, _score: score, _spreadPct: check.spreadPct, _delta: check.delta });
        } else {
            rejected.push({ symbol: c && c.symbol, reason: check.reason });
        }
    }

    if (!valid.length) {
        return {
            pick: null,
            level: params.level,
            rejected,
            totalCandidates: (candidates || []).length,
            stats: { valid: 0, rejected: rejected.length, total: (candidates || []).length },
        };
    }

    valid.sort((a, b) => b._score - a._score);

    return {
        pick: valid[0],
        level: params.level,
        candidates: valid.slice(0, 5),
        rejected,
        totalCandidates: candidates.length,
        stats: { valid: valid.length, rejected: rejected.length, total: candidates.length },
    };
}

module.exports = {
    selectBestOption,
    getQualityParams,
    isValidContract,
    scoreContract,
    computeSpreadPct,
    QUALITY_LEVELS,
    DEFAULT_LEVEL,
};
