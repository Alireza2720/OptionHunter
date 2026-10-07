'use strict';
// ============================================================
// sizing-unified.js — single sizing logic for live + backtest
// ============================================================
// Inputs:
//   candidate: { symbol, optionEntry, size, entryTime, signalScore }
//   portfolio: { totalExposure, exposureBySymbol, openPositions }
//   settings:  { capital, riskPct, maxSymPct }
//   options:   { scoreFactor }   ← from settings.scoreSizeFactor()
//
// Output: { size, baseSize, limits, limitReason }

function calcUnifiedSize(candidate, portfolio, settings, opts = {}) {
    const capital = settings.capital || 100_000_000;
    const riskPct = settings.riskPct || 1.5;
    const maxSymPct = settings.maxSymPct || 20;

    const contractValue = (candidate.optionEntry || 0) * (candidate.size || 1000);
    if (!(contractValue > 0)) return { size: 0, reason: 'invalid contract value' };

    const riskAmt = capital * (riskPct / 100);
    const baseSize = Math.floor(riskAmt / contractValue);

    const scoreFactor = (opts.scoreFactor != null && Number.isFinite(opts.scoreFactor))
        ? opts.scoreFactor : 1.0;

    // 🆕 Grade-aware option size factor (from core/options.js)
    const optionSizeFactor = (opts.optionSizeFactor != null && Number.isFinite(opts.optionSizeFactor))
        ? opts.optionSizeFactor : 1.0;

    const adjusted = Math.floor(baseSize * scoreFactor * optionSizeFactor);

    const remainingSymbol = Math.max(0, capital * (maxSymPct / 100) - (portfolio.exposureBySymbol[candidate.symbol] || 0));
    const bySymbol = Math.floor(remainingSymbol / contractValue);

    const availableCash = Math.max(0, capital - (portfolio.totalExposure || 0));
    const byCash = Math.floor(availableCash / contractValue);

    const finalSize = Math.max(0, Math.min(adjusted, bySymbol, byCash));

    let limitReason = null;
    if (finalSize < adjusted) {
        if (bySymbol < adjusted) limitReason = 'سقف نماد';
        else if (byCash < adjusted) limitReason = 'نقد کافی نیست';
    }
    if (finalSize === 0) {
        if (baseSize === 0) limitReason = 'سرمایه برای این قرارداد کافی نیست';
        else if (bySymbol === 0) limitReason = 'سقف نماد پر است';
        else if (byCash === 0) limitReason = 'نقد کافی نیست';
    }

    return {
        size: finalSize,
        baseSize,
        adjusted,
        scoreFactor,
        limits: { bySymbol, byCash, contractValue },
        limitReason
    };
}

module.exports = { calcUnifiedSize };
