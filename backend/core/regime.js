'use strict';
// ============================================================
// regime.js — تشخیص رژیم بازار (Pure)
// ============================================================
// - Macro: bull / bear / range (EMA200 + slope)
// - Vol:   high / normal / low (ATR percentile)
// - نگاشت استراتژی → رژیم مجاز
// ============================================================

const REGIME = { BULL: 'bull', BEAR: 'bear', RANGE: 'range', UNKNOWN: 'unknown' };
const VOL_STATE = { HIGH: 'high', NORMAL: 'normal', LOW: 'low', UNKNOWN: 'unknown' };

function computeEMA(closes, period) {
    const ema = new Array(closes.length).fill(null);
    if (closes.length < period) return ema;
    let sum = 0;
    for (let i = 0; i < period; i++) sum += closes[i];
    ema[period - 1] = sum / period;
    const k = 2 / (period + 1);
    for (let i = period; i < closes.length; i++) {
        ema[i] = closes[i] * k + ema[i - 1] * (1 - k);
    }
    return ema;
}

function computeATR(candles, period) {
    const atr = new Array(candles.length).fill(null);
    if (candles.length <= period) return atr;
    const tr = candles.map((c, i) => i === 0
        ? c.high - c.low
        : Math.max(
            c.high - c.low,
            Math.abs(c.high - candles[i - 1].close),
            Math.abs(c.low - candles[i - 1].close)
        )
    );
    let sum = 0;
    for (let i = 1; i <= period; i++) sum += tr[i];
    atr[period] = sum / period;
    for (let i = period + 1; i < candles.length; i++) {
        atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
    }
    return atr;
}
function computeADX(candles, period) {
    if (candles.length <= period + 1) return [];
    const out = new Array(candles.length).fill(null);
    const tr = [], plusDM = [], minusDM = [];
    for (let i = 0; i < candles.length; i++) {
        if (i === 0) { tr.push(candles[i].high - candles[i].low); plusDM.push(0); minusDM.push(0); continue; }
        const h = candles[i].high, l = candles[i].low, ph = candles[i-1].high, pl = candles[i-1].low, pc = candles[i-1].close;
        tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
        const upMove = h - ph, downMove = pl - l;
        plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
        minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    }
    if (tr.length <= period) return out;
    let trS = 0, pS = 0, mS = 0;
    for (let i = 1; i <= period; i++) { trS += tr[i]; pS += plusDM[i]; mS += minusDM[i]; }
    let atrVal = trS / period;
    let pDI = 100 * (pS / period) / (atrVal || 1);
    let mDI = 100 * (mS / period) / (atrVal || 1);
    let dx = 100 * Math.abs(pDI - mDI) / ((pDI + mDI) || 1);
    out[period] = dx;
    for (let i = period + 1; i < candles.length; i++) {
        atrVal = (atrVal * (period - 1) + tr[i]) / period;
        pS = (pS * (period - 1) + plusDM[i]) / period;
        mS = (mS * (period - 1) + minusDM[i]) / period;
        pDI = 100 * pS / (atrVal || 1);
        mDI = 100 * mS / (atrVal || 1);
        dx = 100 * Math.abs(pDI - mDI) / ((pDI + mDI) || 1);
        const prev = out[i-1];
        out[i] = prev === null ? dx : (prev * (period - 1) + dx) / period;
    }
    return out;
}

function detectMacroRegime(dailyCandles, opts = {}) {
    if (!dailyCandles || dailyCandles.length < 30) {
        return { regime: REGIME.UNKNOWN, reason: 'data < 30' };
    }
    const emaPeriod = 30;
    const adxPeriod = 14;
    const slopeBars = 5;
    const closes = dailyCandles.map(c => c.close);
    const ema = computeEMA(closes, emaPeriod);
    const adx = computeADX(dailyCandles, adxPeriod);
    const lastIdx = closes.length - 1;
    if (ema[lastIdx] === null || ema[lastIdx - slopeBars] === null || adx[lastIdx] === null) {
        return { regime: REGIME.UNKNOWN, reason: 'indicators null' };
    }
    const curClose = closes[lastIdx];
    const curEma = ema[lastIdx];
    const prevEma = ema[lastIdx - slopeBars];
    const slopePct = ((curEma - prevEma) / prevEma) * 100;
    const adxVal = adx[lastIdx];
    let regime;
    if (adxVal >= 25) {
        if (curClose > curEma && slopePct > 0.2) regime = REGIME.BULL;
        else if (curClose < curEma && slopePct < -0.2) regime = REGIME.BEAR;
        else regime = REGIME.RANGE;
    } else {
        regime = REGIME.RANGE;
    }
    const reason = 'EMA' + emaPeriod + '/ADX' + adxPeriod + '=' + adxVal.toFixed(1) + ' slope=' + slopePct.toFixed(2) + '%';
    return { regime, reason, close: curClose, ema: Math.round(curEma), adx: Math.round(adxVal * 10) / 10, slopePct };
}

function detectVolatilityState(dailyCandles, opts = {}) {
    const atrPeriod = opts.atrPeriod || 10;
    const lookback = opts.lookback || 20;
    if (!dailyCandles || dailyCandles.length < atrPeriod + lookback) {
        return { state: VOL_STATE.UNKNOWN };
    }
    const atr = computeATR(dailyCandles, atrPeriod);
    const recent = atr.slice(-lookback).filter(x => x !== null);
    if (recent.length < 10) return { state: VOL_STATE.UNKNOWN };
    const sorted = [...recent].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const cur = recent[recent.length - 1];
    const ratio = median > 0 ? cur / median : 1;
    if (ratio > 1.5) return { state: VOL_STATE.HIGH, ratio: Math.round(ratio * 100) / 100, atr: Math.round(cur) };
    if (ratio < 0.7) return { state: VOL_STATE.LOW, ratio: Math.round(ratio * 100) / 100, atr: Math.round(cur) };
    return { state: VOL_STATE.NORMAL, ratio: Math.round(ratio * 100) / 100, atr: Math.round(cur) };
}

// ------------------------------------------------------------
// نگاشت استراتژی → رژیم مجاز
// ------------------------------------------------------------
// macro: لیست رژیم‌های ماکرو که استراتژی در آن‌ها مجاز است
// vol:   لیست حالت‌های نوسان
// 🆕 auto-derive از strategies.js (regime field) — با fallback
let STRATEGY_REGIME_MAP = {};
try {
    const { STRATEGIES } = require('../strategies');
    for (const s of Object.values(STRATEGIES)) {
        if (s.regime && s.regime.macro) {
            STRATEGY_REGIME_MAP[s.id] = {
                macro: s.regime.macro,
                vol: s.regime.vol || ['normal']
            };
        }
    }
} catch (_) {}

// Fallback: اگه هیچی از strategies نیومد
if (Object.keys(STRATEGY_REGIME_MAP).length === 0) {
    STRATEGY_REGIME_MAP = {
        smc_unicorn:         { macro: ['bull','range'], vol: ['normal','high'] },
        ob_sweep:            { macro: ['bull','range','bear'], vol: ['normal','high'] },
        supply_demand:       { macro: ['bull','range'], vol: ['normal','low'] },
        ob_after_sweep:      { macro: ['bull','range'], vol: ['normal','high'] },
        orb:                 { macro: ['bull','range'], vol: ['normal','high'] },
        ensemble:            { macro: ['bull','range'], vol: ['normal','high'] },
        vwap_bounce:         { macro: ['bull','range'], vol: ['normal'] },
        bb_squeeze:          { macro: ['range','bull'], vol: ['low','normal'] },
        donchian:            { macro: ['bull','bear'], vol: ['normal','high'] },
        rsi_pullback:        { macro: ['bull'], vol: ['normal'] },
        macd_trend:          { macro: ['bull','bear'], vol: ['normal','high'] },
        ichimoku_cloud:      { macro: ['bull','bear'], vol: ['normal','high'] },
        ema_stack:           { macro: ['bull'], vol: ['normal','low'] },
        rsi_oversold_bounce: { macro: ['range','bear','bull'], vol: ['normal','high'] },
        gap_fill:            { macro: ['range','bull','bear'], vol: ['normal'] },
        atr_expansion:       { macro: ['bull','range'], vol: ['high','normal'] },
        pairs_spread:        { macro: ['range','bull','bear'], vol: ['normal','low'] },
        sector_momentum:     { macro: ['bull'], vol: ['normal','high'] }
    };
}

// ------------------------------------------------------------
// Regime Size Factor (Soft) — فیلوسوفی جدید
// ------------------------------------------------------------
// به جای رد کردن سیگنال، سایز رو کم می‌کنه
// مگر در حالت بسیار خطرناک (bear+high+strategy نامناسب) → 0
function regimeSizeFactor(strategyId, macro, vol) {
    const rule = STRATEGY_REGIME_MAP[strategyId];

    // استراتژی نامعلوم → محافظه‌کارانه
    if (!rule) {
        return { factor: 0.7, reason: 'استراتژی نامعلوم' };
    }

    const macroMatch = !rule.macro || rule.macro.length === 0 || rule.macro.includes(macro);
    const volMatch = !rule.vol || rule.vol.length === 0 || rule.vol.includes(vol);

    // حالت بسیار خطرناک → صفر
    // (استراتژی برای bull طراحی شده ولی بازار bear+high هست)
    if (macro === 'bear' && vol === 'high' && !macroMatch) {
        return { factor: 0, reason: 'بسیار خطرناک: bear + high vol + استراتژی نامناسب' };
    }

    let factor = 1.0;
    const reasons = [];

    // ضریب رژیم
    if (!macroMatch) {
        if (macro === 'bear') { factor *= 0.3; reasons.push('bear 30%'); }
        else if (macro === 'range') { factor *= 0.6; reasons.push('range 60%'); }
        else if (macro === 'unknown') { factor *= 0.7; reasons.push('unknown 70%'); }
    }

    // ضریب نوسان
    if (!volMatch) {
        if (vol === 'high') { factor *= 0.7; reasons.push('vol-high 70%'); }
        else if (vol === 'low') { factor *= 0.9; reasons.push('vol-low 90%'); }
    }

    return {
        factor: Math.round(factor * 1000) / 1000,
        reason: reasons.length ? reasons.join(' + ') : 'ok'
    };
}

// سازگاری با کد قدیمی — hard reject (فقط برای reference)
function isStrategyAllowed(strategyId, macro, vol) {
    const rule = STRATEGY_REGIME_MAP[strategyId];
    if (!rule) return { allowed: true, reason: 'no rule' };
    const macroOk = !rule.macro || rule.macro.length === 0 || rule.macro.includes(macro);
    const volOk = !rule.vol || rule.vol.length === 0 || rule.vol.includes(vol);
    if (macroOk && volOk) return { allowed: true, reason: 'ok' };
    const reasons = [];
    if (!macroOk) reasons.push(`macro=${macro} مجاز نیست`);
    if (!volOk) reasons.push(`vol=${vol} مجاز نیست`);
    return { allowed: false, reason: reasons.join(' + ') };
}

module.exports = {
    REGIME, VOL_STATE,
    computeEMA, computeATR,
    detectMacroRegime, detectVolatilityState,
    STRATEGY_REGIME_MAP,
    isStrategyAllowed,
    regimeSizeFactor
};