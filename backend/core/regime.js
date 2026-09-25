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
    if (!dailyCandles || dailyCandles.length < 50) {
        return { regime: REGIME.UNKNOWN, reason: `دیتا کم (${dailyCandles?.length || 0} < 50)` };
    }

    // 🆕 EMA داینامیک
    let emaPeriod;
    if (dailyCandles.length >= 200) emaPeriod = 200;
    else if (dailyCandles.length >= 100) emaPeriod = 100;
    else if (dailyCandles.length >= 50) emaPeriod = 50;
    else return { regime: REGIME.UNKNOWN, reason: `دیتای ناکافی (${dailyCandles.length})` };

    // 🆕 slopeBars داینامیک — حداکثر 10، حداقل 3
    const slopeBars = Math.min(opts.slopeBars || 10, Math.max(3, Math.floor(dailyCandles.length / 8)));

    if (dailyCandles.length < emaPeriod + slopeBars) {
        return { regime: REGIME.UNKNOWN, reason: `نیاز به ${emaPeriod + slopeBars} کندل (${dailyCandles.length} موجود)` };
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

    let regime;
    let reason;
    if (cur > curEma && slopePct > 0) {
        regime = REGIME.BULL;
        reason = `close>EMA${emaPeriod}, slope=+${slopePct.toFixed(2)}%`;
    } else if (cur < curEma && slopePct < 0) {
        regime = REGIME.BEAR;
        reason = `close<EMA${emaPeriod}, slope=${slopePct.toFixed(2)}%`;
    } else {
        regime = REGIME.RANGE;
        reason = `مابین (close/EMA${emaPeriod}=${(cur / curEma).toFixed(3)})`;
    }

    return {
        regime, reason,
        close: cur,
        ema: Math.round(curEma),
        emaPeriod,
        slopePct
    };
}

function detectVolatilityState(dailyCandles, opts = {}) {
    const atrPeriod = opts.atrPeriod || 14;
    const lookback = opts.lookback || 30;   // 🆕 از 60 به 30

    if (!dailyCandles || dailyCandles.length < atrPeriod + lookback) {
        return { state: VOL_STATE.UNKNOWN };
    }
    const atr = computeATR(dailyCandles, atrPeriod);
    const recent = atr.slice(-lookback).filter(x => x !== null);
    if (recent.length < 15) return { state: VOL_STATE.UNKNOWN };   // 🆕 از 20 به 15

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