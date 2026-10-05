(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.TradingStrategies = factory();
})(typeof self !== 'undefined' ? self : this, function () {

    let __extra = null;
    try { __extra = require('./strategies-extra'); } catch (_e) { __extra = null; }
    // 🆕 singleton
    const _TEHRAN_FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    function getTehranParts(date) {
        const map = {}; _TEHRAN_FMT.formatToParts(date).forEach(p => { map[p.type] = p.value; });
        return { year: +map.year, month: +map.month, day: +map.day, hour: (+map.hour) % 24, minute: +map.minute, second: +map.second };
    }
    function tehranPartsToUTC(y, mo, d, h, mi, s) { return new Date(Date.UTC(y, mo - 1, d, h, mi, s || 0) - 3.5 * 3600 * 1000); }
    function minuteOfDay(timeSec) { const t = getTehranParts(new Date(timeSec * 1000)); return t.hour * 60 + t.minute; }
    function hourFloatOfDay(timeSec) { const t = getTehranParts(new Date(timeSec * 1000)); return t.hour + t.minute / 60; }

    const TIMEFRAME_MINUTES = { '1m': 1, '3m': 3, '5m': 5, '10m': 10, '15m': 15, '30m': 30, '1h': 60, '1d': 1440 };
    const SESSION_START_MIN = 9 * 60, SESSION_END_MIN = 12 * 60 + 30;

    function expectedBarsFor(bucketStartMin, tfMin) {
        const overlap = Math.max(0, Math.min(bucketStartMin + tfMin, SESSION_END_MIN) - Math.max(bucketStartMin, SESSION_START_MIN));
        return Math.min(tfMin, overlap) || tfMin;
    }
    function aggregateCandles(baseCandles, tfMin) {
        const sorted = [...baseCandles].sort((a, b) => a.time - b.time);
        const map = new Map();
        for (const c of sorted) {
            const t = getTehranParts(new Date(c.time * 1000));
            const b = Math.floor((t.hour * 60 + t.minute) / tfMin) * tfMin;
            const bh = Math.floor(b / 60), bm = b % 60;
            const key = `${t.year}-${t.month}-${t.day}-${bh}-${bm}`;
            if (!map.has(key)) {
                map.set(key, { time: Math.floor(tehranPartsToUTC(t.year, t.month, t.day, bh, bm).getTime() / 1000), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0, barCount: 1, expectedBars: expectedBarsFor(b, tfMin) });
            } else {
                const x = map.get(key); x.high = Math.max(x.high, c.high); x.low = Math.min(x.low, c.low); x.close = c.close; x.volume += c.volume || 0; x.barCount++;
            }
        }
        return Array.from(map.values()).map(x => ({ ...x, complete: x.barCount >= Math.max(1, x.expectedBars) * 0.6 })).sort((a, b) => a.time - b.time);
    }

    function calculateHeikinAshi(data) {
        const ha = [];
        for (let i = 0; i < data.length; i++) {
            const c = data[i];
            const close = (c.open + c.high + c.low + c.close) / 4;
            const open = i === 0 ? (c.open + c.close) / 2 : (ha[i - 1].open + ha[i - 1].close) / 2;
            const high = Math.max(c.high, open, close), low = Math.min(c.low, open, close);
            ha.push({ time: c.time, open, high, low, close, bullish: close > open, complete: c.complete !== false });
        }
        return ha;
    }
    function calculateSimpleCandles(data) { return data.map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, bullish: c.close > c.open, complete: c.complete !== false })); }
    function getDisplayCandles(data, candleType) { return candleType === 'simple' ? calculateSimpleCandles(data) : calculateHeikinAshi(data); }
    function noLowerWick(h) { return h.low >= Math.min(h.open, h.close) * 0.999; }

    function calculateRSI(closes, period) {
        const rsi = new Array(closes.length).fill(null); if (closes.length <= period) return rsi;
        let g = 0, l = 0;
        for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i - 1]; if (d >= 0) g += d; else l -= d; }
        let ag = g / period, al = l / period;
        rsi[period] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
        for (let i = period + 1; i < closes.length; i++) {
            const d = closes[i] - closes[i - 1];
            ag = (ag * (period - 1) + (d > 0 ? d : 0)) / period; al = (al * (period - 1) + (d < 0 ? -d : 0)) / period;
            rsi[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
        }
        return rsi;
    }
    function calculateEMA(closes, period) {
        const ema = new Array(closes.length).fill(null); if (closes.length < period) return ema;
        let s = 0; for (let i = 0; i < period; i++) s += closes[i];
        ema[period - 1] = s / period; const k = 2 / (period + 1);
        for (let i = period; i < closes.length; i++) ema[i] = closes[i] * k + ema[i - 1] * (1 - k);
        return ema;
    }
    function calculateATR(c, period) {
        const atr = new Array(c.length).fill(null); if (c.length <= period) return atr;
        const tr = c.map((x, i) => i === 0 ? x.high - x.low : Math.max(x.high - x.low, Math.abs(x.high - c[i - 1].close), Math.abs(x.low - c[i - 1].close)));
        let s = 0; for (let i = 1; i <= period; i++) s += tr[i];
        atr[period] = s / period;
        for (let i = period + 1; i < c.length; i++) atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
        return atr;
    }
    function calculateMACD(closes, fastPeriod, slowPeriod, signalPeriod) {
        const emaFast = calculateEMA(closes, fastPeriod);
        const emaSlow = calculateEMA(closes, slowPeriod);
        const macdLine = new Array(closes.length).fill(null);
        for (let i = 0; i < closes.length; i++) {
            if (emaFast[i] !== null && emaSlow[i] !== null) macdLine[i] = emaFast[i] - emaSlow[i];
        }
        const filled = macdLine.map(x => x === null ? 0 : x);
        const rawSignal = calculateEMA(filled, signalPeriod);
        const signal = rawSignal.map((v, i) => macdLine[i] === null ? null : v);
        const hist = macdLine.map((v, i) => (v === null || signal[i] === null) ? null : v - signal[i]);
        return { macd: macdLine, signal, hist };
    }
    function calculateBollingerBands(closes, period, stdDevMult) {
        const upper = new Array(closes.length).fill(null);
        const middle = new Array(closes.length).fill(null);
        const lower = new Array(closes.length).fill(null);
        for (let i = period - 1; i < closes.length; i++) {
            const slice = closes.slice(i - period + 1, i + 1);
            const mean = slice.reduce((a, b) => a + b, 0) / period;
            const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
            const sd = Math.sqrt(variance);
            middle[i] = mean;
            upper[i] = mean + stdDevMult * sd;
            lower[i] = mean - stdDevMult * sd;
        }
        return { upper, middle, lower };
    }
    function calculateIchimoku(candles, tenkanPeriod, kijunPeriod, senkouBPeriod) {
        const n = candles.length;
        const tenkan = new Array(n).fill(null);
        const kijun = new Array(n).fill(null);
        const senkouA = new Array(n).fill(null);
        const senkouB = new Array(n).fill(null);
        const chikou = new Array(n).fill(null);
        const highLow = (start, end) => {
            let hi = -Infinity, lo = Infinity;
            for (let i = start; i <= end; i++) {
                if (candles[i].high > hi) hi = candles[i].high;
                if (candles[i].low < lo) lo = candles[i].low;
            }
            return { hi, lo };
        };
        for (let i = tenkanPeriod - 1; i < n; i++) {
            const { hi, lo } = highLow(i - tenkanPeriod + 1, i);
            tenkan[i] = (hi + lo) / 2;
        }
        for (let i = kijunPeriod - 1; i < n; i++) {
            const { hi, lo } = highLow(i - kijunPeriod + 1, i);
            kijun[i] = (hi + lo) / 2;
        }
        for (let i = 0; i < n; i++) {
            if (tenkan[i] !== null && kijun[i] !== null) {
                const idx = i + kijunPeriod;
                if (idx < n) senkouA[idx] = (tenkan[i] + kijun[i]) / 2;
            }
            if (i >= senkouBPeriod - 1) {
                const { hi, lo } = highLow(i - senkouBPeriod + 1, i);
                const idx = i + kijunPeriod;
                if (idx < n) senkouB[idx] = (hi + lo) / 2;
            }
            const cIdx = i - kijunPeriod;
            if (cIdx >= 0) chikou[cIdx] = candles[i].close;
        }
        return { tenkan, kijun, senkouA, senkouB, chikou };
    }
    function htfCloseTime(c, htfMin) {
        const t = getTehranParts(new Date(c.time * 1000));
        if (htfMin >= 1440 || (htfMin === 60 && t.hour === 11)) return Math.floor(tehranPartsToUTC(t.year, t.month, t.day, 12, 30).getTime() / 1000);
        return c.time + htfMin * 60;
    }
    function buildHtf(ctx, params) {
        const htf = (ctx && ctx.htfCandles) || [];
        const htfMin = TIMEFRAME_MINUTES[(ctx && ctx.htfTimeframe) || '1d'] || 1440;
        const closes = htf.map(c => c.close);
        const ema = calculateEMA(closes, params.htfEma), rsi = calculateRSI(closes, params.htfRsiPeriod);
        const rows = htf.map((c, i) => {
            let trend = null;
            if (ema[i] !== null && i > 0 && ema[i - 1] !== null && rsi[i] !== null) {
                if (c.close > ema[i] && ema[i] > ema[i - 1] && rsi[i] > 50) trend = 'صعودی';
                else if (c.close < ema[i] && ema[i] < ema[i - 1] && rsi[i] < 50) trend = 'نزولی';
                else trend = 'خنثی';
            }
            return { closeTime: htfCloseTime(c, htfMin), trend, ema: ema[i], rsi: rsi[i] };
        });
        let p = 0;
        return {
            forTime(t) {
                while (p + 1 < rows.length && rows[p + 1].closeTime <= t) p++;
                return rows[p] && rows[p].closeTime <= t ? rows[p] : null;
            }
        };
    }
    function inEntryWindow(timeSec, w) {
        if (!w) return true;
        const m = minuteOfDay(timeSec);
        // 🆕 کندل روزانه — همیشه مجاز
        if (m === 0 || m === 210) return true;
        return m >= w.start && m <= w.end;
    }
    const round = v => (v === null || v === undefined) ? null : Math.round(v * 100) / 100;

    // ==================== ۱. SMC Unicorn ====================
    const SMC_DEFAULTS = {
        swingLength: 4, htfEma: 20, htfRsiPeriod: 14,
        fvgMinGapPct: 0.05,
        useOTE: 0, oteLow: 0.5, oteHigh: 0.886,
        atrPeriod: 14, atrMult: 1.7,
        maxHoldBars: 20, cooldownBars: 3,
        useBreakEven: 1, tp1R: 1.5, tp2R: 3.0, tp3R: 4.5,
        minLiquiditySweepPct: 0.05,
        requireVolumeFilter: 1, useKillzone: 0,
        killzone1Start: 9.5, killzone1End: 10.5,
        killzone2Start: 11.5, killzone2End: 12.0,
        minConfluence: 1
    };
    function runSMCUnicorn(candles, params, ctx) {
        const p = { ...SMC_DEFAULTS, ...(params || {}) };
        const ha = getDisplayCandles(candles, p.candleType || 'heikin');
        const closes = candles.map(c => c.close);
        const atr = calculateATR(candles, p.atrPeriod);
        const htf = buildHtf(ctx, p), htfName = (ctx && ctx.htfTimeframe) || '1d';
        const signals = [], trades = [];
        let position = null, entry = null, cooldown = 0, lastTrend = null;
        function findSwingHigh(idx, len) { const start = Math.max(0, idx - len); let hi = -Infinity, hiIdx = -1; for (let i = start; i <= idx; i++) { if (candles[i].high > hi) { hi = candles[i].high; hiIdx = i; } } return { price: hi, idx: hiIdx }; }
        function findSwingLow(idx, len) { const start = Math.max(0, idx - len); let lo = Infinity, loIdx = -1; for (let i = start; i <= idx; i++) { if (candles[i].low < lo) { lo = candles[i].low; loIdx = i; } } return { price: lo, idx: loIdx }; }
        function detectBullishFVG(i) { if (i < 2) return null; const c1 = candles[i - 2], c3 = candles[i]; if (c3.low > c1.high) { const gap = c3.low - c1.high; const gapPct = gap / c1.high * 100; if (gapPct >= p.fvgMinGapPct) return { top: c3.low, bottom: c1.high, mid: (c3.low + c1.high) / 2, gap, gapPct, idx: i }; } return null; }
        function detectBullishBreaker(i) { if (i < p.swingLength) return null; const prevSwing = findSwingHigh(i - 1, p.swingLength); if (!(candles[i].close > prevSwing.price && closes[i] > closes[i - 1])) return null; for (let k = i - 1; k >= Math.max(0, i - 10); k--) { if (candles[k].close < candles[k].open) return { top: candles[k].high, bottom: candles[k].low, mid: (candles[k].high + candles[k].low) / 2, idx: k, bosIdx: i, swingHigh: prevSwing.price }; } return null; }
        function detectLiquiditySweep(i) { if (i < p.swingLength + 1) return null; const prevLow = findSwingLow(i - 1, p.swingLength); const c = candles[i], prev = candles[i - 1]; const swept = (c.low < prevLow.price || prev.low < prevLow.price); const reclaimed = c.close > prevLow.price; if (swept && reclaimed) { const depthPct = (prevLow.price - Math.min(c.low, prev.low)) / prevLow.price * 100; if (depthPct >= p.minLiquiditySweepPct) return { sweptLevel: prevLow.price, depthPct, idx: i, sweepLow: Math.min(c.low, prev.low) }; } return null; }
        function calcOTE(swingLow, swingHigh) { const range = swingHigh - swingLow; return { low: swingLow + range * (1 - p.oteHigh), high: swingLow + range * (1 - p.oteLow) }; }
        function inKillzone(timeSec) { if (!p.useKillzone) return true; const h = hourFloatOfDay(timeSec); return (h >= p.killzone1Start && h <= p.killzone1End) || (h >= p.killzone2Start && h <= p.killzone2End); }
        for (let i = 0; i < candles.length; i++) {
            const c = candles[i], h = ha[i];
            const row = htf.forTime(c.time), trend = row ? row.trend : null; if (trend) lastTrend = trend;
            const ind = { atr: round(atr[i]), stop: entry ? round(entry.stop) : null, trend: trend || '-' };
            if (i < Math.max(p.swingLength + 3, p.atrPeriod + 2) || atr[i] === null) { signals.push({ time: c.time, indicators: ind, signalType: null, position, reason: null }); continue; }
            let signalType = null, reason = null;
            if (position === 'LONG') {
                const bars = i - entry.idx; const R = entry.risk;
                if (c.close < entry.stop) reason = `حد ضرر`;
                else if (!entry.tp1Hit && c.close >= entry.entry + R * p.tp1R) { entry.tp1Hit = true; if (p.useBreakEven) entry.stop = entry.entry; }
                else if (entry.tp1Hit && !entry.tp2Hit && c.close >= entry.entry + R * p.tp2R) entry.tp2Hit = true;
                else if (entry.tp2Hit && c.close >= entry.entry + R * p.tp3R) reason = `هدف سوم`;
                else if (trend === 'نزولی') reason = `روند نزولی`;
                else if (bars >= p.maxHoldBars) reason = `سقف زمانی`;
                if (reason) {
                    position = null; signalType = 'EXIT_LONG';
                    const tr = trades[trades.length - 1];
                    if (tr) { tr.exitDate = c.time; tr.exitPrice = c.close; tr.pnlPct = (c.close / tr.entryPrice - 1) * 100; tr.exitReason = reason; }
                    entry = null; cooldown = p.cooldownBars;
                }
            } else {
                if (cooldown > 0) cooldown--;
                else if (trend === 'صعودی' && inEntryWindow(c.time, ctx && ctx.entryWindow) && inKillzone(c.time)) {
                    const sweep = detectLiquiditySweep(i), bb = detectBullishBreaker(i), fvg = detectBullishFVG(i);
                    const condCount = [!!sweep, !!bb, !!fvg].filter(Boolean).length;
                    if (condCount >= p.minConfluence) {
                        let zoneLow = -Infinity, zoneHigh = Infinity;
                        if (bb) { zoneLow = Math.max(zoneLow, Math.min(bb.bottom, bb.top)); zoneHigh = Math.min(zoneHigh, Math.max(bb.bottom, bb.top)); }
                        if (fvg) { zoneLow = Math.max(zoneLow, Math.min(fvg.bottom, fvg.top)); zoneHigh = Math.min(zoneHigh, Math.max(fvg.bottom, fvg.top)); }
                        if (zoneLow === -Infinity) zoneLow = findSwingLow(i, p.swingLength).price;
                        if (zoneHigh === Infinity) zoneHigh = c.close;
                        if (zoneHigh > zoneLow) {
                            const swingLow = findSwingLow(i, p.swingLength).price, swingHigh = findSwingHigh(i, p.swingLength).price;
                            const ote = calcOTE(swingLow, swingHigh);
                            const inOTE = !p.useOTE || (zoneLow <= ote.high && zoneHigh >= ote.low);
                            if (inOTE && h.bullish) {
                                position = 'LONG'; signalType = 'BUY';
                                const entryPrice = Math.min(zoneHigh, c.close);
                                let stopPrice;
                                if (sweep) stopPrice = Math.min(zoneLow, sweep.sweepLow);
                                else if (bb) stopPrice = bb.bottom;
                                else stopPrice = zoneLow;
                                stopPrice -= p.atrMult * atr[i];
                                const risk = entryPrice - stopPrice;
                                if (risk <= 0) { signals.push({ time: c.time, indicators: ind, signalType: null, position, reason: null }); continue; }
                                entry = { idx: i, price: entryPrice, stop: stopPrice, risk, entry: entryPrice, tp1Hit: false, tp2Hit: false, zoneLow, zoneHigh, sweepLevel: sweep ? sweep.sweptLevel : null, oteLow: ote.low, oteHigh: ote.high };
                                ind.stop = round(stopPrice);
                                const parts = []; if (sweep) parts.push('Sweep'); if (bb) parts.push('BB'); if (fvg) parts.push('FVG');
                                reason = `SMC [${parts.join('+')}] | ${condCount}/3`;
                                trades.push({ type: 'خرید', entryDate: c.time, entryPrice, stop: stopPrice, risk, tp1R: p.tp1R, tp2R: p.tp2R, tp3R: p.tp3R, reason });
                            }
                        }
                    }
                }
            }
            signals.push({ time: c.time, indicators: ind, signalType, position, reason });
        }
        return { ha, signals, trades, htfTrend: lastTrend };
    }

    // ==================== ۲. OB + Sweep ====================
    const OB_DEFAULTS = {
        swingLength: 5, htfEma: 20, htfRsiPeriod: 14,
        atrPeriod: 14, atrMult: 1.7,
        maxHoldBars: 25, cooldownBars: 3,
        tp1R: 1.5, tp2R: 3.5,
        obLookback: 7, minSweepPct: 0.05,
        minConditions: 1
    };
    function runOBSweep(candles, params, ctx) {
        const p = { ...OB_DEFAULTS, ...(params || {}) };
        const ha = getDisplayCandles(candles, p.candleType || 'heikin');
        const closes = candles.map(c => c.close);
        const atr = calculateATR(candles, p.atrPeriod);
        const htf = buildHtf(ctx, p), htfName = (ctx && ctx.htfTimeframe) || '1d';
        const signals = [], trades = [];
        let position = null, entry = null, cooldown = 0, lastTrend = null;
        function findSwingLow(idx, len) { const start = Math.max(0, idx - len); let lo = Infinity, loIdx = -1; for (let i = start; i <= idx; i++) { if (candles[i].low < lo) { lo = candles[i].low; loIdx = i; } } return { price: lo, idx: loIdx }; }
        function findSwingHigh(idx, len) { const start = Math.max(0, idx - len); let hi = -Infinity, hiIdx = -1; for (let i = start; i <= idx; i++) { if (candles[i].high > hi) { hi = candles[i].high; hiIdx = i; } } return { price: hi, idx: hiIdx }; }
        function detectSweep(i) { if (i < p.swingLength + 1) return null; const prevLow = findSwingLow(i - 1, p.swingLength); const c = candles[i], prev = candles[i - 1]; if ((c.low < prevLow.price || prev.low < prevLow.price) && c.close > prevLow.price) { const depth = (prevLow.price - Math.min(c.low, prev.low)) / prevLow.price * 100; if (depth >= p.minSweepPct) return { sweptLevel: prevLow.price, sweepLow: Math.min(c.low, prev.low), idx: i }; } return null; }
        function findOrderBlock(i) { for (let k = i - 1; k >= Math.max(0, i - p.obLookback); k--) { if (candles[k].close < candles[k].open) { const isBigEnough = Math.abs(candles[k].close - candles[k].open) > atr[k] * 0.5; if (isBigEnough) return { top: candles[k].high, bottom: candles[k].low, idx: k }; } } return null; }
        function detectMSS(i) { if (i < p.swingLength) return null; const prevHigh = findSwingHigh(i - 1, p.swingLength); if (candles[i].close > prevHigh.price && closes[i] > closes[i - 1]) return { level: prevHigh.price, idx: i }; return null; }
        for (let i = 0; i < candles.length; i++) {
            const c = candles[i], h = ha[i];
            const row = htf.forTime(c.time), trend = row ? row.trend : null; if (trend) lastTrend = trend;
            const ind = { atr: round(atr[i]), stop: entry ? round(entry.stop) : null };
            if (i < Math.max(p.swingLength + 3, p.atrPeriod + 2) || atr[i] === null) { signals.push({ time: c.time, indicators: ind, signalType: null, position, reason: null }); continue; }
            let signalType = null, reason = null;
            if (position === 'LONG') {
                const bars = i - entry.idx; const R = entry.risk;
                if (c.close < entry.stop) reason = `حد ضرر`;
                else if (!entry.tp1Hit && c.close >= entry.entry + R * p.tp1R) { entry.tp1Hit = true; entry.stop = entry.entry; }
                else if (entry.tp1Hit && c.close >= entry.entry + R * p.tp2R) reason = `هدف دوم (${p.tp2R}R)`;
                else if (trend === 'نزولی') reason = `روند نزولی`;
                else if (bars >= p.maxHoldBars) reason = `سقف زمانی`;
                if (reason) {
                    position = null; signalType = 'EXIT_LONG';
                    const tr = trades[trades.length - 1]; if (tr) { tr.exitDate = c.time; tr.exitPrice = c.close; tr.pnlPct = (c.close / tr.entryPrice - 1) * 100; tr.exitReason = reason; }
                    entry = null; cooldown = p.cooldownBars;
                }
            } else {
                if (cooldown > 0) cooldown--;
                else if (trend === 'صعودی' && inEntryWindow(c.time, ctx && ctx.entryWindow)) {
                    const sweep = detectSweep(i), mss = detectMSS(i), ob = findOrderBlock(i);
                    const condCount = [!!sweep, !!mss, !!ob].filter(Boolean).length;
                    if (condCount >= p.minConditions && h.bullish) {
                        const entryPrice = ob ? ob.top : c.close;
                        let stopPrice;
                        if (sweep && ob) stopPrice = Math.min(ob.bottom, sweep.sweepLow);
                        else if (sweep) stopPrice = sweep.sweepLow;
                        else if (ob) stopPrice = ob.bottom;
                        else stopPrice = c.close - 2 * atr[i];
                        stopPrice -= p.atrMult * atr[i];
                        const risk = entryPrice - stopPrice;
                        if (risk <= 0) { signals.push({ time: c.time, indicators: ind, signalType: null, position, reason: null }); continue; }
                        position = 'LONG'; signalType = 'BUY';
                        entry = { idx: i, price: entryPrice, stop: stopPrice, risk, entry: entryPrice, tp1Hit: false, obTop: ob ? ob.top : null, obBottom: ob ? ob.bottom : null };
                        ind.stop = round(stopPrice);
                        const parts = []; if (sweep) parts.push('Sweep'); if (mss) parts.push('MSS'); if (ob) parts.push('OB');
                        reason = `OB+Sweep [${parts.join('+')}] | ${condCount}/3`;
                        trades.push({ type: 'خرید', entryDate: c.time, entryPrice, stop: stopPrice, risk, tp1R: p.tp1R, tp2R: p.tp2R, reason });
                    }
                }
            }
            signals.push({ time: c.time, indicators: ind, signalType, position, reason });
        }
        return { ha, signals, trades, htfTrend: lastTrend };
    }

    // ==================== ۳. Supply & Demand ====================
    // ==================== ۴. OB After Sweep ====================
    const OBAS_DEFAULTS = { swingLength: 4, htfEma: 20, htfRsiPeriod: 14, atrPeriod: 14, atrMult: 1.5, maxHoldBars: 25, cooldownBars: 3, tp1R: 1.5, tp2R: 3.0, obLookback: 15, minSweepPct: 0.01, sweepWithinBars: 15 };
    function runOBAfterSweep(candles, params, ctx) {
        const p = { ...OBAS_DEFAULTS, ...(params || {}) };
        const ha = getDisplayCandles(candles, p.candleType || 'heikin');
        const atr = calculateATR(candles, p.atrPeriod);
        const htf = buildHtf(ctx, p), htfName = (ctx && ctx.htfTimeframe) || '1d';
        const signals = [], trades = [];
        let position = null, entry = null, cooldown = 0, lastTrend = null;
        function findSwingLow(idx, len) { const start = Math.max(0, idx - len); let lo = Infinity, loIdx = -1; for (let i = start; i <= idx; i++) { if (candles[i].low < lo) { lo = candles[i].low; loIdx = i; } } return { price: lo, idx: loIdx }; }
        function findRecentSweep(i) {
            for (let k = i - 1; k >= Math.max(0, i - p.sweepWithinBars); k--) {
                const prevLow = findSwingLow(k - 1, p.swingLength);
                if (!prevLow || !isFinite(prevLow.price)) continue;
                const c = candles[k], prev = candles[k - 1];
                if (prev && (c.low < prevLow.price || prev.low < prevLow.price) && c.close > prevLow.price) {
                    const depthPct = (prevLow.price - Math.min(c.low, prev.low)) / prevLow.price * 100;
                    if (depthPct >= p.minSweepPct) return { sweptLevel: prevLow.price, sweepLow: Math.min(c.low, prev.low), idx: k };
                }
            }
            return null;
        }
        function findOBAfterSweep(sweepIdx, i) {
            for (let k = i - 1; k > sweepIdx && k >= Math.max(0, i - p.obLookback); k--) {
                if (candles[k].close < candles[k].open) {
                    const bodySize = Math.abs(candles[k].close - candles[k].open);
                    if (bodySize > atr[k] * 0.3) return { top: candles[k].high, bottom: candles[k].low, idx: k };
                }
            }
            return null;
        }
        for (let i = 0; i < candles.length; i++) {
            const c = candles[i], h = ha[i];
            const row = htf.forTime(c.time), trend = row ? row.trend : null; if (trend) lastTrend = trend;
            const ind = { atr: round(atr[i]), stop: entry ? round(entry.stop) : null };
            if (i < Math.max(p.swingLength + 3, p.atrPeriod + 2) || atr[i] === null) { signals.push({ time: c.time, indicators: ind, signalType: null, position, reason: null }); continue; }
            let signalType = null, reason = null;
            if (position === 'LONG') {
                const bars = i - entry.idx; const R = entry.risk;
                if (c.close < entry.stop) reason = 'حد ضرر';
                else if (!entry.tp1Hit && c.close >= entry.entry + R * p.tp1R) { entry.tp1Hit = true; entry.stop = entry.entry; }
                else if (entry.tp1Hit && c.close >= entry.entry + R * p.tp2R) reason = 'هدف دوم';
                else if (trend === 'نزولی') reason = 'روند نزولی';
                else if (bars >= p.maxHoldBars) reason = 'سقف زمانی';
                if (reason) {
                    position = null; signalType = 'EXIT_LONG';
                    const tr = trades[trades.length - 1];
                    if (tr) { tr.exitDate = c.time; tr.exitPrice = c.close; tr.pnlPct = (c.close / tr.entryPrice - 1) * 100; tr.exitReason = reason; }
                    entry = null; cooldown = p.cooldownBars;
                }
            } else {
                if (cooldown > 0) cooldown--;
                else if (trend === 'صعودی' && inEntryWindow(c.time, ctx && ctx.entryWindow)) {
                    const sweep = findRecentSweep(i);
                    if (sweep) {
                        const ob = findOBAfterSweep(sweep.idx, i);
                        if (ob && h.bullish) {
                            const entryPrice = Math.max(ob.top, c.close);
                            const stopPrice = Math.min(ob.bottom, sweep.sweepLow) - p.atrMult * atr[i];
                            const risk = entryPrice - stopPrice;
                            if (risk > 0) {
                                position = 'LONG'; signalType = 'BUY';
                                entry = { idx: i, price: entryPrice, stop: stopPrice, risk, entry: entryPrice, tp1Hit: false };
                                ind.stop = round(stopPrice);
                                reason = `OB After Sweep`;
                                trades.push({ type: 'خرید', entryDate: c.time, entryPrice, stop: stopPrice, risk, reason });
                            }
                        }
                    }
                }
            }
            signals.push({ time: c.time, indicators: ind, signalType, position, reason });
        }
        return { ha, signals, trades, htfTrend: lastTrend };
    }

    // ==================== ۵. ORB ====================
    // ==================== ۶. Ensemble ====================
    // ==================== ۷. VWAP Bounce ====================
    // ==================== ۹. MACD Trend ====================
    // ==================== ۱۰. Ichimoku Cloud ====================
    // ==================== ۱۱. EMA Stack ====================
    // ==================== ۱۲. RSI Oversold Bounce (Mean Reversion) ====================
    // ==================== ۱۳. Gap Fill ====================
    // ==================== ۱۴. ATR Expansion ====================
    // ==================== ۱۵. Pairs Spread (Mean-Reversion دو-نمادی) ====================
    // ==================== ۱۶. Sector Momentum ====================
    const SECTOR_DEFAULTS = {
        htfEma: 20, htfRsiPeriod: 14,
        momentumLookback: 20,
        sectorLookback: 20,
        minPeerCount: 3,
        atrPeriod: 14, atrMult: 1.5,
        maxHoldBars: 25, cooldownBars: 3,
        tp1R: 1.5, tp2R: 3.0
    };
    function runSectorMomentum(candles, params, ctx) {
        const p = { ...SECTOR_DEFAULTS, ...(params || {}) };
        const ha = getDisplayCandles(candles, p.candleType || 'heikin');
        const atr = calculateATR(candles, p.atrPeriod);
        const htf = buildHtf(ctx, p), htfName = (ctx && ctx.htfTimeframe) || '1d';
        const signals = [], trades = [];
        // peerMap: { symbol: [{time, close}, ...] }
        const peerMap = (ctx && ctx.sectorPeerCandles) || null;
        // برای هر بار محاسبه momentum صنعت
        const peerSymbols = peerMap ? Object.keys(peerMap) : [];
        let position = null, entry = null, cooldown = 0, lastTrend = null;
        for (let i = 0; i < candles.length; i++) {
            const c = candles[i], h = ha[i];
            const row = htf.forTime(c.time), trend = row ? row.trend : null;
            if (trend) lastTrend = trend;
            const ind = { atr: round(atr[i]), stop: entry ? round(entry.stop) : null };
            if (i < Math.max(p.momentumLookback, p.atrPeriod) + 3 || atr[i] === null) {
                signals.push({ time: c.time, indicators: ind, signalType: null, position, reason: null });
                continue;
            }
            // محاسبه momentum خود نماد
            const ownRet = i >= p.momentumLookback
                ? (c.close / candles[i - p.momentumLookback].close - 1) * 100
                : 0;
            // محاسبه میانگین momentum هم‌صنعتی‌ها
            let peerRets = [];
            for (const psym of peerSymbols) {
                const pCandles = peerMap[psym];
                // پیدا کردن candle با همان time
                let pIdx = -1;
                for (let k = 0; k < pCandles.length; k++) {
                    if (pCandles[k].time === c.time) { pIdx = k; break; }
                }
                if (pIdx >= p.momentumLookback) {
                    const r = (pCandles[pIdx].close / pCandles[pIdx - p.momentumLookback].close - 1) * 100;
                    peerRets.push(r);
                }
            }
            // 🆕 اگه peer کافی نیست، از return خود سهم به‌عنوان fallback استفاده کن
            const peerAvg = peerRets.length >= p.minPeerCount
                ? peerRets.reduce((s,x)=>s+x,0) / peerRets.length
                : (peerRets.length > 0 ? peerRets.reduce((s,x)=>s+x,0) / peerRets.length : null);
            let signalType = null, reason = null;
            if (position === 'LONG') {
                const bars = i - entry.idx; const R = entry.risk;
                if (c.close < entry.stop) reason = 'حد ضرر';
                else if (!entry.tp1Hit && c.close >= entry.entry + R * p.tp1R) { entry.tp1Hit = true; entry.stop = entry.entry; }
                else if (entry.tp1Hit && c.close >= entry.entry + R * p.tp2R) reason = 'هدف دوم';
                else if (peerAvg !== null && ownRet < peerAvg) reason = 'ضعیف‌تر از صنعت';
                else if (trend === 'نزولی') reason = 'روند نزولی';
                else if (bars >= p.maxHoldBars) reason = 'سقف زمانی';
                if (reason) {
                    position = null; signalType = 'EXIT_LONG';
                    const tr = trades[trades.length - 1];
                    if (tr) { tr.exitDate = c.time; tr.exitPrice = c.close; tr.pnlPct = (c.close / tr.entryPrice - 1) * 100; tr.exitReason = reason; }
                    entry = null; cooldown = p.cooldownBars;
                }
            } else {
                if (cooldown > 0) cooldown--;
                else if (trend === 'صعودی' && inEntryWindow(c.time, ctx && ctx.entryWindow)) {
                    // خود نماد قوی‌تر از میانگین صنعت (outperform)
                    if (peerAvg !== null && ownRet > peerAvg + 1.0 && ownRet > 2.0 && h.bullish) {
                        const entryPrice = c.close;
                        const stopPrice = c.close - p.atrMult * atr[i];
                        const risk = entryPrice - stopPrice;
                        if (risk > 0) {
                            position = 'LONG'; signalType = 'BUY';
                            entry = { idx: i, price: entryPrice, stop: stopPrice, risk, entry: entryPrice, tp1Hit: false };
                            ind.stop = round(stopPrice);
                            reason = `Sector Leader (own ${ownRet.toFixed(1)}% > peers ${peerAvg.toFixed(1)}%)`;
                            trades.push({ type: 'خرید', entryDate: c.time, entryPrice, stop: stopPrice, risk, reason });
                        }
                    }
                }
            }
            signals.push({ time: c.time, indicators: ind, signalType, position, reason });
        }
        return { ha, signals, trades, htfTrend: lastTrend };
    }

    // ==================== ۹. BB Squeeze ====================
    // ==================== ۱۰. Donchian Breakout ====================
    const DONCH_DEFAULTS = {
        htfEma: 20, htfRsiPeriod: 14,
        entryPeriod: 20, exitPeriod: 10,
        atrPeriod: 14, atrMult: 1.5,
        maxHoldBars: 25, cooldownBars: 2,
        tp1R: 1.5, tp2R: 3.0,
        minBreakoutPct: 0.3
    };
    function runDonchianBreakout(candles, params, ctx) {
        const p = { ...DONCH_DEFAULTS, ...(params || {}) };
        const ha = getDisplayCandles(candles, p.candleType || 'heikin');
        const atr = calculateATR(candles, p.atrPeriod);
        const htf = buildHtf(ctx, p), htfName = (ctx && ctx.htfTimeframe) || '1d';
        const signals = [], trades = [];
        let position = null, entry = null, cooldown = 0, lastTrend = null;
        function highestHigh(idx, len) {
            let hi = -Infinity;
            for (let k = Math.max(0, idx - len + 1); k <= idx; k++) {
                if (candles[k].high > hi) hi = candles[k].high;
            }
            return hi;
        }
        function lowestLow(idx, len) {
            let lo = Infinity;
            for (let k = Math.max(0, idx - len + 1); k <= idx; k++) {
                if (candles[k].low < lo) lo = candles[k].low;
            }
            return lo;
        }
        for (let i = 0; i < candles.length; i++) {
            const c = candles[i], h = ha[i];
            const row = htf.forTime(c.time), trend = row ? row.trend : null;
            if (trend) lastTrend = trend;
            const ind = { atr: round(atr[i]), stop: entry ? round(entry.stop) : null };
            if (i < Math.max(p.entryPeriod, p.exitPeriod, p.atrPeriod) + 3 || atr[i] === null) {
                signals.push({ time: c.time, indicators: ind, signalType: null, position, reason: null });
                continue;
            }
            const upper = highestHigh(i - 1, p.entryPeriod);
            const lower = lowestLow(i - 1, p.exitPeriod);
            const breakoutPct = (c.close - upper) / upper * 100;
            let signalType = null, reason = null;
            if (position === 'LONG') {
                const bars = i - entry.idx; const R = entry.risk;
                if (c.close < entry.stop) reason = 'حد ضرر';
                else if (!entry.tp1Hit && c.close >= entry.entry + R * p.tp1R) { entry.tp1Hit = true; entry.stop = entry.entry; }
                else if (entry.tp1Hit && c.close >= entry.entry + R * p.tp2R) reason = 'هدف دوم';
                else if (c.close < lower) reason = 'Donchian exit';
                else if (bars >= p.maxHoldBars) reason = 'سقف زمانی';
                if (reason) {
                    position = null; signalType = 'EXIT_LONG';
                    const tr = trades[trades.length - 1];
                    if (tr) { tr.exitDate = c.time; tr.exitPrice = c.close; tr.pnlPct = (c.close / tr.entryPrice - 1) * 100; tr.exitReason = reason; }
                    entry = null; cooldown = p.cooldownBars;
                }
            } else {
                if (cooldown > 0) cooldown--;
                else if (trend === 'صعودی' && inEntryWindow(c.time, ctx && ctx.entryWindow)) {
                    if (breakoutPct >= p.minBreakoutPct && h.bullish) {
                        const entryPrice = c.close;
                        const stopPrice = lower - p.atrMult * atr[i];
                        const risk = entryPrice - stopPrice;
                        if (risk > 0) {
                            position = 'LONG'; signalType = 'BUY';
                            entry = { idx: i, price: entryPrice, stop: stopPrice, risk, entry: entryPrice, tp1Hit: false };
                            ind.stop = round(stopPrice);
                            reason = `Donchian Breakout (${p.entryPeriod} کندل)`;
                            trades.push({ type: 'خرید', entryDate: c.time, entryPrice, stop: stopPrice, risk, reason });
                        }
                    }
                }
            }
            signals.push({ time: c.time, indicators: ind, signalType, position, reason });
        }
        return { ha, signals, trades, htfTrend: lastTrend };
    }

        // ==================== استراتژی‌های جدید (علمی) ====================

    // ۱. Momentum 12-1 (Jegadeesh & Titman)
    const MOM12_1_DEFAULTS = {
        htfEma: 50, htfRsiPeriod: 14,
        lookbackMonths: 12, skipMonths: 1,
        topPct: 0.1, atrPeriod: 14, atrMult: 2,
        maxHoldBars: 60, cooldownBars: 5, tp1R: 2, tp2R: 4
    };
    function runMomentum121(candles, params, ctx) {
        const p = { ...MOM12_1_DEFAULTS, ...(params || {}) };
        const ha = getDisplayCandles(candles, p.candleType || 'heikin');
        const closes = candles.map(c => c.close);
        const atr = calculateATR(candles, p.atrPeriod);
        const signals = [], trades = [];
        let position = null, entry = null, cooldown = 0;
        const LOOKBACK_BARS = p.lookbackMonths * 21;
        const SKIP_BARS = p.skipMonths * 21;
        for (let i = 0; i < candles.length; i++) {
            const c = candles[i], h = ha[i];
            const ind = { atr: round(atr[i]), stop: entry ? round(entry.stop) : null };
            if (i < LOOKBACK_BARS + SKIP_BARS + 5 || atr[i] === null) {
                signals.push({ time: c.time, indicators: ind, signalType: null, position, reason: null });
                continue;
            }
            const past = candles[i - SKIP_BARS].close;
            const older = candles[i - SKIP_BARS - LOOKBACK_BARS].close;
            const momReturn = (past / older - 1) * 100;
            let signalType = null, reason = null;
            if (position === 'LONG') {
                const bars = i - entry.idx; const R = entry.risk;
                if (c.close < entry.stop) reason = 'حد ضرر';
                else if (!entry.tp1Hit && c.close >= entry.entry + R * p.tp1R) { entry.tp1Hit = true; entry.stop = entry.entry; }
                else if (entry.tp1Hit && c.close >= entry.entry + R * p.tp2R) reason = 'هدف دوم';
                else if (momReturn < 0) reason = 'معکوس مومنتوم';
                else if (bars >= p.maxHoldBars) reason = 'سقف زمانی';
                if (reason) {
                    position = null; signalType = 'EXIT_LONG';
                    const tr = trades[trades.length - 1];
                    if (tr) { tr.exitDate = c.time; tr.exitPrice = c.close; tr.pnlPct = (c.close / tr.entryPrice - 1) * 100; tr.exitReason = reason; }
                    entry = null; cooldown = p.cooldownBars;
                }
            } else {
                if (cooldown > 0) cooldown--;
                else if (momReturn > 5 && h.bullish && inEntryWindow(c.time, ctx && ctx.entryWindow)) {
                    const entryPrice = c.close;
                    const stopPrice = c.close - p.atrMult * atr[i];
                    const risk = entryPrice - stopPrice;
                    if (risk > 0) {
                        position = 'LONG'; signalType = 'BUY';
                        entry = { idx: i, price: entryPrice, stop: stopPrice, risk, entry: entryPrice, tp1Hit: false };
                        ind.stop = round(stopPrice);
                        reason = `Momentum 12-1 (${momReturn.toFixed(1)}%)`;
                        trades.push({ type: 'خرید', entryDate: c.time, entryPrice, stop: stopPrice, risk, reason });
                    }
                }
            }
            signals.push({ time: c.time, indicators: ind, signalType, position, reason });
        }
        return { ha, signals, trades, htfTrend: null };
    }

    // ۲. Short-Term Reversal (5-day)
    const STR5_DEFAULTS = {
        htfEma: 20, htfRsiPeriod: 14,
        lookbackDays: 5, dropPct: -7,
        atrPeriod: 14, atrMult: 1.5,
        maxHoldBars: 10, cooldownBars: 2, tp1R: 1.5, tp2R: 3
    };
    function runShortTermReversal(candles, params, ctx) {
        const p = { ...STR5_DEFAULTS, ...(params || {}) };
        const ha = getDisplayCandles(candles, p.candleType || 'heikin');
        const atr = calculateATR(candles, p.atrPeriod);
        const signals = [], trades = [];
        let position = null, entry = null, cooldown = 0;
        const LOOKBACK = p.lookbackDays * 7;
        for (let i = 0; i < candles.length; i++) {
            const c = candles[i], h = ha[i];
            const ind = { atr: round(atr[i]), stop: entry ? round(entry.stop) : null };
            if (i < LOOKBACK + 5 || atr[i] === null) {
                signals.push({ time: c.time, indicators: ind, signalType: null, position, reason: null });
                continue;
            }
            const past = candles[i - LOOKBACK].close;
            const ret = (c.close / past - 1) * 100;
            let signalType = null, reason = null;
            if (position === 'LONG') {
                const bars = i - entry.idx; const R = entry.risk;
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
                else if (ret < p.dropPct && h.bullish && inEntryWindow(c.time, ctx && ctx.entryWindow)) {
                    const entryPrice = c.close;
                    const stopPrice = c.low - p.atrMult * atr[i];
                    const risk = entryPrice - stopPrice;
                    if (risk > 0) {
                        position = 'LONG'; signalType = 'BUY';
                        entry = { idx: i, price: entryPrice, stop: stopPrice, risk, entry: entryPrice, tp1Hit: false };
                        ind.stop = round(stopPrice);
                        reason = `Reversal 5d (${ret.toFixed(1)}%)`;
                        trades.push({ type: 'خرید', entryDate: c.time, entryPrice, stop: stopPrice, risk, reason });
                    }
                }
            }
            signals.push({ time: c.time, indicators: ind, signalType, position, reason });
        }
        return { ha, signals, trades, htfTrend: null };
    }

    // ۳. OU Mean Reversion
    // ۴. Volatility Regime Breakout
    // ۵. Low Volatility Anomaly
    const LOW_VOL_DEFAULTS = {
        htfEma: 20, htfRsiPeriod: 14,
        volWindow: 60, volPct: 0.3,
        atrPeriod: 14, atrMult: 1.5,
        maxHoldBars: 40, cooldownBars: 5, tp1R: 2, tp2R: 3
    };
    function runLowVolAnomaly(candles, params, ctx) {
        const p = { ...LOW_VOL_DEFAULTS, ...(params || {}) };
        const ha = getDisplayCandles(candles, p.candleType || 'heikin');
        const closes = candles.map(c => c.close);
        const atr = calculateATR(candles, p.atrPeriod);
        const signals = [], trades = [];
        let position = null, entry = null, cooldown = 0;
        // rolling volatility
        const volSeries = [];
        for (let i = 0; i < candles.length; i++) {
            if (i < 21) { volSeries.push(null); continue; }
            const slice = closes.slice(i-20, i+1);
            const rets = [];
            for (let j = 1; j < slice.length; j++) rets.push(Math.log(slice[j]/slice[j-1]));
            const m = rets.reduce((a,b)=>a+b,0)/rets.length;
            const v = rets.reduce((a,b)=>a+(b-m)**2,0)/rets.length;
            volSeries.push(Math.sqrt(v * 245));
        }
        for (let i = 0; i < candles.length; i++) {
            const c = candles[i], h = ha[i];
            const ind = { atr: round(atr[i]), stop: entry ? round(entry.stop) : null };
            if (i < p.volWindow + 5 || atr[i] === null || volSeries[i] === null) {
                signals.push({ time: c.time, indicators: ind, signalType: null, position, reason: null });
                continue;
            }
            const volSlice = volSeries.slice(i - p.volWindow, i).filter(x => x !== null);
            const sorted = [...volSlice].sort((a,b) => a-b);
            const threshold = sorted[Math.floor(sorted.length * p.volPct)];
            const isLowVol = volSeries[i] <= threshold;
            let signalType = null, reason = null;
            if (position === 'LONG') {
                const bars = i - entry.idx; const R = entry.risk;
                if (c.close < entry.stop) reason = 'حد ضرر';
                else if (!entry.tp1Hit && c.close >= entry.entry + R * p.tp1R) { entry.tp1Hit = true; entry.stop = entry.entry; }
                else if (entry.tp1Hit && c.close >= entry.entry + R * p.tp2R) reason = 'هدف دوم';
                else if (!isLowVol) reason = 'نوسان بالا رفت';
                else if (bars >= p.maxHoldBars) reason = 'سقف زمانی';
                if (reason) {
                    position = null; signalType = 'EXIT_LONG';
                    const tr = trades[trades.length - 1];
                    if (tr) { tr.exitDate = c.time; tr.exitPrice = c.close; tr.pnlPct = (c.close / tr.entryPrice - 1) * 100; tr.exitReason = reason; }
                    entry = null; cooldown = p.cooldownBars;
                }
            } else {
                if (cooldown > 0) cooldown--;
                else if (isLowVol && h.bullish && c.close > c.open && inEntryWindow(c.time, ctx && ctx.entryWindow)) {
                    const entryPrice = c.close;
                    const stopPrice = c.close - p.atrMult * atr[i];
                    const risk = entryPrice - stopPrice;
                    if (risk > 0) {
                        position = 'LONG'; signalType = 'BUY';
                        entry = { idx: i, price: entryPrice, stop: stopPrice, risk, entry: entryPrice, tp1Hit: false };
                        ind.stop = round(stopPrice);
                        reason = `Low Vol Anomaly (vol=${(volSeries[i]*100).toFixed(1)}%)`;
                        trades.push({ type: 'خرید', entryDate: c.time, entryPrice, stop: stopPrice, risk, reason });
                    }
                }
            }
            signals.push({ time: c.time, indicators: ind, signalType, position, reason });
        }
        return { ha, signals, trades, htfTrend: null };
    }

    // ==================== ۱۷. TSMOM (Time Series Momentum) ====================
    const TSMOM_DEFAULTS = {
        lookbackDays: 252, volLookbackDays: 60, targetVol: 0.15,
        minMomentumPct: 0.5, volRegimeFilter: 1,
        atrPeriod: 14, atrMult: 2.0, maxHoldBars: 60, cooldownBars: 5,
        tp1R: 2.0, tp2R: 4.0, htfEma: 50, htfRsiPeriod: 14
    };
    function runTSMOM(candles, params, ctx) {
        const p = { ...TSMOM_DEFAULTS, ...(params || {}) };
        const ha = getDisplayCandles(candles, p.candleType || 'heikin');
        const closes = candles.map(c => c.close);
        const atr = calculateATR(candles, p.atrPeriod);
        const htf = buildHtf(ctx, p);
        const signals = [], trades = [];
        let position = null, entry = null, cooldown = 0, lastTrend = null;
        const dailyReturns = new Array(candles.length).fill(null);
        for (let i = 1; i < candles.length; i++) {
            if (closes[i] > 0 && closes[i-1] > 0) dailyReturns[i] = Math.log(closes[i] / closes[i-1]);
        }
        const realizedVol = new Array(candles.length).fill(null);
        for (let i = p.volLookbackDays; i < candles.length; i++) {
            const slice = dailyReturns.slice(i - p.volLookbackDays, i).filter(x => x !== null);
            if (slice.length >= p.volLookbackDays * 0.8) {
                const mean = slice.reduce((a,b) => a+b, 0) / slice.length;
                const variance = slice.reduce((a,b) => a + (b-mean)**2, 0) / slice.length;
                realizedVol[i] = Math.sqrt(variance * 252);
            }
        }
        for (let i = 0; i < candles.length; i++) {
            const c = candles[i], h = ha[i];
            const row = htf.forTime(c.time), trend = row ? row.trend : null;
            if (trend) lastTrend = trend;
            const ind = { atr: round(atr[i]), stop: entry ? round(entry.stop) : null };
            const minReq = Math.max(p.lookbackDays, p.volLookbackDays, p.atrPeriod) + 5;
            if (i < minReq || atr[i] === null || realizedVol[i] === null) {
                signals.push({ time: c.time, indicators: ind, signalType: null, position, reason: null });
                continue;
            }
            const pastClose = closes[i - p.lookbackDays];
            const momentum = (c.close / pastClose - 1) * 100;
            const volOk = !p.volRegimeFilter || realizedVol[i] < 0.5;
            let signalType = null, reason = null;
            if (position === 'LONG') {
                const bars = i - entry.idx, R = entry.risk;
                if (c.close < entry.stop) reason = 'حد ضرر';
                else if (!entry.tp1Hit && c.close >= entry.entry + R * p.tp1R) { entry.tp1Hit = true; entry.stop = entry.entry; }
                else if (entry.tp1Hit && c.close >= entry.entry + R * p.tp2R) reason = 'هدف دوم';
                else if (momentum < 0) reason = 'معکوس مومنتوم';
                else if (bars >= p.maxHoldBars) reason = 'سقف زمانی';
                if (reason) {
                    position = null; signalType = 'EXIT_LONG';
                    const tr = trades[trades.length - 1];
                    if (tr) { tr.exitDate = c.time; tr.exitPrice = c.close; tr.pnlPct = (c.close / tr.entryPrice - 1) * 100; tr.exitReason = reason; }
                    entry = null; cooldown = p.cooldownBars;
                }
            } else {
                if (cooldown > 0) cooldown--;
                else if (momentum > p.minMomentumPct && volOk && h.bullish && inEntryWindow(c.time, ctx && ctx.entryWindow)) {
                    const entryPrice = c.close;
                    const stopPrice = c.close - p.atrMult * atr[i];
                    const risk = entryPrice - stopPrice;
                    if (risk > 0) {
                        position = 'LONG'; signalType = 'BUY';
                        entry = { idx: i, price: entryPrice, stop: stopPrice, risk, entry: entryPrice, tp1Hit: false };
                        ind.stop = round(stopPrice);
                        const vs = (p.targetVol / realizedVol[i]).toFixed(2);
                        reason = 'TSMOM (' + momentum.toFixed(1) + '% | vol=' + (realizedVol[i]*100).toFixed(0) + '% | size×' + vs + ')';
                        trades.push({ type: 'خرید', entryDate: c.time, entryPrice, stop: stopPrice, risk, reason });
                    }
                }
            }
            signals.push({ time: c.time, indicators: ind, signalType, position, reason });
        }
        return { ha, signals, trades, htfTrend: lastTrend };
    }

    // ==================== ۱۸. Dual Thrust ====================
    const DUAL_THRUST_DEFAULTS = {
        lookbackDays: 1, k1: 0.5, k2: 0.5,
        atrPeriod: 14, atrMult: 1.5, maxHoldBars: 15, cooldownBars: 2,
        tp1R: 1.5, tp2R: 3.0, htfEma: 20, htfRsiPeriod: 14
    };
    function runDualThrust(candles, params, ctx) {
        const p = { ...DUAL_THRUST_DEFAULTS, ...(params || {}) };
        const ha = getDisplayCandles(candles, p.candleType || 'heikin');
        const atr = calculateATR(candles, p.atrPeriod);
        const htf = buildHtf(ctx, p);
        const signals = [], trades = [];
        let position = null, entry = null, cooldown = 0, lastTrend = null;
        const dayCache = new Map();
        function dayKey(t) { const x = getTehranParts(new Date(t * 1000)); return x.year + '-' + x.month + '-' + x.day; }
        const _dayStats = new Map();
        for (const c of candles) {
            const k = dayKey(c.time);
            if (!_dayStats.has(k)) _dayStats.set(k, { hh: -Infinity, ll: Infinity, hc: -Infinity, lc: Infinity, open: c.open });
            const s = _dayStats.get(k);
            s.hh = Math.max(s.hh, c.high); s.ll = Math.min(s.ll, c.low);
            s.hc = Math.max(s.hc, c.close); s.lc = Math.min(s.lc, c.close);
        }
        const sortedDays = [..._dayStats.keys()].sort();
        for (let i = 0; i < candles.length; i++) {
            const c = candles[i], h = ha[i];
            const row = htf.forTime(c.time), trend = row ? row.trend : null;
            if (trend) lastTrend = trend;
            const ind = { atr: round(atr[i]), stop: entry ? round(entry.stop) : null };
            if (i < p.atrPeriod + 5 || atr[i] === null) { signals.push({ time: c.time, indicators: ind, signalType: null, position, reason: null }); continue; }
            const todayK = dayKey(c.time);
            const todayIdx = sortedDays.indexOf(todayK);
            if (todayIdx <= 0) { signals.push({ time: c.time, indicators: ind, signalType: null, position, reason: null }); continue; }
            const prevK = sortedDays[todayIdx - 1];
            const prev = _dayStats.get(prevK);
            const today = _dayStats.get(todayK);
            const range = Math.max(prev.hh - prev.lc, prev.hc - prev.ll);
            const upLine = today.open + p.k1 * range;
            const loLine = today.open - p.k2 * range;
            let signalType = null, reason = null;
            if (position === 'LONG') {
                const bars = i - entry.idx, R = entry.risk;
                if (c.close < entry.stop) reason = 'حد ضرر';
                else if (!entry.tp1Hit && c.close >= entry.entry + R * p.tp1R) { entry.tp1Hit = true; entry.stop = entry.entry; }
                else if (entry.tp1Hit && c.close >= entry.entry + R * p.tp2R) reason = 'هدف دوم';
                else if (c.close < loLine) reason = 'شکست پایین';
                else if (bars >= p.maxHoldBars) reason = 'سقف زمانی';
                if (reason) {
                    position = null; signalType = 'EXIT_LONG';
                    const tr = trades[trades.length - 1];
                    if (tr) { tr.exitDate = c.time; tr.exitPrice = c.close; tr.pnlPct = (c.close / tr.entryPrice - 1) * 100; tr.exitReason = reason; }
                    entry = null; cooldown = p.cooldownBars;
                }
            } else {
                if (cooldown > 0) cooldown--;
                else if (c.close > upLine && h.bullish && inEntryWindow(c.time, ctx && ctx.entryWindow)) {
                    const entryPrice = c.close;
                    const stopPrice = loLine - p.atrMult * atr[i];
                    const risk = entryPrice - stopPrice;
                    if (risk > 0) {
                        position = 'LONG'; signalType = 'BUY';
                        entry = { idx: i, price: entryPrice, stop: stopPrice, risk, entry: entryPrice, tp1Hit: false };
                        ind.stop = round(stopPrice);
                        reason = 'Dual Thrust (open=' + round(today.open) + ', up=' + round(upLine) + ')';
                        trades.push({ type: 'خرید', entryDate: c.time, entryPrice, stop: stopPrice, risk, reason });
                    }
                }
            }
            signals.push({ time: c.time, indicators: ind, signalType, position, reason });
        }
        return { ha, signals, trades, htfTrend: lastTrend };
    }

    // ==================== ۱۹. RSI-2 Mean Reversion ====================
    const RSI2_MR_DEFAULTS = {
        rsiPeriod: 2, rsiEntry: 25, rsiExit: 65, smaFilter: 100,
        atrPeriod: 14, atrMult: 1.5, maxHoldBars: 10, cooldownBars: 1,
        tp1R: 1.0, tp2R: 2.0, htfEma: 20, htfRsiPeriod: 14
    };
    function runRSI2MeanReversion(candles, params, ctx) {
        const p = { ...RSI2_MR_DEFAULTS, ...(params || {}) };
        const ha = getDisplayCandles(candles, p.candleType || 'heikin');
        const closes = candles.map(c => c.close);
        const rsi2 = calculateRSI(closes, p.rsiPeriod);
        const sma = new Array(closes.length).fill(null);
        for (let i = p.smaFilter - 1; i < closes.length; i++) {
            let s = 0;
            for (let k = i - p.smaFilter + 1; k <= i; k++) s += closes[k];
            sma[i] = s / p.smaFilter;
        }
        const atr = calculateATR(candles, p.atrPeriod);
        const htf = buildHtf(ctx, p);
        const signals = [], trades = [];
        let position = null, entry = null, cooldown = 0, lastTrend = null;
        for (let i = 0; i < candles.length; i++) {
            const c = candles[i], h = ha[i];
            const row = htf.forTime(c.time), trend = row ? row.trend : null;
            if (trend) lastTrend = trend;
            const ind = { atr: round(atr[i]), stop: entry ? round(entry.stop) : null, rsi2: rsi2[i] !== null ? round(rsi2[i]) : null };
            if (i < Math.max(p.smaFilter, p.atrPeriod) + 5 || rsi2[i] === null || sma[i] === null || atr[i] === null) {
                signals.push({ time: c.time, indicators: ind, signalType: null, position, reason: null }); continue;
            }
            const aboveSMA = c.close > sma[i];
            let signalType = null, reason = null;
            if (position === 'LONG') {
                const bars = i - entry.idx, R = entry.risk;
                if (c.close < entry.stop) reason = 'حد ضرر';
                else if (!entry.tp1Hit && c.close >= entry.entry + R * p.tp1R) { entry.tp1Hit = true; entry.stop = entry.entry; }
                else if (entry.tp1Hit && c.close >= entry.entry + R * p.tp2R) reason = 'هدف دوم';
                else if (rsi2[i] > p.rsiExit) reason = 'RSI2 اشباع خرید (' + rsi2[i].toFixed(0) + ')';
                else if (bars >= p.maxHoldBars) reason = 'سقف زمانی';
                if (reason) {
                    position = null; signalType = 'EXIT_LONG';
                    const tr = trades[trades.length - 1];
                    if (tr) { tr.exitDate = c.time; tr.exitPrice = c.close; tr.pnlPct = (c.close / tr.entryPrice - 1) * 100; tr.exitReason = reason; }
                    entry = null; cooldown = p.cooldownBars;
                }
            } else {
                if (cooldown > 0) cooldown--;
                else if (rsi2[i] < p.rsiEntry && aboveSMA && h.bullish && inEntryWindow(c.time, ctx && ctx.entryWindow)) {
                    const entryPrice = c.close;
                    const stopPrice = c.close - p.atrMult * atr[i];
                    const risk = entryPrice - stopPrice;
                    if (risk > 0) {
                        position = 'LONG'; signalType = 'BUY';
                        entry = { idx: i, price: entryPrice, stop: stopPrice, risk, entry: entryPrice, tp1Hit: false };
                        ind.stop = round(stopPrice);
                        reason = 'RSI-2 MR (RSI2=' + rsi2[i].toFixed(0) + ', >SMA' + p.smaFilter + ')';
                        trades.push({ type: 'خرید', entryDate: c.time, entryPrice, stop: stopPrice, risk, reason });
                    }
                }
            }
            signals.push({ time: c.time, indicators: ind, signalType, position, reason });
        }
        return { ha, signals, trades, htfTrend: lastTrend };
    }

    // ==================== ۲۰. ORB Pro ====================
    const ORB_PRO_DEFAULTS = {
        rangeMinutes: 15, volumeMult: 1.5, maxRangePct: 2.0, minRangePct: 0.3,
        atrPeriod: 14, atrMult: 1.5, maxHoldBars: 20, cooldownBars: 2,
        tp1R: 1.5, tp2R: 3.0, htfEma: 20, htfRsiPeriod: 14
    };
    function runORBPro(candles, params, ctx) {
        const p = { ...ORB_PRO_DEFAULTS, ...(params || {}) };
        const ha = getDisplayCandles(candles, p.candleType || 'heikin');
        const atr = calculateATR(candles, p.atrPeriod);
        const htf = buildHtf(ctx, p);
        const signals = [], trades = [];
        let position = null, entry = null, cooldown = 0, lastTrend = null;
        const dayCache = new Map();
        function dayKey(t) { const x = getTehranParts(new Date(t * 1000)); return x.year + '-' + x.month + '-' + x.day; }
        function avgVolume(i) { const s = Math.max(0, i - 20); const slice = candles.slice(s, i); return slice.length ? slice.reduce((a, c) => a + (c.volume || 0), 0) / slice.length : 0; }
        for (let i = 0; i < candles.length; i++) {
            const c = candles[i], h = ha[i];
            const row = htf.forTime(c.time), trend = row ? row.trend : null;
            if (trend) lastTrend = trend;
            const t = getTehranParts(new Date(c.time * 1000));
            const dKey = dayKey(c.time);
            const minOfDay = t.hour * 60 + t.minute;
            const rangeEndMin = SESSION_START_MIN + p.rangeMinutes;
            let orb = dayCache.get(dKey);
            if (minOfDay <= rangeEndMin) {
                if (!orb) { orb = { hi: c.high, lo: c.low, vol: c.volume || 0, open: c.open }; dayCache.set(dKey, orb); }
                else { orb.hi = Math.max(orb.hi, c.high); orb.lo = Math.min(orb.lo, c.low); orb.vol += (c.volume || 0); }
            }
            const ind = { atr: round(atr[i]), stop: entry ? round(entry.stop) : null };
            if (i < Math.max(p.atrPeriod, 20) + 5 || atr[i] === null) { signals.push({ time: c.time, indicators: ind, signalType: null, position, reason: null }); continue; }
            let signalType = null, reason = null;
            if (position === 'LONG') {
                const bars = i - entry.idx, R = entry.risk;
                if (c.close < entry.stop) reason = 'حد ضرر';
                else if (!entry.tp1Hit && c.close >= entry.entry + R * p.tp1R) { entry.tp1Hit = true; entry.stop = entry.entry; }
                else if (entry.tp1Hit && c.close >= entry.entry + R * p.tp2R) reason = 'هدف دوم';
                else if (bars >= p.maxHoldBars) reason = 'سقف زمانی';
                else if (minOfDay > SESSION_END_MIN) reason = 'پایان جلسه';
                if (reason) {
                    position = null; signalType = 'EXIT_LONG';
                    const tr = trades[trades.length - 1];
                    if (tr) { tr.exitDate = c.time; tr.exitPrice = c.close; tr.pnlPct = (c.close / tr.entryPrice - 1) * 100; tr.exitReason = reason; }
                    entry = null; cooldown = p.cooldownBars;
                }
            } else {
                if (cooldown > 0) cooldown--;
                else if (orb && minOfDay > rangeEndMin && minOfDay <= rangeEndMin + 90 && h.bullish && inEntryWindow(c.time, ctx && ctx.entryWindow)) {
                    const rangePct = (orb.hi - orb.lo) / orb.lo * 100;
                    const avgVol = avgVolume(i);
                    const volOk = avgVol > 0 ? (c.volume || 0) >= avgVol * p.volumeMult : true;
                    const rangeOk = rangePct >= p.minRangePct && rangePct <= p.maxRangePct;
                    if (c.close > orb.hi && volOk && rangeOk) {
                        const entryPrice = c.close;
                        const stopPrice = orb.lo - p.atrMult * atr[i];
                        const risk = entryPrice - stopPrice;
                        if (risk > 0) {
                            position = 'LONG'; signalType = 'BUY';
                            entry = { idx: i, price: entryPrice, stop: stopPrice, risk, entry: entryPrice, tp1Hit: false };
                            ind.stop = round(stopPrice);
                            reason = 'ORB Pro (' + p.rangeMinutes + 'm | range=' + rangePct.toFixed(2) + '% | vol×' + (c.volume/avgVol).toFixed(1) + ')';
                            trades.push({ type: 'خرید', entryDate: c.time, entryPrice, stop: stopPrice, risk, reason });
                        }
                    }
                }
            }
            signals.push({ time: c.time, indicators: ind, signalType, position, reason });
        }
        return { ha, signals, trades, htfTrend: lastTrend };
    }

    // ==================== ۲۱. Gap and Go ====================
    const GAP_GO_DEFAULTS = {
        minGapPct: 2.0, volumeMult: 2.0, firstBarMinutes: 5,
        atrPeriod: 14, atrMult: 1.2, maxHoldBars: 15, cooldownBars: 2,
        tp1R: 1.5, tp2R: 3.0, htfEma: 20, htfRsiPeriod: 14
    };
    function runGapAndGo(candles, params, ctx) {
        const p = { ...GAP_GO_DEFAULTS, ...(params || {}) };
        const ha = getDisplayCandles(candles, p.candleType || 'heikin');
        const atr = calculateATR(candles, p.atrPeriod);
        const htf = buildHtf(ctx, p);
        const signals = [], trades = [];
        let position = null, entry = null, cooldown = 0, lastTrend = null;
        const dayCache = new Map();
        function dayKey(t) { const x = getTehranParts(new Date(t * 1000)); return x.year + '-' + x.month + '-' + x.day; }
        function avgVolume(i) { const s = Math.max(0, i - 20); const slice = candles.slice(s, i); return slice.length ? slice.reduce((a, c) => a + (c.volume || 0), 0) / slice.length : 0; }
        function prevClose(currentTime) { const key = dayKey(currentTime); for (let i = candles.length - 1; i >= 0; i--) { if (candles[i].time >= currentTime) continue; if (dayKey(candles[i].time) !== key) return candles[i].close; } return null; }
        for (let i = 0; i < candles.length; i++) {
            const c = candles[i], h = ha[i];
            const row = htf.forTime(c.time), trend = row ? row.trend : null;
            if (trend) lastTrend = trend;
            const t = getTehranParts(new Date(c.time * 1000));
            const dKey = dayKey(c.time);
            const minOfDay = t.hour * 60 + t.minute;
            const rangeEndMin = SESSION_START_MIN + p.firstBarMinutes;
            let fb = dayCache.get(dKey);
            if (minOfDay <= rangeEndMin) {
                if (!fb) { fb = { hi: c.high, lo: c.low, vol: c.volume || 0, open: c.open }; dayCache.set(dKey, fb); }
                else { fb.hi = Math.max(fb.hi, c.high); fb.lo = Math.min(fb.lo, c.low); fb.vol += (c.volume || 0); }
            }
            const ind = { atr: round(atr[i]), stop: entry ? round(entry.stop) : null };
            if (i < Math.max(p.atrPeriod, 20) + 5 || atr[i] === null) { signals.push({ time: c.time, indicators: ind, signalType: null, position, reason: null }); continue; }
            let signalType = null, reason = null;
            if (position === 'LONG') {
                const bars = i - entry.idx, R = entry.risk;
                if (c.close < entry.stop) reason = 'حد ضرر';
                else if (!entry.tp1Hit && c.close >= entry.entry + R * p.tp1R) { entry.tp1Hit = true; entry.stop = entry.entry; }
                else if (entry.tp1Hit && c.close >= entry.entry + R * p.tp2R) reason = 'هدف دوم';
                else if (bars >= p.maxHoldBars) reason = 'سقف زمانی';
                else if (minOfDay > SESSION_END_MIN) reason = 'پایان جلسه';
                if (reason) {
                    position = null; signalType = 'EXIT_LONG';
                    const tr = trades[trades.length - 1];
                    if (tr) { tr.exitDate = c.time; tr.exitPrice = c.close; tr.pnlPct = (c.close / tr.entryPrice - 1) * 100; tr.exitReason = reason; }
                    entry = null; cooldown = p.cooldownBars;
                }
            } else {
                if (cooldown > 0) cooldown--;
                else if (fb && minOfDay > rangeEndMin && minOfDay <= rangeEndMin + 60 && h.bullish && inEntryWindow(c.time, ctx && ctx.entryWindow)) {
                    const pc = prevClose(c.time);
                    if (pc) {
                        const gapPct = (fb.open / pc - 1) * 100;
                        const avgVol = avgVolume(i);
                        const volOk = avgVol > 0 ? (c.volume || 0) >= avgVol * p.volumeMult : true;
                        if (gapPct >= p.minGapPct && volOk && c.close > fb.hi) {
                            const entryPrice = c.close;
                            const stopPrice = fb.lo - p.atrMult * atr[i];
                            const risk = entryPrice - stopPrice;
                            if (risk > 0) {
                                position = 'LONG'; signalType = 'BUY';
                                entry = { idx: i, price: entryPrice, stop: stopPrice, risk, entry: entryPrice, tp1Hit: false };
                                ind.stop = round(stopPrice);
                                reason = 'Gap and Go (gap=+' + gapPct.toFixed(2) + '% | vol×' + (c.volume/avgVol).toFixed(1) + ')';
                                trades.push({ type: 'خرید', entryDate: c.time, entryPrice, stop: stopPrice, risk, reason });
                            }
                        }
                    }
                }
            }
            signals.push({ time: c.time, indicators: ind, signalType, position, reason });
        }
        return { ha, signals, trades, htfTrend: lastTrend };
    }

    // ==================== رجیستری ====================
    // 🆕 فیلدهای nameFa / category / regime برای auto-derive در
    //     monthly-report.job.js و core/regime.js استفاده می‌شن.
    const STRATEGIES = {

        // ==================== استراتژی‌های جدید (۲۰۲۶) ====================
        tsmom: {
            id: 'tsmom', name: 'TSMOM', nameFa: 'مومنتوم سری‌زمانی',
            category: 'momentum',
            regime: { macro: ['bull','range'], vol: ['normal','high'] },
            defaultTimeframe: '1d', htfTimeframe: '1d',
            defaultParams: TSMOM_DEFAULTS, indicators: ['atr','vol'],
            run: runTSMOM
        },
        dual_thrust: {
            deprecated: true,
            id: 'dual_thrust', name: 'Dual Thrust', nameFa: 'دوال تراست',
            category: 'breakout',
            regime: { macro: ['bull','bear','range'], vol: ['normal','high'] },
            defaultTimeframe: '30m', htfTimeframe: '1d',
            defaultParams: DUAL_THRUST_DEFAULTS, indicators: ['atr'],
            run: runDualThrust
        },
        rsi2_mr: {
            id: 'rsi2_mr', name: 'RSI-2 Mean Reversion', nameFa: 'بازگشت RSI-2',
            category: 'meanrev',
            regime: { macro: ['bull','range'], vol: ['normal','low'] },
            defaultTimeframe: '1d', htfTimeframe: '1d',
            defaultParams: RSI2_MR_DEFAULTS, indicators: ['rsi','atr'],
            run: runRSI2MeanReversion
        },
        orb_pro: {
            deprecated: true,
            id: 'orb_pro', name: 'ORB Pro', nameFa: 'شکست بازه آغازین حرفه‌ای',
            category: 'breakout',
            regime: { macro: ['bull','range'], vol: ['normal','high'] },
            defaultTimeframe: '15m', htfTimeframe: '1d',
            defaultParams: ORB_PRO_DEFAULTS, indicators: ['atr','volume'],
            run: runORBPro
        },
        gap_and_go: {
            deprecated: true,
            id: 'gap_and_go', name: 'Gap and Go', nameFa: 'گپ و حرکت',
            category: 'momentum',
            regime: { macro: ['bull','range'], vol: ['normal','high'] },
            defaultTimeframe: '15m', htfTimeframe: '1d',
            defaultParams: GAP_GO_DEFAULTS, indicators: ['atr','volume'],
            run: runGapAndGo
        },
        // ───── SMC / Price Action ─────
        smc_unicorn: {
            id: 'smc_unicorn',
            name: 'SMC Unicorn',
            nameFa: 'SMC یونیکورن',
            category: 'smc',
            regime: { macro: ['bull', 'range'], vol: ['normal', 'high'] },
            defaultTimeframe: '1h',
            htfTimeframe: '1d',
            defaultParams: SMC_DEFAULTS,
            indicators: ['atr', 'trend'],
            run: runSMCUnicorn
        },
        ob_sweep: {
            id: 'ob_sweep',
            name: 'OB + Sweep',
            nameFa: 'OB + Sweep',
            category: 'smc',
            regime: { macro: ['bull', 'range', 'bear'], vol: ['normal', 'high'] },
            defaultTimeframe: '1h',
            htfTimeframe: '1d',
            defaultParams: OB_DEFAULTS,
            indicators: ['atr'],
            run: runOBSweep
        },

        ob_after_sweep: {
            id: 'ob_after_sweep',
            name: 'OB After Sweep',
            nameFa: 'OB بعد از Sweep',
            category: 'smc',
            regime: { macro: ['bull', 'range'], vol: ['normal', 'high'] },
            defaultTimeframe: '1h',
            htfTimeframe: '1d',
            defaultParams: OBAS_DEFAULTS,
            indicators: ['atr'],
            run: runOBAfterSweep
        },


        // ───── اندیکاتور محور ─────





        // ───── Mean Reversion ─────



        // ───── Volatility / Structure ─────


        // ───── استراتژی‌های جدید (علمی) ─────
        momentum_12_1: {
            id: 'momentum_12_1',
            name: 'Momentum 12-1',
            nameFa: 'مومنتوم ۱۲-۱',
            category: 'momentum',
            regime: { macro: ['bull'], vol: ['normal', 'high'] },
            defaultTimeframe: '1d',
            htfTimeframe: '1d',
            defaultParams: MOM12_1_DEFAULTS,
            indicators: ['atr'],
            run: runMomentum121
        },
        short_term_reversal: {
            id: 'short_term_reversal',
            name: 'Short-Term Reversal',
            nameFa: 'بازگشت کوتاه‌مدت',
            category: 'meanrev',
            regime: { macro: ['range', 'bear'], vol: ['high', 'normal'] },
            defaultTimeframe: '1d',
            htfTimeframe: '1d',
            defaultParams: STR5_DEFAULTS,
            indicators: ['atr'],
            run: runShortTermReversal
        },


        low_vol_anomaly: {
            id: 'low_vol_anomaly',
            name: 'Low Volatility Anomaly',
            nameFa: 'آنومالی نوسان کم',
            category: 'momentum',
            regime: { macro: ['bull'], vol: ['low'] },
            defaultTimeframe: '1d',
            htfTimeframe: '1d',
            defaultParams: LOW_VOL_DEFAULTS,
            indicators: ['atr'],
            run: runLowVolAnomaly
        },
                donchian: {
            id: 'donchian',
            name: 'Donchian Breakout',
            nameFa: 'شکست دانچیان',
            category: 'volatility',
            regime: { macro: ['bull', 'bear'], vol: ['normal', 'high'] },
            defaultTimeframe: '1h',
            htfTimeframe: '1d',
            defaultParams: DONCH_DEFAULTS,
            indicators: ['atr'],
            run: runDonchianBreakout
        },

        // ───── چند-نمادی / صنعت ─────

        sector_momentum: {
            id: 'sector_momentum',
            name: 'Sector Momentum',
            nameFa: 'مومنتوم صنعت',
            category: 'pairs',
            regime: { macro: ['bull'], vol: ['normal', 'high'] },
            defaultTimeframe: '1h',
            htfTimeframe: '1d',
            defaultParams: SECTOR_DEFAULTS,
            indicators: ['atr'],
            run: runSectorMomentum
        },

        // ───── ترکیبی ─────
};

    function getRequiredCandles(id, params) {
        const p = { ...(STRATEGIES[id] ? STRATEGIES[id].defaultParams : {}), ...(params || {}) };
        if (id === 'smc_unicorn') return Math.max(p.swingLength + 5, p.atrPeriod + 3, p.maxHoldBars);
        if (id === 'ob_sweep') return Math.max(p.swingLength + p.obLookback + 5, p.atrPeriod + 3, p.maxHoldBars);
        if (id === 'ob_after_sweep') return Math.max(p.swingLength + p.obLookback + p.sweepWithinBars + 5, p.atrPeriod + 3);
        if (id === 'donchian') return Math.max(p.entryPeriod, p.exitPeriod, p.atrPeriod) + 10;
        if (id === 'sector_momentum') return Math.max(p.momentumLookback, p.atrPeriod) + 10;
        // 🆕 New scientific strategies
        if (id === 'momentum_12_1') return (p.lookbackMonths || 12) * 21 + (p.skipMonths || 1) * 21 + 20;
        if (id === 'short_term_reversal') return (p.lookbackDays || 5) * 7 + 20;
        if (id === 'low_vol_anomaly') return (p.volWindow || 60) + 25;
        if (id === 'ensemble') {
            const subIds = ['smc_unicorn', 'ob_sweep', 'ob_after_sweep', 'donchian', 'atr_expansion'];
            return Math.max(...subIds.map(sid => getRequiredCandles(sid, p)));
        }
        if (id === 'tsmom') return Math.max(p.lookbackDays || 252, p.volLookbackDays || 60, p.atrPeriod) + 10;
        if (id === 'dual_thrust') return Math.max((p.lookbackDays || 1) * 10, p.atrPeriod) + 10;
        if (id === 'rsi2_mr') return Math.max(p.smaFilter || 200, p.atrPeriod) + 10;
        if (id === 'orb_pro') return Math.max(p.atrPeriod, 40) + 10;
        if (id === 'gap_and_go') return Math.max(p.atrPeriod, 40) + 10;
        return 10;
    }
    function getRequiredHtfCandles(id, params) {
        const p = { ...(STRATEGIES[id] ? STRATEGIES[id].defaultParams : {}), ...(params || {}) };
        return Math.max(p.htfEma || 20, p.htfRsiPeriod || 14) + 2;
    }

    // __merge-extra
    if (__extra && __extra.STRATEGIES) {
        for (const [__id, __def] of Object.entries(__extra.STRATEGIES)) {
            STRATEGIES[__id] = __def;
        }
    }
    if (__extra && typeof __extra.getRequiredCandles === "function") {
        const __origReq = getRequiredCandles;
        getRequiredCandles = function(id, params) {
            const r = __extra.getRequiredCandles(id, params);
            if (r !== null && r !== undefined) return r;
            return __origReq(id, params);
        };
    }

    return {
        // === indicators + helpers ===
        calculateHeikinAshi, calculateSimpleCandles, getDisplayCandles,
        calculateRSI, calculateEMA, calculateATR,
        calculateMACD, calculateBollingerBands, calculateIchimoku,
        aggregateCandles, TIMEFRAME_MINUTES,
        getRequiredCandles, getRequiredHtfCandles,
        // === kept strategies (8) ===
        runSMCUnicorn, runOBSweep, runOBAfterSweep,
        runDonchianBreakout, runSectorMomentum,
        // === new strategies (5) ===
        runTSMOM, runDualThrust, runRSI2MeanReversion, runORBPro, runGapAndGo,
        // === kept defaults ===
        SMC_DEFAULTS, OB_DEFAULTS, OBAS_DEFAULTS, DONCH_DEFAULTS, SECTOR_DEFAULTS,
        // === new defaults ===
        TSMOM_DEFAULTS, DUAL_THRUST_DEFAULTS, RSI2_MR_DEFAULTS,
        ORB_PRO_DEFAULTS, GAP_GO_DEFAULTS,
        // === registry ===
        STRATEGIES
    };
});