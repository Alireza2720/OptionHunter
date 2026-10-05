'use strict';
// ============================================================
// strategies-extra.js — استراتژی‌های تکمیلی
// ============================================================
// این فایل کاملاً جدا از strategies.js اصلی هست
// و به صورت اختیاری در strategies.js لود می‌شه.
//
// دو دسته استراتژی:
//   l2_*  → Long جدید (خرید کال)
//   put_* → Put (خرید پوت، در سیگنال نزولی)
// ============================================================

// --- توابع کمکی (کپی سبک از strategies.js، وابستگی نداره) ---
const _TF = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
});

function _tehranParts(t) {
    const m = {};
    _TF.formatToParts(new Date(t * 1000)).forEach(p => m[p.type] = p.value);
    return {
        year: +m.year, month: +m.month, day: +m.day,
        hour: (+m.hour) % 24, minute: +m.minute
    };
}

function _rsi(closes, period) {
    const out = new Array(closes.length).fill(null);
    if (closes.length <= period) return out;
    let g = 0, l = 0;
    for (let i = 1; i <= period; i++) {
        const d = closes[i] - closes[i-1];
        if (d >= 0) g += d; else l -= d;
    }
    let ag = g / period, al = l / period;
    out[period] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    for (let i = period + 1; i < closes.length; i++) {
        const d = closes[i] - closes[i-1];
        ag = (ag * (period - 1) + (d > 0 ? d : 0)) / period;
        al = (al * (period - 1) + (d < 0 ? -d : 0)) / period;
        out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    }
    return out;
}

function _ema(closes, period) {
    const out = new Array(closes.length).fill(null);
    if (closes.length < period) return out;
    let s = 0;
    for (let i = 0; i < period; i++) s += closes[i];
    out[period-1] = s / period;
    const k = 2 / (period + 1);
    for (let i = period; i < closes.length; i++) out[i] = closes[i] * k + out[i-1] * (1-k);
    return out;
}

function _atr(candles, period) {
    const out = new Array(candles.length).fill(null);
    if (candles.length <= period) return out;
    const tr = candles.map((c, i) => i === 0 ? c.high - c.low :
        Math.max(c.high - c.low, Math.abs(c.high - candles[i-1].close), Math.abs(c.low - candles[i-1].close)));
    let s = 0;
    for (let i = 1; i <= period; i++) s += tr[i];
    out[period] = s / period;
    for (let i = period + 1; i < candles.length; i++) out[i] = (out[i-1] * (period-1) + tr[i]) / period;
    return out;
}

function _bb(closes, period, k) {
    const up = new Array(closes.length).fill(null);
    const mid = new Array(closes.length).fill(null);
    const lo = new Array(closes.length).fill(null);
    for (let i = period - 1; i < closes.length; i++) {
        const slice = closes.slice(i - period + 1, i + 1);
        const m = slice.reduce((a,b) => a+b, 0) / period;
        const v = slice.reduce((a,b) => a + (b-m)**2, 0) / period;
        const sd = Math.sqrt(v);
        mid[i] = m;
        up[i] = m + k * sd;
        lo[i] = m - k * sd;
    }
    return { upper: up, middle: mid, lower: lo };
}

function _round(v) { return v === null || v === undefined ? null : Math.round(v * 100) / 100; }

// ============================================================
// HELPERS مشترک
// ============================================================
function _dayKey(t) {
    const x = _tehranParts(t);
    return x.year + '-' + x.month + '-' + x.day;
}

function _avgVolume(candles, i, lookback) {
    const s = Math.max(0, i - (lookback || 20));
    const slice = candles.slice(s, i);
    if (!slice.length) return 0;
    return slice.reduce((a, c) => a + (c.volume || 0), 0) / slice.length;
}

function _inEntryWindow(timeSec, w) {
    if (!w) return true;
    const t = _tehranParts(timeSec);
    const m = t.hour * 60 + t.minute;
    if (m === 0 || m === 210) return true;
    return m >= w.start && m <= w.end;
}

function _buildHtf(ctx, p) {
    const htf = (ctx && ctx.htfCandles) || [];
    if (!htf.length) return { forTime: () => null };
    const closes = htf.map(c => c.close);
    const ema = _ema(closes, p.htfEma || 20);
    const rsi = _rsi(closes, p.htfRsiPeriod || 14);
    const rows = htf.map((c, i) => {
        let trend = null;
        if (ema[i] !== null && i > 0 && ema[i-1] !== null && rsi[i] !== null) {
            if (c.close > ema[i] && ema[i] > ema[i-1] && rsi[i] > 50) trend = 'صعودی';
            else if (c.close < ema[i] && ema[i] < ema[i-1] && rsi[i] < 50) trend = 'نزولی';
            else trend = 'خنثی';
        }
        return { closeTime: c.time + 60, trend };
    });
    let ptr = 0;
    return {
        forTime(t) {
            while (ptr + 1 < rows.length && rows[ptr + 1].closeTime <= t) ptr++;
            return rows[ptr] && rows[ptr].closeTime <= t ? rows[ptr] : null;
        }
    };
}

// ============================================================
// 1) TTM Squeeze (l2_ttm_squeeze)
// ============================================================
const L2_TTM_DEFAULTS = {
    bbPeriod: 20, bbStd: 2.0, kcPeriod: 20, kcMult: 1.5,
    atrPeriod: 14, atrMult: 1.5, maxHoldBars: 25, cooldownBars: 2,
    tp1R: 1.5, tp2R: 3.0, htfEma: 20, htfRsiPeriod: 14,
    squeezeMinBars: 3
};

function runL2TTMSqueeze(candles, params, ctx) {
    const p = { ...L2_TTM_DEFAULTS, ...(params || {}) };
    const closes = candles.map(c => c.close);
    const bb = _bb(closes, p.bbPeriod, p.bbStd);
    const atr = _atr(candles, p.atrPeriod);
    const ema = _ema(closes, p.kcPeriod);
    const htf = _buildHtf(ctx, p);
    const signals = [], trades = [];
    let position = null, entry = null, cooldown = 0, lastTrend = null;
    let squeezeCount = 0;

    for (let i = 0; i < candles.length; i++) {
        const c = candles[i];
        const row = htf.forTime(c.time);
        if (row) lastTrend = row.trend;
        const ind = { atr: _round(atr[i]), stop: entry ? _round(entry.stop) : null, squeeze: squeezeCount };
        if (i < p.bbPeriod + 5 || bb.upper[i] === null || ema[i] === null || atr[i] === null) {
            signals.push({ time: c.time, indicators: ind, signalType: null, position, reason: null });
            continue;
        }
        const kcUp = ema[i] + p.kcMult * atr[i];
        const kcLo = ema[i] - p.kcMult * atr[i];
        const isSqueeze = bb.upper[i] < kcUp && bb.lower[i] > kcLo;
        if (isSqueeze) squeezeCount++; else squeezeCount = 0;

        let signalType = null, reason = null;
        if (position === 'LONG') {
            const bars = i - entry.idx, R = entry.risk;
            if (c.close < entry.stop) reason = 'حد ضرر';
            else if (!entry.tp1Hit && c.close >= entry.entry + R * p.tp1R) { entry.tp1Hit = true; entry.stop = entry.entry; }
            else if (entry.tp1Hit && c.close >= entry.entry + R * p.tp2R) reason = 'هدف دوم';
            else if (bars >= p.maxHoldBars) reason = 'سقف زمانی';
            if (reason) {
                position = null; signalType = 'EXIT_LONG';
                const tr = trades[trades.length - 1];
                if (tr) { tr.exitDate = c.time; tr.exitPrice = c.close; tr.pnlPct = (c.close / tr.entryPrice - 1) * 100; tr.exitReason = reason; }
                entry = null; cooldown = p.cooldownBars;
            }
        } else {
            if (cooldown > 0) cooldown--;
            else if (c.close > bb.upper[i] && squeezeCount >= p.squeezeMinBars && _inEntryWindow(c.time, ctx && ctx.entryWindow)) {
                const entryPrice = c.close;
                const stopPrice = bb.middle[i] - p.atrMult * atr[i];
                const risk = entryPrice - stopPrice;
                if (risk > 0) {
                    position = 'LONG'; signalType = 'BUY';
                    entry = { idx: i, price: entryPrice, stop: stopPrice, risk, entry: entryPrice, tp1Hit: false };
                    ind.stop = _round(stopPrice);
                    reason = 'TTM Squeeze (' + squeezeCount + 'b)';
                    trades.push({ type: 'خرید', entryDate: c.time, entryPrice, stop: stopPrice, risk, reason });
                }
            }
        }
        signals.push({ time: c.time, indicators: ind, signalType, position, reason });
    }
    return { signals, trades, htfTrend: lastTrend };
}

// ============================================================
// 2) Inside Bar Breakout (l2_inside_bar)
// ============================================================
const L2_IB_DEFAULTS = {
    atrPeriod: 14, atrMult: 1.5, maxHoldBars: 15, cooldownBars: 2,
    tp1R: 1.5, tp2R: 3.0, htfEma: 20, htfRsiPeriod: 14,
    requireHtfTrend: 0
};

function runL2InsideBar(candles, params, ctx) {
    const p = { ...L2_IB_DEFAULTS, ...(params || {}) };
    const atr = _atr(candles, p.atrPeriod);
    const htf = _buildHtf(ctx, p);
    const signals = [], trades = [];
    let position = null, entry = null, cooldown = 0, lastTrend = null;

    for (let i = 2; i < candles.length; i++) {
        const c = candles[i];
        const prev = candles[i-1]; // mother
        const row = htf.forTime(c.time);
        if (row) lastTrend = row.trend;
        const ind = { atr: _round(atr[i]), stop: entry ? _round(entry.stop) : null };
        if (atr[i] === null) { signals.push({ time: c.time, indicators: ind, signalType: null, position, reason: null }); continue; }

        let signalType = null, reason = null;
        if (position === 'LONG') {
            const bars = i - entry.idx, R = entry.risk;
            if (c.close < entry.stop) reason = 'حد ضرر';
            else if (!entry.tp1Hit && c.close >= entry.entry + R * p.tp1R) { entry.tp1Hit = true; entry.stop = entry.entry; }
            else if (entry.tp1Hit && c.close >= entry.entry + R * p.tp2R) reason = 'هدف دوم';
            else if (bars >= p.maxHoldBars) reason = 'سقف زمانی';
            if (reason) {
                position = null; signalType = 'EXIT_LONG';
                const tr = trades[trades.length - 1];
                if (tr) { tr.exitDate = c.time; tr.exitPrice = c.close; tr.pnlPct = (c.close / tr.entryPrice - 1) * 100; tr.exitReason = reason; }
                entry = null; cooldown = p.cooldownBars;
            }
        } else {
            if (cooldown > 0) cooldown--;
            else {
                // inside bar: current bar range inside previous bar
                const isInside = c.high <= prev.high && c.low >= prev.low;
                const htfOk = !p.requireHtfTrend || lastTrend === 'صعودی';
                if (isInside && htfOk && c.close > c.open && _inEntryWindow(c.time, ctx && ctx.entryWindow)) {
                    // trigger next bar (break of mother high)
                    if (i + 1 < candles.length && candles[i+1].close > prev.high) {
                        const nxt = candles[i+1];
                        const entryPrice = nxt.close;
                        const stopPrice = prev.low - p.atrMult * atr[i+1];
                        const risk = entryPrice - stopPrice;
                        if (risk > 0) {
                            position = 'LONG'; signalType = 'BUY';
                            entry = { idx: i+1, price: entryPrice, stop: stopPrice, risk, entry: entryPrice, tp1Hit: false };
                            ind.stop = _round(stopPrice);
                            reason = 'Inside Bar Breakout';
                            trades.push({ type: 'خرید', entryDate: nxt.time, entryPrice, stop: stopPrice, risk, reason });
                            signals.push({ time: c.time, indicators: ind, signalType: null, position: null, reason: null });
                            signals.push({ time: nxt.time, indicators: ind, signalType: 'BUY', position: 'LONG', reason });
                            i++; // skip next
                            continue;
                        }
                    }
                }
            }
        }
        signals.push({ time: c.time, indicators: ind, signalType, position, reason });
    }
    return { signals, trades, htfTrend: lastTrend };
}

// ============================================================
// 3) 3-Bar Momentum (l2_3bar_momo)
// ============================================================
const L2_3BM_DEFAULTS = {
    atrPeriod: 14, atrMult: 1.5, maxHoldBars: 12, cooldownBars: 2,
    tp1R: 1.5, tp2R: 3.0, htfEma: 20, htfRsiPeriod: 14,
    minBodyPct: 0.3
};

function runL23BarMomentum(candles, params, ctx) {
    const p = { ...L2_3BM_DEFAULTS, ...(params || {}) };
    const atr = _atr(candles, p.atrPeriod);
    const htf = _buildHtf(ctx, p);
    const signals = [], trades = [];
    let position = null, entry = null, cooldown = 0, lastTrend = null;

    for (let i = 3; i < candles.length; i++) {
        const c = candles[i];
        const row = htf.forTime(c.time);
        if (row) lastTrend = row.trend;
        const ind = { atr: _round(atr[i]), stop: entry ? _round(entry.stop) : null };
        if (atr[i] === null) { signals.push({ time: c.time, indicators: ind, signalType: null, position, reason: null }); continue; }

        let signalType = null, reason = null;
        if (position === 'LONG') {
            const bars = i - entry.idx, R = entry.risk;
            if (c.close < entry.stop) reason = 'حد ضرر';
            else if (!entry.tp1Hit && c.close >= entry.entry + R * p.tp1R) { entry.tp1Hit = true; entry.stop = entry.entry; }
            else if (entry.tp1Hit && c.close >= entry.entry + R * p.tp2R) reason = 'هدف دوم';
            else if (bars >= p.maxHoldBars) reason = 'سقف زمانی';
            if (reason) {
                position = null; signalType = 'EXIT_LONG';
                const tr = trades[trades.length - 1];
                if (tr) { tr.exitDate = c.time; tr.exitPrice = c.close; tr.pnlPct = (c.close / tr.entryPrice - 1) * 100; tr.exitReason = reason; }
                entry = null; cooldown = p.cooldownBars;
            }
        } else {
            if (cooldown > 0) cooldown--;
            else {
                const c1 = candles[i-2], c2 = candles[i-1];
                const bull1 = c1.close > c1.open;
                const bull2 = c2.close > c2.open;
                const bull3 = c.close > c.open;
                const bodyPct = c1.close > 0 ? Math.abs(c1.close - c1.open) / c1.close * 100 : 0;
                const checkBody = bodyPct >= p.minBodyPct;
                if (bull1 && bull2 && bull3 && checkBody && _inEntryWindow(c.time, ctx && ctx.entryWindow)) {
                    const entryPrice = c.close;
                    const stopPrice = c1.low - p.atrMult * atr[i];
                    const risk = entryPrice - stopPrice;
                    if (risk > 0) {
                        position = 'LONG'; signalType = 'BUY';
                        entry = { idx: i, price: entryPrice, stop: stopPrice, risk, entry: entryPrice, tp1Hit: false };
                        ind.stop = _round(stopPrice);
                        reason = '3-Bar Momentum';
                        trades.push({ type: 'خرید', entryDate: c.time, entryPrice, stop: stopPrice, risk, reason });
                    }
                }
            }
        }
        signals.push({ time: c.time, indicators: ind, signalType, position, reason });
    }
    return { signals, trades, htfTrend: lastTrend };
}

// ============================================================
// 4) HH-HL Structure Pullback (l2_hh_hl)
// ============================================================
const L2_HHHL_DEFAULTS = {
    emaFast: 20, emaSlow: 50, atrPeriod: 14, atrMult: 1.5,
    maxHoldBars: 20, cooldownBars: 2, tp1R: 1.5, tp2R: 3.0,
    htfEma: 20, htfRsiPeriod: 14, pullbackPct: 1.5
};

function runL2HHHL(candles, params, ctx) {
    const p = { ...L2_HHHL_DEFAULTS, ...(params || {}) };
    const closes = candles.map(c => c.close);
    const emaF = _ema(closes, p.emaFast);
    const emaS = _ema(closes, p.emaSlow);
    const atr = _atr(candles, p.atrPeriod);
    const htf = _buildHtf(ctx, p);
    const signals = [], trades = [];
    let position = null, entry = null, cooldown = 0, lastTrend = null;

    for (let i = 2; i < candles.length; i++) {
        const c = candles[i];
        const row = htf.forTime(c.time);
        if (row) lastTrend = row.trend;
        const ind = { atr: _round(atr[i]), stop: entry ? _round(entry.stop) : null };
        if (i < p.emaSlow + 5 || emaF[i] === null || emaS[i] === null || atr[i] === null) {
            signals.push({ time: c.time, indicators: ind, signalType: null, position, reason: null });
            continue;
        }

        const bullishStack = emaF[i] > emaS[i];
        let signalType = null, reason = null;
        if (position === 'LONG') {
            const bars = i - entry.idx, R = entry.risk;
            if (c.close < entry.stop) reason = 'حد ضرر';
            else if (!entry.tp1Hit && c.close >= entry.entry + R * p.tp1R) { entry.tp1Hit = true; entry.stop = entry.entry; }
            else if (entry.tp1Hit && c.close >= entry.entry + R * p.tp2R) reason = 'هدف دوم';
            else if (!bullishStack) reason = 'شکست ساختار';
            else if (bars >= p.maxHoldBars) reason = 'سقف زمانی';
            if (reason) {
                position = null; signalType = 'EXIT_LONG';
                const tr = trades[trades.length - 1];
                if (tr) { tr.exitDate = c.time; tr.exitPrice = c.close; tr.pnlPct = (c.close / tr.entryPrice - 1) * 100; tr.exitReason = reason; }
                entry = null; cooldown = p.cooldownBars;
            }
        } else {
            if (cooldown > 0) cooldown--;
            else {
                const nearEma = c.close <= emaF[i] * (1 + p.pullbackPct / 100) && c.close > emaS[i];
                const bullishBar = c.close > c.open;
                if (bullishStack && nearEma && bullishBar && _inEntryWindow(c.time, ctx && ctx.entryWindow)) {
                    const entryPrice = c.close;
                    const stopPrice = emaS[i] - p.atrMult * atr[i];
                    const risk = entryPrice - stopPrice;
                    if (risk > 0) {
                        position = 'LONG'; signalType = 'BUY';
                        entry = { idx: i, price: entryPrice, stop: stopPrice, risk, entry: entryPrice, tp1Hit: false };
                        ind.stop = _round(stopPrice);
                        reason = 'HH-HL Pullback to EMA' + p.emaFast;
                        trades.push({ type: 'خرید', entryDate: c.time, entryPrice, stop: stopPrice, risk, reason });
                    }
                }
            }
        }
        signals.push({ time: c.time, indicators: ind, signalType, position, reason });
    }
    return { signals, trades, htfTrend: lastTrend };
}

// ============================================================
// 5) Gap Up Hold (l2_gap_hold)
// ============================================================
const L2_GAPH_DEFAULTS = {
    atrPeriod: 14, atrMult: 1.5, maxHoldBars: 15, cooldownBars: 2,
    tp1R: 1.5, tp2R: 3.0, htfEma: 20, htfRsiPeriod: 14,
    minGapPct: 1.5, requireVolume: 1
};

function runL2GapUpHold(candles, params, ctx) {
    const p = { ...L2_GAPH_DEFAULTS, ...(params || {}) };
    const atr = _atr(candles, p.atrPeriod);
    const htf = _buildHtf(ctx, p);
    const signals = [], trades = [];
    let position = null, entry = null, cooldown = 0, lastTrend = null;
    const processed = new Set();

    for (let i = 1; i < candles.length; i++) {
        const c = candles[i];
        const row = htf.forTime(c.time);
        if (row) lastTrend = row.trend;
        const ind = { atr: _round(atr[i]), stop: entry ? _round(entry.stop) : null };
        if (atr[i] === null) { signals.push({ time: c.time, indicators: ind, signalType: null, position, reason: null }); continue; }

        let signalType = null, reason = null;
        if (position === 'LONG') {
            const bars = i - entry.idx, R = entry.risk;
            if (c.close < entry.stop) reason = 'حد ضرر';
            else if (!entry.tp1Hit && c.close >= entry.entry + R * p.tp1R) { entry.tp1Hit = true; entry.stop = entry.entry; }
            else if (entry.tp1Hit && c.close >= entry.entry + R * p.tp2R) reason = 'هدف دوم';
            else if (bars >= p.maxHoldBars) reason = 'سقف زمانی';
            if (reason) {
                position = null; signalType = 'EXIT_LONG';
                const tr = trades[trades.length - 1];
                if (tr) { tr.exitDate = c.time; tr.exitPrice = c.close; tr.pnlPct = (c.close / tr.entryPrice - 1) * 100; tr.exitReason = reason; }
                entry = null; cooldown = p.cooldownBars;
            }
        } else {
            if (cooldown > 0) cooldown--;
            else {
                // تشخیص gap در ابتدای روز
                const todayK = _dayKey(c.time);
                const prevK = _dayKey(candles[i-1].time);
                if (todayK !== prevK && !processed.has(todayK)) {
                    const prevClose = candles[i-1].close;
                    const gapPct = (c.open / prevClose - 1) * 100;
                    const volOk = !p.requireVolume || (c.volume || 0) > _avgVolume(candles, i, 20) * 1.2;
                    if (gapPct >= p.minGapPct && volOk) {
                        processed.add(todayK);
                        // منتظر تأیید شکست سقف کندل اول
                        if (c.close > c.open) {
                            const entryPrice = c.close;
                            const stopPrice = prevClose - p.atrMult * atr[i];
                            const risk = entryPrice - stopPrice;
                            if (risk > 0) {
                                position = 'LONG'; signalType = 'BUY';
                                entry = { idx: i, price: entryPrice, stop: stopPrice, risk, entry: entryPrice, tp1Hit: false };
                                ind.stop = _round(stopPrice);
                                reason = 'Gap Up Hold (+' + gapPct.toFixed(2) + '%)';
                                trades.push({ type: 'خرید', entryDate: c.time, entryPrice, stop: stopPrice, risk, reason });
                            }
                        }
                    }
                }
            }
        }
        signals.push({ time: c.time, indicators: ind, signalType, position, reason });
    }
    return { signals, trades, htfTrend: lastTrend };
}

// ============================================================
// ==================== PUT STRATEGIES ========================
// ============================================================
// این‌ها در واقع استراتژی‌های تحلیل سهم هستن که سیگنالِ
// «خرید پوت» می‌دن. تفاوت اصلی در direction: 'put' و اینکه
// entry/exit بر اساس انتظار نزولی چیده می‌شن.

// ============================================================
// P1) Breakdown of Support (put_breakdown)
// ============================================================
const PUT_BREAKDOWN_DEFAULTS = {
    swingLen: 15, atrPeriod: 14, atrMult: 1.3,
    maxHoldBars: 15, cooldownBars: 2, tp1R: 1.5, tp2R: 3.0,
    htfEma: 20, htfRsiPeriod: 14, requireVolume: 1
};

function runPutBreakdown(candles, params, ctx) {
    const p = { ...PUT_BREAKDOWN_DEFAULTS, ...(params || {}) };
    const atr = _atr(candles, p.atrPeriod);
    const htf = _buildHtf(ctx, p);
    const signals = [], trades = [];
    let position = null, entry = null, cooldown = 0, lastTrend = null;

    for (let i = p.swingLen + 1; i < candles.length; i++) {
        const c = candles[i];
        const row = htf.forTime(c.time);
        if (row) lastTrend = row.trend;
        const ind = { atr: _round(atr[i]), stop: entry ? _round(entry.stop) : null };
        if (atr[i] === null) { signals.push({ time: c.time, indicators: ind, signalType: null, position, reason: null }); continue; }

        let signalType = null, reason = null;
        if (position === 'LONG') {
            // برای پوت، "LONG" یعنی پوزیشن پوت باز هست
            const bars = i - entry.idx, R = entry.risk;
            if (c.close > entry.stop) reason = 'حد ضرر پوت'; // پوت برعکس سهم حرکت می‌کنه
            else if (!entry.tp1Hit && c.close <= entry.entry - R * p.tp1R) { entry.tp1Hit = true; entry.stop = entry.entry; }
            else if (entry.tp1Hit && c.close <= entry.entry - R * p.tp2R) reason = 'هدف دوم پوت';
            else if (bars >= p.maxHoldBars) reason = 'سقف زمانی';
            if (reason) {
                position = null; signalType = 'EXIT_LONG';
                const tr = trades[trades.length - 1];
                if (tr) {
                    tr.exitDate = c.time; tr.exitPrice = c.close;
                    // پوت: بازده معکوس حرکت سهم
                    tr.pnlPct = _simulatePutPnl(tr.entryPrice, c.close, (c.time - tr.entryDate) / 86400);
                    tr.exitReason = reason;
                }
                entry = null; cooldown = p.cooldownBars;
            }
        } else {
            if (cooldown > 0) cooldown--;
            else {
                // پیدا کردن پایین‌ترین low در swingLen گذشته
                let swingLow = Infinity;
                for (let k = i - p.swingLen; k < i; k++) if (candles[k].low < swingLow) swingLow = candles[k].low;
                const volOk = !p.requireVolume || (c.volume || 0) > _avgVolume(candles, i, 20) * 1.2;
                const broke = c.close < swingLow && c.close < c.open;
                if (broke && volOk && _inEntryWindow(c.time, ctx && ctx.entryWindow)) {
                    const entryPrice = c.close;
                    // استاپ = بالای آخرین سقف کوچک
                    let recentHigh = -Infinity;
                    for (let k = i - 5; k < i; k++) if (candles[k].high > recentHigh) recentHigh = candles[k].high;
                    const stopPrice = recentHigh + p.atrMult * atr[i];
                    const risk = stopPrice - entryPrice;
                    if (risk > 0) {
                        position = 'LONG'; signalType = 'BUY';
                        entry = { idx: i, price: entryPrice, stop: stopPrice, risk, entry: entryPrice, tp1Hit: false };
                        ind.stop = _round(stopPrice);
                        reason = 'Breakdown Put';
                        trades.push({ type: 'خرید پوت', entryDate: c.time, entryPrice, stop: stopPrice, risk, reason });
                    }
                }
            }
        }
        signals.push({ time: c.time, indicators: ind, signalType, position, reason });
    }
    return { signals, trades, htfTrend: lastTrend };
}

// ============================================================
// P2) Lower High Rejection (put_lower_high)
// ============================================================
const PUT_LH_DEFAULTS = {
    emaFast: 20, emaSlow: 50, atrPeriod: 14, atrMult: 1.3,
    maxHoldBars: 12, cooldownBars: 2, tp1R: 1.5, tp2R: 3.0,
    htfEma: 20, htfRsiPeriod: 14, rejectPct: 0.8
};

function runPutLowerHigh(candles, params, ctx) {
    const p = { ...PUT_LH_DEFAULTS, ...(params || {}) };
    const closes = candles.map(c => c.close);
    const emaF = _ema(closes, p.emaFast);
    const emaS = _ema(closes, p.emaSlow);
    const atr = _atr(candles, p.atrPeriod);
    const htf = _buildHtf(ctx, p);
    const signals = [], trades = [];
    let position = null, entry = null, cooldown = 0, lastTrend = null;

    for (let i = 2; i < candles.length; i++) {
        const c = candles[i];
        const row = htf.forTime(c.time);
        if (row) lastTrend = row.trend;
        const ind = { atr: _round(atr[i]), stop: entry ? _round(entry.stop) : null };
        if (i < p.emaSlow + 5 || emaF[i] === null || emaS[i] === null || atr[i] === null) {
            signals.push({ time: c.time, indicators: ind, signalType: null, position, reason: null });
            continue;
        }

        const bearishStack = emaF[i] < emaS[i];
        let signalType = null, reason = null;
        if (position === 'LONG') {
            const bars = i - entry.idx, R = entry.risk;
            if (c.close > entry.stop) reason = 'حد ضرر پوت';
            else if (!entry.tp1Hit && c.close <= entry.entry - R * p.tp1R) { entry.tp1Hit = true; entry.stop = entry.entry; }
            else if (entry.tp1Hit && c.close <= entry.entry - R * p.tp2R) reason = 'هدف دوم پوت';
            else if (!bearishStack) reason = 'ساختار نزولی شکست';
            else if (bars >= p.maxHoldBars) reason = 'سقف زمانی';
            if (reason) {
                position = null; signalType = 'EXIT_LONG';
                const tr = trades[trades.length - 1];
                if (tr) {
                    tr.exitDate = c.time; tr.exitPrice = c.close;
                    tr.pnlPct = _simulatePutPnl(tr.entryPrice, c.close, (c.time - tr.entryDate) / 86400);
                    tr.exitReason = reason;
                }
                entry = null; cooldown = p.cooldownBars;
            }
        } else {
            if (cooldown > 0) cooldown--;
            else {
                // رد شدن از EMA20: سایه بالا از EMAF عبور ولی کندل زیرش بست
                const touchedEma = c.high >= emaF[i] * (1 - p.rejectPct / 100) && c.close < emaF[i];
                const bearish = c.close < c.open;
                if (bearishStack && touchedEma && bearish && _inEntryWindow(c.time, ctx && ctx.entryWindow)) {
                    const entryPrice = c.close;
                    const stopPrice = c.high + p.atrMult * atr[i];
                    const risk = stopPrice - entryPrice;
                    if (risk > 0) {
                        position = 'LONG'; signalType = 'BUY';
                        entry = { idx: i, price: entryPrice, stop: stopPrice, risk, entry: entryPrice, tp1Hit: false };
                        ind.stop = _round(stopPrice);
                        reason = 'Lower High Rejection at EMA' + p.emaFast;
                        trades.push({ type: 'خرید پوت', entryDate: c.time, entryPrice, stop: stopPrice, risk, reason });
                    }
                }
            }
        }
        signals.push({ time: c.time, indicators: ind, signalType, position, reason });
    }
    return { signals, trades, htfTrend: lastTrend };
}

// ============================================================
// P3) RSI Overbought (put_rsi_ob)
// ============================================================
const PUT_RSIOB_DEFAULTS = {
    rsiPeriod: 3, rsiThresh: 85, atrPeriod: 14, atrMult: 1.3,
    maxHoldBars: 10, cooldownBars: 2, tp1R: 1.5, tp2R: 2.5,
    htfEma: 20, htfRsiPeriod: 14
};

function runPutRSIOB(candles, params, ctx) {
    const p = { ...PUT_RSIOB_DEFAULTS, ...(params || {}) };
    const closes = candles.map(c => c.close);
    const rsi = _rsi(closes, p.rsiPeriod);
    const atr = _atr(candles, p.atrPeriod);
    const htf = _buildHtf(ctx, p);
    const signals = [], trades = [];
    let position = null, entry = null, cooldown = 0, lastTrend = null;

    for (let i = p.rsiPeriod + 2; i < candles.length; i++) {
        const c = candles[i];
        const row = htf.forTime(c.time);
        if (row) lastTrend = row.trend;
        const ind = { atr: _round(atr[i]), stop: entry ? _round(entry.stop) : null, rsi: rsi[i] !== null ? _round(rsi[i]) : null };
        if (rsi[i] === null || atr[i] === null) { signals.push({ time: c.time, indicators: ind, signalType: null, position, reason: null }); continue; }

        let signalType = null, reason = null;
        if (position === 'LONG') {
            const bars = i - entry.idx, R = entry.risk;
            if (c.close > entry.stop) reason = 'حد ضرر پوت';
            else if (!entry.tp1Hit && c.close <= entry.entry - R * p.tp1R) { entry.tp1Hit = true; entry.stop = entry.entry; }
            else if (entry.tp1Hit && c.close <= entry.entry - R * p.tp2R) reason = 'هدف دوم پوت';
            else if (rsi[i] < 50) reason = 'RSI اشباع فروش';
            else if (bars >= p.maxHoldBars) reason = 'سقف زمانی';
            if (reason) {
                position = null; signalType = 'EXIT_LONG';
                const tr = trades[trades.length - 1];
                if (tr) {
                    tr.exitDate = c.time; tr.exitPrice = c.close;
                    tr.pnlPct = _simulatePutPnl(tr.entryPrice, c.close, (c.time - tr.entryDate) / 86400);
                    tr.exitReason = reason;
                }
                entry = null; cooldown = p.cooldownBars;
            }
        } else {
            if (cooldown > 0) cooldown--;
            else {
                const ob = rsi[i] >= p.rsiThresh;
                const reject = c.close < c.open; // کندل نزولی
                if (ob && reject && _inEntryWindow(c.time, ctx && ctx.entryWindow)) {
                    const entryPrice = c.close;
                    const stopPrice = c.high + p.atrMult * atr[i];
                    const risk = stopPrice - entryPrice;
                    if (risk > 0) {
                        position = 'LONG'; signalType = 'BUY';
                        entry = { idx: i, price: entryPrice, stop: stopPrice, risk, entry: entryPrice, tp1Hit: false };
                        ind.stop = _round(stopPrice);
                        reason = 'RSI(' + p.rsiPeriod + ') Overbought=' + rsi[i].toFixed(0);
                        trades.push({ type: 'خرید پوت', entryDate: c.time, entryPrice, stop: stopPrice, risk, reason });
                    }
                }
            }
        }
        signals.push({ time: c.time, indicators: ind, signalType, position, reason });
    }
    return { signals, trades, htfTrend: lastTrend };
}

// ============================================================
// P4) Bear Flag (put_bear_flag)
// ============================================================
const PUT_BEARFLAG_DEFAULTS = {
    dropPct: 4.0, flagMaxBars: 10, atrPeriod: 14, atrMult: 1.3,
    maxHoldBars: 12, cooldownBars: 2, tp1R: 1.5, tp2R: 2.5,
    htfEma: 20, htfRsiPeriod: 14
};

function runPutBearFlag(candles, params, ctx) {
    const p = { ...PUT_BEARFLAG_DEFAULTS, ...(params || {}) };
    const atr = _atr(candles, p.atrPeriod);
    const htf = _buildHtf(ctx, p);
    const signals = [], trades = [];
    let position = null, entry = null, cooldown = 0, lastTrend = null;

    for (let i = p.flagMaxBars + 5; i < candles.length; i++) {
        const c = candles[i];
        const row = htf.forTime(c.time);
        if (row) lastTrend = row.trend;
        const ind = { atr: _round(atr[i]), stop: entry ? _round(entry.stop) : null };
        if (atr[i] === null) { signals.push({ time: c.time, indicators: ind, signalType: null, position, reason: null }); continue; }

        let signalType = null, reason = null;
        if (position === 'LONG') {
            const bars = i - entry.idx, R = entry.risk;
            if (c.close > entry.stop) reason = 'حد ضرر پوت';
            else if (!entry.tp1Hit && c.close <= entry.entry - R * p.tp1R) { entry.tp1Hit = true; entry.stop = entry.entry; }
            else if (entry.tp1Hit && c.close <= entry.entry - R * p.tp2R) reason = 'هدف دوم پوت';
            else if (bars >= p.maxHoldBars) reason = 'سقف زمانی';
            if (reason) {
                position = null; signalType = 'EXIT_LONG';
                const tr = trades[trades.length - 1];
                if (tr) {
                    tr.exitDate = c.time; tr.exitPrice = c.close;
                    tr.pnlPct = _simulatePutPnl(tr.entryPrice, c.close, (c.time - tr.entryDate) / 86400);
                    tr.exitReason = reason;
                }
                entry = null; cooldown = p.cooldownBars;
            }
        } else {
            if (cooldown > 0) cooldown--;
            else {
                // پیدا کردن ریزش شدید در 15 کندل گذشته
                let dropStart = -1;
                for (let k = i - 15; k < i - p.flagMaxBars; k++) {
                    if (k < 0) continue;
                    const drop = (candles[k].close - candles[k+3]?.close) / candles[k].close * 100;
                    if (drop >= p.dropPct) { dropStart = k; break; }
                }
                if (dropStart > 0) {
                    // چک flag: کندل‌های اخیر range کوچک + شیب کم
                    let flagHigh = -Infinity, flagLow = Infinity;
                    for (let k = i - p.flagMaxBars; k < i; k++) {
                        if (candles[k].high > flagHigh) flagHigh = candles[k].high;
                        if (candles[k].low < flagLow) flagLow = candles[k].low;
                    }
                    const flagRangePct = (flagHigh - flagLow) / flagLow * 100;
                    const brokeBelow = c.close < flagLow;
                    if (flagRangePct < 3 && brokeBelow && _inEntryWindow(c.time, ctx && ctx.entryWindow)) {
                        const entryPrice = c.close;
                        const stopPrice = flagHigh + p.atrMult * atr[i];
                        const risk = stopPrice - entryPrice;
                        if (risk > 0) {
                            position = 'LONG'; signalType = 'BUY';
                            entry = { idx: i, price: entryPrice, stop: stopPrice, risk, entry: entryPrice, tp1Hit: false };
                            ind.stop = _round(stopPrice);
                            reason = 'Bear Flag Breakdown';
                            trades.push({ type: 'خرید پوت', entryDate: c.time, entryPrice, stop: stopPrice, risk, reason });
                        }
                    }
                }
            }
        }
        signals.push({ time: c.time, indicators: ind, signalType, position, reason });
    }
    return { signals, trades, htfTrend: lastTrend };
}

// ============================================================
// P5) Volume Spike Down (put_vol_spike)
// ============================================================
const PUT_VOLSPIKE_DEFAULTS = {
    volMult: 2.5, atrPeriod: 14, atrMult: 1.3,
    maxHoldBars: 10, cooldownBars: 2, tp1R: 1.5, tp2R: 2.5,
    htfEma: 20, htfRsiPeriod: 14, minBodyPct: 1.0
};

function runPutVolSpike(candles, params, ctx) {
    const p = { ...PUT_VOLSPIKE_DEFAULTS, ...(params || {}) };
    const atr = _atr(candles, p.atrPeriod);
    const htf = _buildHtf(ctx, p);
    const signals = [], trades = [];
    let position = null, entry = null, cooldown = 0, lastTrend = null;

    for (let i = p.atrPeriod + 5; i < candles.length; i++) {
        const c = candles[i];
        const row = htf.forTime(c.time);
        if (row) lastTrend = row.trend;
        const ind = { atr: _round(atr[i]), stop: entry ? _round(entry.stop) : null };
        if (atr[i] === null) { signals.push({ time: c.time, indicators: ind, signalType: null, position, reason: null }); continue; }

        let signalType = null, reason = null;
        if (position === 'LONG') {
            const bars = i - entry.idx, R = entry.risk;
            if (c.close > entry.stop) reason = 'حد ضرر پوت';
            else if (!entry.tp1Hit && c.close <= entry.entry - R * p.tp1R) { entry.tp1Hit = true; entry.stop = entry.entry; }
            else if (entry.tp1Hit && c.close <= entry.entry - R * p.tp2R) reason = 'هدف دوم پوت';
            else if (bars >= p.maxHoldBars) reason = 'سقف زمانی';
            if (reason) {
                position = null; signalType = 'EXIT_LONG';
                const tr = trades[trades.length - 1];
                if (tr) {
                    tr.exitDate = c.time; tr.exitPrice = c.close;
                    tr.pnlPct = _simulatePutPnl(tr.entryPrice, c.close, (c.time - tr.entryDate) / 86400);
                    tr.exitReason = reason;
                }
                entry = null; cooldown = p.cooldownBars;
            }
        } else {
            if (cooldown > 0) cooldown--;
            else {
                const avgVol = _avgVolume(candles, i, 20);
                const volSpike = avgVol > 0 && (c.volume || 0) >= avgVol * p.volMult;
                const bodyPct = c.open > 0 ? Math.abs(c.close - c.open) / c.open * 100 : 0;
                const bearish = c.close < c.open && bodyPct >= p.minBodyPct;
                if (volSpike && bearish && _inEntryWindow(c.time, ctx && ctx.entryWindow)) {
                    const entryPrice = c.close;
                    const stopPrice = c.high + p.atrMult * atr[i];
                    const risk = stopPrice - entryPrice;
                    if (risk > 0) {
                        position = 'LONG'; signalType = 'BUY';
                        entry = { idx: i, price: entryPrice, stop: stopPrice, risk, entry: entryPrice, tp1Hit: false };
                        ind.stop = _round(stopPrice);
                        reason = 'Volume Spike Down (' + ((c.volume || 0) / avgVol).toFixed(1) + 'x)';
                        trades.push({ type: 'خرید پوت', entryDate: c.time, entryPrice, stop: stopPrice, risk, reason });
                    }
                }
            }
        }
        signals.push({ time: c.time, indicators: ind, signalType, position, reason });
    }
    return { signals, trades, htfTrend: lastTrend };
}

// ============================================================
// EXPORTS
// ============================================================
const EXTRA_STRATEGIES = {
    // --- Long ---
    l2_ttm_squeeze: {
        id: 'l2_ttm_squeeze', name: 'TTM Squeeze', nameFa: 'فشردگی TTM',
        direction: 'long', category: 'volatility',
        regime: { macro: ['bull', 'range'], vol: ['low', 'normal'] },
        defaultTimeframe: '30m', htfTimeframe: '1d',
        defaultParams: L2_TTM_DEFAULTS, indicators: ['atr', 'squeeze'],
        run: runL2TTMSqueeze
    },
    l2_inside_bar: {
        id: 'l2_inside_bar', name: 'Inside Bar Breakout', nameFa: 'شکست اینساید بار',
        direction: 'long', category: 'breakout',
        regime: { macro: ['bull', 'range'], vol: ['normal'] },
        defaultTimeframe: '30m', htfTimeframe: '1d',
        defaultParams: L2_IB_DEFAULTS, indicators: ['atr'],
        run: runL2InsideBar
    },
    l2_3bar_momo: {
        id: 'l2_3bar_momo', name: '3-Bar Momentum', nameFa: 'مومنتوم ۳ کندل',
        direction: 'long', category: 'momentum',
        regime: { macro: ['bull'], vol: ['normal', 'high'] },
        defaultTimeframe: '30m', htfTimeframe: '1d',
        defaultParams: L2_3BM_DEFAULTS, indicators: ['atr'],
        run: runL23BarMomentum
    },
    l2_hh_hl: {
        id: 'l2_hh_hl', name: 'HH-HL Pullback', nameFa: 'پولبک HH-HL',
        direction: 'long', category: 'momentum',
        regime: { macro: ['bull'], vol: ['normal', 'low'] },
        defaultTimeframe: '30m', htfTimeframe: '1d',
        defaultParams: L2_HHHL_DEFAULTS, indicators: ['atr'],
        run: runL2HHHL
    },
    l2_gap_hold: {
        id: 'l2_gap_hold', name: 'Gap Up Hold', nameFa: 'گپ مثبت پایدار',
        direction: 'long', category: 'momentum',
        regime: { macro: ['bull', 'range'], vol: ['normal', 'high'] },
        defaultTimeframe: '15m', htfTimeframe: '1d',
        defaultParams: L2_GAPH_DEFAULTS, indicators: ['atr', 'volume'],
        run: runL2GapUpHold
    },
    // --- Put ---
    put_breakdown: {
        id: 'put_breakdown', name: 'Breakdown Put', nameFa: 'شکست حمایت (پوت)',
        direction: 'put', category: 'breakout',
        regime: { macro: ['bear', 'range'], vol: ['normal', 'high'] },
        defaultTimeframe: '30m', htfTimeframe: '1d',
        defaultParams: PUT_BREAKDOWN_DEFAULTS, indicators: ['atr', 'volume'],
        run: runPutBreakdown
    },
    put_lower_high: {
        id: 'put_lower_high', name: 'Lower High Put', nameFa: 'سقف پایین‌تر (پوت)',
        direction: 'put', category: 'momentum',
        regime: { macro: ['bear', 'range'], vol: ['normal'] },
        defaultTimeframe: '30m', htfTimeframe: '1d',
        defaultParams: PUT_LH_DEFAULTS, indicators: ['atr'],
        run: runPutLowerHigh
    },
    put_rsi_ob: {
        id: 'put_rsi_ob', name: 'RSI Overbought Put', nameFa: 'RSI اشباع خرید (پوت)',
        direction: 'put', category: 'meanrev',
        regime: { macro: ['range', 'bear'], vol: ['normal'] },
        defaultTimeframe: '30m', htfTimeframe: '1d',
        defaultParams: PUT_RSIOB_DEFAULTS, indicators: ['rsi', 'atr'],
        run: runPutRSIOB
    },
    put_bear_flag: {
        id: 'put_bear_flag', name: 'Bear Flag Put', nameFa: 'پرچم نزولی (پوت)',
        direction: 'put', category: 'breakout',
        regime: { macro: ['bear'], vol: ['normal', 'high'] },
        defaultTimeframe: '30m', htfTimeframe: '1d',
        defaultParams: PUT_BEARFLAG_DEFAULTS, indicators: ['atr'],
        run: runPutBearFlag
    },
    put_vol_spike: {
        id: 'put_vol_spike', name: 'Volume Spike Down Put', nameFa: 'انفجار حجم نزولی (پوت)',
        direction: 'put', category: 'momentum',
        regime: { macro: ['bear', 'range'], vol: ['high'] },
        defaultTimeframe: '30m', htfTimeframe: '1d',
        defaultParams: PUT_VOLSPIKE_DEFAULTS, indicators: ['atr', 'volume'],
        run: runPutVolSpike
    }
};

// helper: required candles برای هر استراتژی
function extraGetRequiredCandles(id, params) {
    const base = {
        l2_ttm_squeeze: 30,
        l2_inside_bar: 20,
        l2_3bar_momo: 20,
        l2_hh_hl: 60,
        l2_gap_hold: 25,
        put_breakdown: 30,
        put_lower_high: 60,
        put_rsi_ob: 20,
        put_bear_flag: 30,
        put_vol_spike: 30
    };
    return base[id] || null;
}

function extraGetRequiredHtfCandles(id, params) {
    return 22; // kافیه برای HTF EMA20 + RSI14
}

module.exports = {
    STRATEGIES: EXTRA_STRATEGIES,
    getRequiredCandles: extraGetRequiredCandles,
    getRequiredHtfCandles: extraGetRequiredHtfCandles
};