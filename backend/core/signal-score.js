'use strict';
// ============================================================
// signal-score.js — Signal Intelligence (Phase 4)
// ============================================================
// - Weighted confluence (diversity-based)
// - Signal strength score [0, 1] — Base + Bonus model
// ============================================================

// ------------------------------------------------------------
// Diversity-weighted confluence
// ------------------------------------------------------------
function diversityWeightedConfluence(confirmers) {
    if (!confirmers || !confirmers.length) return { effective: 0, raw: 0, diversity: 0 };

    const byStrategy = {};
    for (const c of confirmers) {
        const sid = c.strategyId || 'unknown';
        byStrategy[sid] = (byStrategy[sid] || 0) + 1;
    }

    let effective = 0;
    for (const [sid, count] of Object.entries(byStrategy)) {
        effective += 1;
    }

    return {
        effective: Math.round(effective * 100) / 100,
        raw: confirmers.length,
        diversity: Object.keys(byStrategy).length,
        byStrategy
    };
}

// ------------------------------------------------------------
// Signal Strength Score [0, 1] — Base + Bonus
// ------------------------------------------------------------
function computeSignalScore(input) {
    const {
        confluenceEffective = 1,
        htfTrend = null,
        atr = null,
        price = null,
        rsiFast = null,
        ivHv = null,
        regimeMacro = 'unknown',
        regimeVol = 'normal'
    } = input || {};

    // Base — هر سیگنال معتبر این رو داره
    let score = 0.50;
    const parts = [{ name: 'base', value: 0.50 }];

    // ۱. Confluence bonus (0 / 0.10 / 0.20)
    let confBonus = 0;
    if (confluenceEffective >= 3) confBonus = 0.20;
    else if (confluenceEffective >= 2) confBonus = 0.10;
    score += confBonus;
    parts.push({ name: 'confluence', value: confBonus });

    // ۲. HTF Trend bonus (0 / 0.05 / 0.10)
    let trendBonus = 0;
    if (htfTrend === 'صعودی' || htfTrend === 'bull') trendBonus = 0.10;
    else if (htfTrend === 'خنثی' || htfTrend === 'range') trendBonus = 0.05;
    score += trendBonus;
    parts.push({ name: 'htfTrend', value: trendBonus });

    // ۳. ATR bonus (0 / 0.05)
    let atrBonus = 0;
    if (atr && price && price > 0) {
        const atrPct = (atr / price) * 100;
        if (atrPct >= 0.5 && atrPct <= 3.0) atrBonus = 0.05;
    }
    score += atrBonus;
    parts.push({ name: 'atr', value: atrBonus });

    // ۴. RSI bonus (0 / 0.05)
    let rsiBonus = 0;
    if (rsiFast !== null && rsiFast !== undefined && Number.isFinite(rsiFast)) {
        if (rsiFast >= 40 && rsiFast <= 70) rsiBonus = 0.05;
    }
    score += rsiBonus;
    parts.push({ name: 'rsi', value: rsiBonus });

    // ۵. IV/HV bonus (0 / 0.05)
    let ivBonus = 0;
    if (ivHv !== null && ivHv !== undefined && Number.isFinite(ivHv)) {
        if (ivHv >= 0.8 && ivHv <= 1.3) ivBonus = 0.05;
    }
    score += ivBonus;
    parts.push({ name: 'ivHv', value: ivBonus });

    // ۶. Regime bonus (-0.10 تا +0.10)
    let regimeBonus = 0;
    if (regimeMacro === 'bull') regimeBonus = 0.10;
    else if (regimeMacro === 'range') regimeBonus = 0.03;
    else if (regimeMacro === 'bear') regimeBonus = -0.10;
    if (regimeVol === 'high') regimeBonus *= 0.5;
    score += regimeBonus;
    parts.push({ name: 'regime', value: regimeBonus });

    // Cap [0, 1]
    score = Math.max(0, Math.min(1, score));
    score = Math.round(score * 1000) / 1000;

    return {
        score,
        level: score >= 0.75 ? 'high' : score >= 0.60 ? 'mid' : score >= 0.45 ? 'low' : 'very_low',
        parts
    };
}

// ------------------------------------------------------------
// Size factor from score
// ------------------------------------------------------------
function scoreToSizeFactor(score) {
    if (score >= 0.80) return 1.3;
    if (score >= 0.65) return 1.1;
    if (score >= 0.55) return 1.0;
    if (score >= 0.45) return 0.8;
    if (score >= 0.30) return 0.5;
    return 0.3;
}

// ------------------------------------------------------------
// Historical Score — برای بک‌تست
// ------------------------------------------------------------
function computeHistoricalScore(trade, regimeAtEntry) {
    try {
        if (!trade || typeof trade !== 'object') {
            return { score: 0.5, level: 'mid', error: 'trade invalid' };
        }
        if (typeof computeSignalScore !== 'function') {
            return { score: 0.5, level: 'mid', error: 'computeSignalScore missing' };
        }

        const atrVal = Number(trade.atr);
        const priceVal = Number(trade.stockEntry);
        const rsiVal = Number(trade.rsiFast);
        const ivVal = Number(trade.ivHv);

        return computeSignalScore({
            confluenceEffective: Number(trade.confluenceEffective) || 1,
            htfTrend: trade.htfTrend || null,
            atr: Number.isFinite(atrVal) && atrVal > 0 ? atrVal : null,
            price: Number.isFinite(priceVal) && priceVal > 0 ? priceVal : null,
            rsiFast: Number.isFinite(rsiVal) ? rsiVal : null,
            ivHv: Number.isFinite(ivVal) && ivVal > 0 ? ivVal : null,
            regimeMacro: (regimeAtEntry && regimeAtEntry.macro) || 'unknown',
            regimeVol: (regimeAtEntry && regimeAtEntry.vol) || 'normal'
        });
    } catch (e) {
        return {
            score: 0.5,
            level: 'mid',
            error: e.message
        };
    }
}

module.exports = {
    diversityWeightedConfluence,
    computeSignalScore,
    computeHistoricalScore,
    scoreToSizeFactor
};