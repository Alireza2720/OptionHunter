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

function detectMacroRegime(dailyCandles, opts = {}) {
    const emaPeriod = opts.emaPeriod || 200;
    const slopeBars = opts.slopeBars || 10;
    if (!dailyCandles || dailyCandles.length < emaPeriod + slopeBars) {
        return { regime: REGIME.UNKNOWN, reason: `دیتا کم (${dailyCandles?.length || 0} < ${emaPeriod + slopeBars})` };
    }
    const closes = dailyCandles.map(c => c.close);
    const ema = computeEMA(closes, emaPeriod);
    const lastIdx = closes.length - 1;
    const cur = closes[lastIdx];
    const curEma = ema[lastIdx];
    const prevEma = ema[lastIdx - slopeBars];

    if (curEma === null || prevEma === null) {
        return { regime: REGIME.UNKNOWN, reason: 'EMA محاسبه نشد' };
    }
    const slopePct = ((curEma - prevEma) / prevEma) * 100;

    if (cur > curEma && slopePct > 0) {
        return { regime: REGIME.BULL, reason: `close>EMA200, slope=+${slopePct.toFixed(2)}%`, close: cur, ema: Math.round(curEma), slopePct };
    }
    if (cur < curEma && slopePct < 0) {
        return { regime: REGIME.BEAR, reason: `close<EMA200, slope=${slopePct.toFixed(2)}%`, close: cur, ema: Math.round(curEma), slopePct };
    }
    return { regime: REGIME.RANGE, reason: `مابین (close/EMA=${(cur / curEma).toFixed(3)})`, close: cur, ema: Math.round(curEma), slopePct };
}

function detectVolatilityState(dailyCandles, opts = {}) {
    const atrPeriod = opts.atrPeriod || 14;
    const lookback = opts.lookback || 60;
    if (!dailyCandles || dailyCandles.length < atrPeriod + lookback) {
        return { state: VOL_STATE.UNKNOWN };
    }
    const atr = computeATR(dailyCandles, atrPeriod);
    const recent = atr.slice(-lookback).filter(x => x !== null);
    if (recent.length < 20) return { state: VOL_STATE.UNKNOWN };

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
const STRATEGY_REGIME_MAP = {
    smc_unicorn:    { macro: ['bull', 'range'], vol: ['normal', 'high'] },
    ob_sweep:       { macro: ['bull', 'range', 'bear'], vol: ['normal', 'high'] },
    supply_demand:  { macro: ['bull', 'range'], vol: ['normal', 'low'] },
    ob_after_sweep: { macro: ['bull', 'range'], vol: ['normal', 'high'] },
    orb:            { macro: ['bull', 'range'], vol: ['normal', 'high'] },
    ensemble:       { macro: ['bull', 'range'], vol: ['normal', 'high'] },
    vwap_bounce:    { macro: ['bull', 'range'], vol: ['normal'] },
    supertrend:     { macro: ['bull', 'bear'], vol: ['normal', 'high'] },
    bb_squeeze:     { macro: ['range', 'bull'], vol: ['low', 'normal'] },
    donchian:       { macro: ['bull', 'bear'], vol: ['normal', 'high'] },
    keltner_pb:     { macro: ['bull'], vol: ['normal'] }
};

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
    isStrategyAllowed
};