(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.TradingStrategies = factory();
})(typeof self !== 'undefined' ? self : this, function () {

    function getTehranParts(date) {
        const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
        const map = {}; fmt.formatToParts(date).forEach(p => { map[p.type] = p.value; });
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
        const m = minuteOfDay(timeSec); if (m === 0) return true;
        return m >= w.start && m <= w.end;
    }
    const round = v => (v === null || v === undefined) ? null : Math.round(v * 100) / 100;

    // ==================== ۱. SMC Unicorn ====================
    const SMC_DEFAULTS = {
        swingLength: 2, htfEma: 20, htfRsiPeriod: 14,
        fvgMinGapPct: 0.01,
        useOTE: 0, oteLow: 0.5, oteHigh: 0.886,
        atrPeriod: 14, atrMult: 1.5,
        maxHoldBars: 20, cooldownBars: 3,
        useBreakEven: 1, tp1R: 1, tp2R: 2, tp3R: 3,
        minLiquiditySweepPct: 0.01,
        requireVolumeFilter: 0, useKillzone: 0,
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
    const OB_DEFAULTS = { swingLength: 5, htfEma: 20, htfRsiPeriod: 14, atrPeriod: 14, atrMult: 1.5, maxHoldBars: 25, cooldownBars: 3, tp1R: 1.5, tp2R: 3.0, obLookback: 5, minSweepPct: 0.02, minConditions: 1 };
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
    const SDZ_DEFAULTS = { baseBars: 2, minMovePct: 1.5, zoneLookback: 30, zoneTouchPct: 0.5, atrPeriod: 14, atrMult: 2, maxHoldBars: 25, cooldownBars: 2, htfEma: 20, htfRsiPeriod: 14 };
    function runSupplyDemand(candles, params, ctx) {
        const p = { ...SDZ_DEFAULTS, ...(params || {}) };
        const ha = getDisplayCandles(candles, p.candleType || 'heikin');
        const atr = calculateATR(candles, p.atrPeriod);
        const htf = buildHtf(ctx, p), htfName = (ctx && ctx.htfTimeframe) || '1d';
        const signals = [], trades = [];
        let position = null, entry = null, cooldown = 0, lastTrend = null;
        function findDemandZone(i) {
            const start = Math.max(0, i - p.zoneLookback);
            for (let k = start; k < i - p.baseBars; k++) {
                const baseEnd = k + p.baseBars - 1;
                if (baseEnd >= i) break;
                let baseHigh = -Infinity, baseLow = Infinity;
                for (let b = k; b <= baseEnd; b++) { baseHigh = Math.max(baseHigh, candles[b].high); baseLow = Math.min(baseLow, candles[b].low); }
                const baseRange = (baseHigh - baseLow) / baseLow * 100;
                if (baseRange > 1.5) continue;
                const moveCandle = candles[baseEnd + 1];
                if (!moveCandle) continue;
                const movePct = (moveCandle.close - baseLow) / baseLow * 100;
                if (movePct < p.minMovePct) continue;
                if (candles[i].low >= baseLow - 0.01 && candles[i].low <= baseHigh * (1 + p.zoneTouchPct / 100)) {
                    return { top: baseHigh, bottom: baseLow, idx: k };
                }
            }
            return null;
        }
        for (let i = 0; i < candles.length; i++) {
            const c = candles[i], h = ha[i];
            const row = htf.forTime(c.time), trend = row ? row.trend : null; if (trend) lastTrend = trend;
            const ind = { atr: round(atr[i]), stop: entry ? round(entry.stop) : null };
            if (i < Math.max(p.zoneLookback + 3, p.atrPeriod + 2) || atr[i] === null) { signals.push({ time: c.time, indicators: ind, signalType: null, position, reason: null }); continue; }
            let signalType = null, reason = null;
            if (position === 'LONG') {
                const bars = i - entry.idx; const R = entry.risk;
                if (c.close < entry.stop) reason = `حد ضرر`;
                else if (!entry.tp1Hit && c.close >= entry.entry + R * 1.5) { entry.tp1Hit = true; entry.stop = entry.entry; }
                else if (entry.tp1Hit && c.close >= entry.entry + R * 3.0) reason = `هدف دوم`;
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
                    const zone = findDemandZone(i);
                    if (zone && h.bullish && c.close > c.open) {
                        const entryPrice = c.close;
                        const stopPrice = zone.bottom - p.atrMult * atr[i];
                        const risk = entryPrice - stopPrice;
                        if (risk <= 0) { signals.push({ time: c.time, indicators: ind, signalType: null, position, reason: null }); continue; }
                        position = 'LONG'; signalType = 'BUY';
                        entry = { idx: i, price: entryPrice, stop: stopPrice, risk, entry: entryPrice, tp1Hit: false, zoneTop: zone.top, zoneBottom: zone.bottom };
                        ind.stop = round(stopPrice);
                        reason = `SDZ: بازگشت به تقاضا (${Math.round(zone.bottom)}-${Math.round(zone.top)})`;
                        trades.push({ type: 'خرید', entryDate: c.time, entryPrice, stop: stopPrice, risk, reason });
                    }
                }
            }
            signals.push({ time: c.time, indicators: ind, signalType, position, reason });
        }
        return { ha, signals, trades, htfTrend: lastTrend };
    }

    // ==================== ۴. OB After Sweep ====================
    const OBAS_DEFAULTS = { swingLength: 4, htfEma: 20, htfRsiPeriod: 14, atrPeriod: 14, atrMult: 1.5, maxHoldBars: 20, cooldownBars: 3, tp1R: 1.5, tp2R: 3.0, obLookback: 12, minSweepPct: 0.02, sweepWithinBars: 10 };
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
    const ORB_DEFAULTS = { rangeMinutes: 30, htfEma: 20, htfRsiPeriod: 14, atrPeriod: 14, atrMult: 1.5, maxHoldBars: 25, cooldownBars: 2, tp1R: 1.5, tp2R: 3.0, minRangePct: 0.2, requireVolume: 0 };
    function runORB(candles, params, ctx) {
        const p = { ...ORB_DEFAULTS, ...(params || {}) };
        const ha = getDisplayCandles(candles, p.candleType || 'heikin');
        const atr = calculateATR(candles, p.atrPeriod);
        const htf = buildHtf(ctx, p), htfName = (ctx && ctx.htfTimeframe) || '1d';
        const signals = [], trades = [];
        let position = null, entry = null, cooldown = 0, lastTrend = null;
        const orbCache = new Map();
        function getORB(dayKey) { return orbCache.get(dayKey) || null; }
        function buildORBFor(i) {
            const c = candles[i];
            const t = getTehranParts(new Date(c.time * 1000));
            const dayKey = `${t.year}-${t.month}-${t.day}`;
            const rangeEndMin = SESSION_START_MIN + p.rangeMinutes;
            const hi = t.hour * 60 + t.minute;
            if (hi > rangeEndMin) return getORB(dayKey);
            let orb = orbCache.get(dayKey);
            if (!orb) { orb = { hi: c.high, lo: c.low, key: dayKey }; orbCache.set(dayKey, orb); }
            else { orb.hi = Math.max(orb.hi, c.high); orb.lo = Math.min(orb.lo, c.low); }
            return null;
        }
        for (let i = 0; i < candles.length; i++) {
            const c = candles[i], h = ha[i];
            const row = htf.forTime(c.time), trend = row ? row.trend : null; if (trend) lastTrend = trend;
            const ind = { atr: round(atr[i]), stop: entry ? round(entry.stop) : null };
            if (i < Math.max(p.atrPeriod + 3, 20) || atr[i] === null) { signals.push({ time: c.time, indicators: ind, signalType: null, position, reason: null }); continue; }
            const t = getTehranParts(new Date(c.time * 1000));
            const dayKey = `${t.year}-${t.month}-${t.day}`;
            const currentMin = t.hour * 60 + t.minute;
            const rangeEndMin = SESSION_START_MIN + p.rangeMinutes;
            let orb = null;
            if (currentMin <= rangeEndMin) buildORBFor(i);
            else orb = getORB(dayKey);
            let signalType = null, reason = null;
            if (position === 'LONG') {
                const bars = i - entry.idx; const R = entry.risk;
                if (c.close < entry.stop) reason = 'حد ضرر';
                else if (!entry.tp1Hit && c.close >= entry.entry + R * p.tp1R) { entry.tp1Hit = true; entry.stop = entry.entry; }
                else if (entry.tp1Hit && c.close >= entry.entry + R * p.tp2R) reason = 'هدف دوم';
                else if (trend === 'نزولی') reason = 'روند نزولی';
                else if (bars >= p.maxHoldBars) reason = 'سقف زمان';
                if (reason) {
                    position = null; signalType = 'EXIT_LONG';
                    const tr = trades[trades.length - 1];
                    if (tr) { tr.exitDate = c.time; tr.exitPrice = c.close; tr.pnlPct = (c.close / tr.entryPrice - 1) * 100; tr.exitReason = reason; }
                    entry = null; cooldown = p.cooldownBars;
                }
            } else {
                if (cooldown > 0) cooldown--;
                else if (trend === 'صعودی' && inEntryWindow(c.time, ctx && ctx.entryWindow)) {
                    if (orb && currentMin > rangeEndMin && currentMin <= rangeEndMin + 60) {
                        const rangePct = (orb.hi - orb.lo) / orb.lo * 100;
                        if (rangePct >= p.minRangePct && c.close > orb.hi && h.bullish) {
                            const entryPrice = c.close;
                            const stopPrice = orb.lo - p.atrMult * atr[i];
                            const risk = entryPrice - stopPrice;
                            if (risk > 0) {
                                position = 'LONG'; signalType = 'BUY';
                                entry = { idx: i, price: entryPrice, stop: stopPrice, risk, entry: entryPrice, tp1Hit: false, orbHi: orb.hi, orbLo: orb.lo };
                                ind.stop = round(stopPrice);
                                reason = `ORB (${Math.round(orb.lo)}-${Math.round(orb.hi)})`;
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

    // ==================== ۶. Ensemble ====================
    const ENSEMBLE_DEFAULTS = {
        threshold: 1.2, minAgree: 2,
        wRsi: 0,           // RSI حذف شد
        wSmc: 1.70,
        wOb: 1.40,
        wObas: 1.30,
        wSD: 1.15,
        wLb: 0,            // London حذف شد
        wOrb: 1.20,
        wPbr: 0,           // Pin Bar حذف شد
        wVwap: 0.9,        // 🆕
        wSt: 1.2,          // 🆕
        wBbsq: 1.0,        // 🆕
        wDonch: 1.1,       // 🆕
        wKc: 0.9,          // 🆕
        cooldownBars: 3, maxHoldBars: 30,
        atrPeriod: 14, atrMult: 2.0,
        htfEma: 20, htfRsiPeriod: 14
    };
    function runEnsemble(candles, params, ctx) {
        const p = { ...ENSEMBLE_DEFAULTS, ...(params || {}) };
        // فقط استراتژی‌های باقیمانده
        const subStrategies = [
            { id: 'smc_unicorn', weight: p.wSmc, run: runSMCUnicorn, defaults: SMC_DEFAULTS },
            { id: 'ob_sweep', weight: p.wOb, run: runOBSweep, defaults: OB_DEFAULTS },
            { id: 'ob_after_sweep', weight: p.wObas, run: runOBAfterSweep, defaults: OBAS_DEFAULTS },
            { id: 'supply_demand', weight: p.wSD, run: runSupplyDemand, defaults: SDZ_DEFAULTS },
            { id: 'orb', weight: p.wOrb, run: runORB, defaults: ORB_DEFAULTS },
            { id: 'vwap_bounce', weight: p.wVwap, run: runVwapBounce, defaults: VWAP_DEFAULTS },
            { id: 'supertrend', weight: p.wSt, run: runSupertrend, defaults: ST_DEFAULTS },
            { id: 'bb_squeeze', weight: p.wBbsq, run: runBollingerSqueeze, defaults: BBSQ_DEFAULTS },
            { id: 'donchian', weight: p.wDonch, run: runDonchianBreakout, defaults: DONCH_DEFAULTS },
            { id: 'keltner_pb', weight: p.wKc, run: runKeltnerPullback, defaults: KCPB_DEFAULTS }
        ];
        const subCtx = { ...ctx, entryWindow: ctx && ctx.entryWindow };
        const results = {};
        for (const sub of subStrategies) {
            try { const subParams = { ...sub.defaults, candleType: p.candleType, htfEma: p.htfEma, htfRsiPeriod: p.htfRsiPeriod }; results[sub.id] = sub.run(candles, subParams, subCtx); }
            catch (e) { results[sub.id] = { signals: [], trades: [], htfTrend: null, ha: [] }; }
        }
        const n = candles.length;
        const atr = calculateATR(candles, p.atrPeriod);
        const firstHa = results.smc_unicorn.ha && results.smc_unicorn.ha.length ? results.smc_unicorn.ha : getDisplayCandles(candles, p.candleType || 'heikin');
        const signals = [], trades = [];
        let position = null, entry = null, cooldown = 0, lastTrend = null;
        for (let i = 0; i < n; i++) {
            const c = candles[i];
            let buyWeight = 0, buyCount = 0, exitWeight = 0, exitCount = 0;
            for (const sub of subStrategies) {
                if (sub.weight <= 0) continue;
                const subSigs = results[sub.id].signals;
                if (!subSigs || !subSigs[i]) continue;
                const s = subSigs[i];
                if (s.signalType === 'BUY') { buyWeight += sub.weight; buyCount++; }
                else if (s.signalType === 'EXIT_LONG') { exitWeight += sub.weight; exitCount++; }
            }
            for (const sub of subStrategies) { if (results[sub.id].htfTrend) { lastTrend = results[sub.id].htfTrend; break; } }
            const ind = { stop: entry ? round(entry.stop) : null, buyWeight: round(buyWeight), exitWeight: round(exitWeight) };
            let signalType = null, reason = null;
            if (position === 'LONG') {
                const bars = i - entry.idx;
                if (exitWeight >= p.threshold && exitCount >= p.minAgree) reason = `Ensemble EXIT: ${exitCount} (وزن ${exitWeight.toFixed(2)})`;
                else if (c.close < entry.stop) reason = `حد ضرر`;
                else if (bars >= p.maxHoldBars) reason = `سقف زمانی`;
                if (reason) {
                    position = null; signalType = 'EXIT_LONG';
                    const tr = trades[trades.length - 1];
                    if (tr) { tr.exitDate = c.time; tr.exitPrice = c.close; tr.pnlPct = (c.close / tr.entryPrice - 1) * 100; tr.exitReason = reason; }
                    entry = null; cooldown = p.cooldownBars;
                }
            } else {
                if (cooldown > 0) cooldown--;
                else if (buyWeight >= p.threshold && buyCount >= p.minAgree && atr[i] !== null) {
                    position = 'LONG'; signalType = 'BUY';
                    const stopPrice = c.close - p.atrMult * atr[i];
                    entry = { idx: i, price: c.close, stop: stopPrice };
                    ind.stop = round(stopPrice);
                    reason = `Ensemble BUY: ${buyCount} (وزن ${buyWeight.toFixed(2)})`;
                    trades.push({ type: 'خرید', entryDate: c.time, entryPrice: c.close, stop: stopPrice, reason, buyWeight, buyCount });
                }
            }
            signals.push({ time: c.time, indicators: ind, signalType, position, reason });
        }
        return { ha: firstHa, signals, trades, htfTrend: lastTrend };
    }

    // ==================== ۷. VWAP Bounce ====================
    const VWAP_DEFAULTS = {
        htfEma: 20, htfRsiPeriod: 14,
        atrPeriod: 14, atrMult: 1.5,
        maxHoldBars: 20, cooldownBars: 3,
        vwapTouchPct: 0.3,
        requireVwapSlope: 1,
        tp1R: 1.5, tp2R: 3.0,
        minVolumeMult: 0.8
    };
    function runVwapBounce(candles, params, ctx) {
        const p = { ...VWAP_DEFAULTS, ...(params || {}) };
        const ha = getDisplayCandles(candles, p.candleType || 'heikin');
        const atr = calculateATR(candles, p.atrPeriod);
        const htf = buildHtf(ctx, p), htfName = (ctx && ctx.htfTimeframe) || '1d';
        const signals = [], trades = [];
        let position = null, entry = null, cooldown = 0, lastTrend = null;
        const vwapCache = new Map();
        function getDayKey(t) {
            const d = getTehranParts(new Date(t * 1000));
            return `${d.year}-${d.month}-${d.day}`;
        }
        function buildVwap(i) {
            const c = candles[i];
            const dayKey = getDayKey(c.time);
            if (vwapCache.has(dayKey)) return vwapCache.get(dayKey);
            let sumPV = 0, sumV = 0;
            for (let k = i; k >= 0; k--) {
                const cc = candles[k];
                if (getDayKey(cc.time) !== dayKey) break;
                const vol = cc.volume || 1;
                const typical = (cc.high + cc.low + cc.close) / 3;
                sumPV += typical * vol;
                sumV += vol;
            }
            const vwap = sumV > 0 ? sumPV / sumV : c.close;
            vwapCache.set(dayKey, vwap);
            return vwap;
        }
        for (let i = 0; i < candles.length; i++) {
            const c = candles[i], h = ha[i];
            const row = htf.forTime(c.time), trend = row ? row.trend : null;
            if (trend) lastTrend = trend;
            const ind = { atr: round(atr[i]), stop: entry ? round(entry.stop) : null };
            if (i < Math.max(p.atrPeriod + 3, 20) || atr[i] === null) {
                signals.push({ time: c.time, indicators: ind, signalType: null, position, reason: null });
                continue;
            }
            const vwap = buildVwap(i);
            const distPct = (c.close - vwap) / vwap * 100;
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
                    const nearVwap = Math.abs(distPct) <= p.vwapTouchPct;
                    const bounce = h.bullish && c.close > vwap;
                    if (nearVwap && bounce) {
                        const entryPrice = c.close;
                        const stopPrice = vwap - p.atrMult * atr[i];
                        const risk = entryPrice - stopPrice;
                        if (risk > 0) {
                            position = 'LONG'; signalType = 'BUY';
                            entry = { idx: i, price: entryPrice, stop: stopPrice, risk, entry: entryPrice, tp1Hit: false, vwap };
                            ind.stop = round(stopPrice);
                            reason = `VWAP Bounce (VWAP=${Math.round(vwap)})`;
                            trades.push({ type: 'خرید', entryDate: c.time, entryPrice, stop: stopPrice, risk, reason });
                        }
                    }
                }
            }
            signals.push({ time: c.time, indicators: ind, signalType, position, reason });
        }
        return { ha, signals, trades, htfTrend: lastTrend };
    }

    // ==================== ۸. Supertrend ====================
    const ST_DEFAULTS = {
        htfEma: 20, htfRsiPeriod: 14,
        atrPeriod: 10, atrMult: 3.0,
        maxHoldBars: 25, cooldownBars: 2,
        tp1R: 1.5, tp2R: 3.0,
        requireVolumeConfirm: 0
    };
    function runSupertrend(candles, params, ctx) {
        const p = { ...ST_DEFAULTS, ...(params || {}) };
        const ha = getDisplayCandles(candles, p.candleType || 'heikin');
        const atr = calculateATR(candles, p.atrPeriod);
        const htf = buildHtf(ctx, p), htfName = (ctx && ctx.htfTimeframe) || '1d';
        const signals = [], trades = [];
        let position = null, entry = null, cooldown = 0, lastTrend = null;
        let stUpper = null, stLower = null, stDir = 1;
        for (let i = 0; i < candles.length; i++) {
            const c = candles[i], h = ha[i];
            const row = htf.forTime(c.time), trend = row ? row.trend : null;
            if (trend) lastTrend = trend;
            const ind = { atr: round(atr[i]), stop: entry ? round(entry.stop) : null, supertrendDir: stDir };
            if (i < p.atrPeriod + 3 || atr[i] === null) {
                signals.push({ time: c.time, indicators: ind, signalType: null, position, reason: null });
                continue;
            }
            const hl2 = (c.high + c.low) / 2;
            const upperBasic = hl2 + p.atrMult * atr[i];
            const lowerBasic = hl2 - p.atrMult * atr[i];
            if (stUpper === null) { stUpper = upperBasic; stLower = lowerBasic; stDir = 1; }
            else {
                stUpper = (upperBasic < stUpper || candles[i-1].close > stUpper) ? upperBasic : stUpper;
                stLower = (lowerBasic > stLower || candles[i-1].close < stLower) ? lowerBasic : stLower;
                if (stDir === 1 && c.close < stLower) stDir = -1;
                else if (stDir === -1 && c.close > stUpper) stDir = 1;
            }
            let signalType = null, reason = null;
            if (position === 'LONG') {
                const bars = i - entry.idx; const R = entry.risk;
                if (c.close < entry.stop) reason = 'حد ضرر';
                else if (!entry.tp1Hit && c.close >= entry.entry + R * p.tp1R) { entry.tp1Hit = true; entry.stop = entry.entry; }
                else if (entry.tp1Hit && c.close >= entry.entry + R * p.tp2R) reason = 'هدف دوم';
                else if (stDir === -1) reason = 'Supertrend برگشت';
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
                    if (stDir === 1 && candles[i-1].close <= stUpper && c.close > stUpper && h.bullish) {
                        const entryPrice = c.close;
                        const stopPrice = stLower;
                        const risk = entryPrice - stopPrice;
                        if (risk > 0) {
                            position = 'LONG'; signalType = 'BUY';
                            entry = { idx: i, price: entryPrice, stop: stopPrice, risk, entry: entryPrice, tp1Hit: false };
                            ind.stop = round(stopPrice);
                            reason = 'Supertrend Flip (صعودی)';
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
    const BBSQ_DEFAULTS = {
        htfEma: 20, htfRsiPeriod: 14,
        bbPeriod: 20, bbStd: 2.0,
        kcPeriod: 20, kcMult: 1.5,
        atrPeriod: 14, atrMult: 1.5,
        maxHoldBars: 25, cooldownBars: 2,
        tp1R: 1.5, tp2R: 3.0,
        minSqueezeBars: 3
    };
    function runBollingerSqueeze(candles, params, ctx) {
        const p = { ...BBSQ_DEFAULTS, ...(params || {}) };
        const ha = getDisplayCandles(candles, p.candleType || 'heikin');
        const closes = candles.map(c => c.close);
        const atr = calculateATR(candles, p.atrPeriod);
        const bb = calculateBollingerBands(closes, p.bbPeriod, p.bbStd);
        const htf = buildHtf(ctx, p), htfName = (ctx && ctx.htfTimeframe) || '1d';
        const signals = [], trades = [];
        let position = null, entry = null, cooldown = 0, lastTrend = null;
        const ema = calculateEMA(closes, p.kcPeriod);
        const kcUpper = ema.map((e, i) => e !== null && atr[i] !== null ? e + p.kcMult * atr[i] : null);
        const kcLower = ema.map((e, i) => e !== null && atr[i] !== null ? e - p.kcMult * atr[i] : null);
        let squeezeCount = 0;
        for (let i = 0; i < candles.length; i++) {
            const c = candles[i], h = ha[i];
            const row = htf.forTime(c.time), trend = row ? row.trend : null;
            if (trend) lastTrend = trend;
            const ind = { atr: round(atr[i]), stop: entry ? round(entry.stop) : null, squeeze: squeezeCount };
            if (i < Math.max(p.bbPeriod, p.kcPeriod, p.atrPeriod) + 3 || bb.upper[i] === null || kcUpper[i] === null) {
                signals.push({ time: c.time, indicators: ind, signalType: null, position, reason: null });
                continue;
            }
            const isSqueeze = bb.upper[i] < kcUpper[i] && bb.lower[i] > kcLower[i];
            if (isSqueeze) squeezeCount++;
            else squeezeCount = 0;
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
                    const wasSqueezed = squeezeCount >= p.minSqueezeBars;
                    const breakout = c.close > bb.upper[i] && h.bullish;
                    if (wasSqueezed && breakout) {
                        const entryPrice = c.close;
                        const stopPrice = bb.middle[i] - p.atrMult * atr[i];
                        const risk = entryPrice - stopPrice;
                        if (risk > 0) {
                            position = 'LONG'; signalType = 'BUY';
                            entry = { idx: i, price: entryPrice, stop: stopPrice, risk, entry: entryPrice, tp1Hit: false };
                            ind.stop = round(stopPrice);
                            reason = `BB Squeeze Breakout (${p.minSqueezeBars}+ کندل فشرده)`;
                            trades.push({ type: 'خرید', entryDate: c.time, entryPrice, stop: stopPrice, risk, reason });
                        }
                    }
                }
            }
            signals.push({ time: c.time, indicators: ind, signalType, position, reason });
        }
        return { ha, signals, trades, htfTrend: lastTrend };
    }

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

    // ==================== ۱۱. Keltner Pullback ====================
    const KCPB_DEFAULTS = {
        htfEma: 20, htfRsiPeriod: 14,
        kcPeriod: 20, kcMult: 1.5,
        atrPeriod: 14, atrMult: 1.5,
        maxHoldBars: 20, cooldownBars: 2,
        tp1R: 1.5, tp2R: 3.0,
        pullbackTouchPct: 0.5
    };
    function runKeltnerPullback(candles, params, ctx) {
        const p = { ...KCPB_DEFAULTS, ...(params || {}) };
        const ha = getDisplayCandles(candles, p.candleType || 'heikin');
        const closes = candles.map(c => c.close);
        const atr = calculateATR(candles, p.atrPeriod);
        const ema = calculateEMA(closes, p.kcPeriod);
        const kcUpper = ema.map((e, i) => e !== null && atr[i] !== null ? e + p.kcMult * atr[i] : null);
        const kcLower = ema.map((e, i) => e !== null && atr[i] !== null ? e - p.kcMult * atr[i] : null);
        const htf = buildHtf(ctx, p), htfName = (ctx && ctx.htfTimeframe) || '1d';
        const signals = [], trades = [];
        let position = null, entry = null, cooldown = 0, lastTrend = null;
        for (let i = 0; i < candles.length; i++) {
            const c = candles[i], h = ha[i];
            const row = htf.forTime(c.time), trend = row ? row.trend : null;
            if (trend) lastTrend = trend;
            const ind = { atr: round(atr[i]), stop: entry ? round(entry.stop) : null };
            if (i < Math.max(p.kcPeriod, p.atrPeriod) + 3 || kcLower[i] === null) {
                signals.push({ time: c.time, indicators: ind, signalType: null, position, reason: null });
                continue;
            }
            const distToLower = (c.low - kcLower[i]) / kcLower[i] * 100;
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
                    const touchedLower = distToLower <= p.pullbackTouchPct;
                    const bounce = h.bullish && c.close > kcLower[i];
                    if (touchedLower && bounce) {
                        const entryPrice = c.close;
                        const stopPrice = kcLower[i] - p.atrMult * atr[i];
                        const risk = entryPrice - stopPrice;
                        if (risk > 0) {
                            position = 'LONG'; signalType = 'BUY';
                            entry = { idx: i, price: entryPrice, stop: stopPrice, risk, entry: entryPrice, tp1Hit: false };
                            ind.stop = round(stopPrice);
                            reason = 'Keltner Pullback';
                            trades.push({ type: 'خرید', entryDate: c.time, entryPrice, stop: stopPrice, risk, reason });
                        }
                    }
                }
            }
            signals.push({ time: c.time, indicators: ind, signalType, position, reason });
        }
        return { ha, signals, trades, htfTrend: lastTrend };
    }

    // ==================== رجیستری ====================
    const STRATEGIES = {
        // 🟢 استراتژی‌های معتبر (WF PASS)
        smc_unicorn: { id: 'smc_unicorn', name: 'SMC Unicorn', defaultTimeframe: '1h', htfTimeframe: '1d', defaultParams: SMC_DEFAULTS, indicators: { overlay: ['stop'], panel: [] }, run: runSMCUnicorn },
        ob_sweep: { id: 'ob_sweep', name: 'OB + Sweep', defaultTimeframe: '1h', htfTimeframe: '1d', defaultParams: OB_DEFAULTS, indicators: { overlay: ['stop'], panel: [] }, run: runOBSweep },
        supply_demand: { id: 'supply_demand', name: 'Supply & Demand', defaultTimeframe: '30m', htfTimeframe: '1d', defaultParams: SDZ_DEFAULTS, indicators: { overlay: ['stop'], panel: [] }, run: runSupplyDemand },
        ob_after_sweep: { id: 'ob_after_sweep', name: 'OB After Sweep', defaultTimeframe: '1h', htfTimeframe: '1d', defaultParams: OBAS_DEFAULTS, indicators: { overlay: ['stop'], panel: [] }, run: runOBAfterSweep },
        orb: { id: 'orb', name: 'Opening Range Breakout', defaultTimeframe: '15m', htfTimeframe: '1d', defaultParams: ORB_DEFAULTS, indicators: { overlay: ['stop'], panel: [] }, run: runORB },
        ensemble: { id: 'ensemble', name: 'Ensemble (ترکیبی)', defaultTimeframe: '30m', htfTimeframe: '1d', defaultParams: ENSEMBLE_DEFAULTS, indicators: { overlay: ['stop'], panel: [] }, run: runEnsemble },

        // 🆕 استراتژی‌های جدید
        vwap_bounce: { id: 'vwap_bounce', name: 'VWAP Bounce', defaultTimeframe: '15m', htfTimeframe: '1d', defaultParams: VWAP_DEFAULTS, indicators: { overlay: ['stop'], panel: [] }, run: runVwapBounce },
        supertrend: { id: 'supertrend', name: 'Supertrend', defaultTimeframe: '30m', htfTimeframe: '1d', defaultParams: ST_DEFAULTS, indicators: { overlay: ['stop'], panel: [] }, run: runSupertrend },
        bb_squeeze: { id: 'bb_squeeze', name: 'BB Squeeze Breakout', defaultTimeframe: '30m', htfTimeframe: '1d', defaultParams: BBSQ_DEFAULTS, indicators: { overlay: ['stop'], panel: [] }, run: runBollingerSqueeze },
        donchian: { id: 'donchian', name: 'Donchian Breakout', defaultTimeframe: '1h', htfTimeframe: '1d', defaultParams: DONCH_DEFAULTS, indicators: { overlay: ['stop'], panel: [] }, run: runDonchianBreakout },
        keltner_pb: { id: 'keltner_pb', name: 'Keltner Pullback', defaultTimeframe: '30m', htfTimeframe: '1d', defaultParams: KCPB_DEFAULTS, indicators: { overlay: ['stop'], panel: [] }, run: runKeltnerPullback }

        // ⛔ حذف‌شده — WF gate fail:
        // rsi50_2 (PF=0.17), pin_bar (PF=0.32), london_breakout (PF=0.44)
    };

    function getRequiredCandles(id, params) {
        const p = { ...(STRATEGIES[id] ? STRATEGIES[id].defaultParams : {}), ...(params || {}) };
        if (id === 'smc_unicorn') return Math.max(p.swingLength + 5, p.atrPeriod + 3, p.maxHoldBars);
        if (id === 'ob_sweep') return Math.max(p.swingLength + p.obLookback + 5, p.atrPeriod + 3, p.maxHoldBars);
        if (id === 'supply_demand') return Math.max(p.zoneLookback + p.baseBars + 5, p.atrPeriod + 3);
        if (id === 'ob_after_sweep') return Math.max(p.swingLength + p.obLookback + p.sweepWithinBars + 5, p.atrPeriod + 3);
        if (id === 'orb') return 40;
        if (id === 'vwap_bounce') return 30;
        if (id === 'supertrend') return Math.max(p.atrPeriod, p.htfEma) + 10;
        if (id === 'bb_squeeze') return Math.max(p.bbPeriod, p.kcPeriod, p.atrPeriod) + 10;
        if (id === 'donchian') return Math.max(p.entryPeriod, p.exitPeriod, p.atrPeriod) + 10;
        if (id === 'keltner_pb') return Math.max(p.kcPeriod, p.atrPeriod) + 10;
        if (id === 'ensemble') {
            const subIds = ['smc_unicorn', 'ob_sweep', 'ob_after_sweep', 'supply_demand', 'orb', 'vwap_bounce', 'supertrend', 'bb_squeeze', 'donchian', 'keltner_pb'];
            return Math.max(...subIds.map(sid => getRequiredCandles(sid, p)));
        }
        return 10;
    }
    function getRequiredHtfCandles(id, params) {
        const p = { ...(STRATEGIES[id] ? STRATEGIES[id].defaultParams : {}), ...(params || {}) };
        return Math.max(p.htfEma || 20, p.htfRsiPeriod || 14) + 2;
    }

    return {
        calculateHeikinAshi, calculateSimpleCandles, getDisplayCandles,
        calculateRSI, calculateEMA, calculateATR,
        calculateMACD, calculateBollingerBands, calculateIchimoku,
        aggregateCandles, TIMEFRAME_MINUTES, getRequiredCandles, getRequiredHtfCandles,
        runSMCUnicorn, runOBSweep, runSupplyDemand,
        runOBAfterSweep, runORB, runEnsemble,
        runVwapBounce, runSupertrend, runBollingerSqueeze, runDonchianBreakout, runKeltnerPullback,
        SMC_DEFAULTS, OB_DEFAULTS, SDZ_DEFAULTS,
        OBAS_DEFAULTS, ORB_DEFAULTS, ENSEMBLE_DEFAULTS,
        VWAP_DEFAULTS, ST_DEFAULTS, BBSQ_DEFAULTS, DONCH_DEFAULTS, KCPB_DEFAULTS,
        STRATEGIES
    };
});