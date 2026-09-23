'use strict';
// ============================================================
// options.js — منطق آپشن (خالص)
// ============================================================
// این ماژول:
//   - Black-Scholes + Greeks
//   - محاسبه IV ضمنی
//   - امتیازدهی و انتخاب قرارداد
//   - مدیریت پوزیشن
//   - بک‌تست آپشن (real + approximate)
//
// هیچ وابستگی به Mongo یا HTTP نداره.
// همه dependency ها از طریق init() تزریق می‌شن.
// ============================================================

const { TRADING_DAYS_PER_YEAR } = require('../config/constants');

// ============================================================
// Dependencies (تزریق می‌شن)
// ============================================================
let deps = {
    getDB: null,             // () => MongoDB
    notify: null,            // (text) => Promise<void>
    settings: null,          // { get, capital, riskAmount, ... }
    timeframeMinutes: {},    // { '30m': 30, ... }
    todayDateString: null,   // () => 'YYYY-MM-DD'
    getQuote: null,          // (symbol) => { price, queue } | null
    getUnderlyingNames: null // (symbol) => [names]
};

function init(d) {
    deps = { ...deps, ...d };
}

function requireDep(name) {
    if (!deps[name]) throw new Error(`options.js: dependency "${name}" تزریق نشده`);
    return deps[name];
}

// ============================================================
// Constants
// ============================================================
const DEFAULT_SETTINGS = {
    minDays: 15, maxDays: 45,
    maxSpreadPct: 7,
    minOI: 200, minTrades: 1,
    minPremium: 200,
    deltaMin: 0.40, deltaMax: 0.75,
    maxIvHv: 1.5,
    rewardRisk: 3.0,
    topN: 3,
    optionStopPct: 20,
    take1Pct: 50, take2Pct: 100,
    closeDaysBefore: 5
};

const OPT_BT_DEFAULTS = {
    assumedMaturityDays: 30,
    ivMultiplier: 1.20,
    spreadPct: 10,
    deltaMin: 0.40, deltaMax: 0.75,
    minDays: 15, maxDays: 45,
    volCrushFactor: 3.0,
    minIvCrush: 0.35,
    spreadMoveMult: 3.0,
    maxReturnPct: 150,
    minExitDays: 0.5,
    realEnabled: true,
    // 🆕 Phase 2: Realism
    closeHaircutPct: 0.025,       // 2.5% نصف اسپرد تخمینی (وقتی bid/ask نیست)
    timeWindowDays: 1,            // 🆕 پنجره‌ی جستجو (قبلاً 3 روز)
    dynSlipBase: 0.001,           // 0.1% slippage پایه
    dynSlipImpactCoef: 0.5,       // ضریب Almgren-Chriss
    minFillRatio: 0.05,           // حداقل نسبت پر شدن (5%)
    maxParticipation: 0.2,        // حداکثر 20% از حجم روز
    latencySec: 1                 // تأخیر ورود/خروج
};

const RELAX_LEVELS = [
    { name: 'A+', tag: null, overrides: {} },
    { name: 'A', tag: null, overrides: { minOI: 150, minTrades: 1, maxSpreadPct: 9, deltaMin: 0.35, deltaMax: 0.82 } },
    { name: 'B', tag: 'کیفیت B', overrides: { minOI: 80, minTrades: 1, maxSpreadPct: 12, deltaMin: 0.30, deltaMax: 0.88, maxIvHv: 1.8 } },
    { name: 'C', tag: 'کیفیت C', overrides: { minOI: 30, minTrades: 0, maxSpreadPct: 16, deltaMin: 0.25, deltaMax: 0.92, maxIvHv: 2.2, minPremium: 100 } },
    { name: 'D', tag: 'کیفیت D', overrides: { minOI: 0, minTrades: 0, maxSpreadPct: 22, deltaMin: 0.20, deltaMax: 0.95, maxIvHv: 2.8, minPremium: 50 } }
];

// ============================================================
// Normalization
// ============================================================
const norm = s => String(s || '')
    .replace(/ي/g, 'ی').replace(/ك/g, 'ک')
    .replace(/[\u200c\u200e\u200f\s\u00a0]/g, '')
    .trim();

const num = v => {
    const n = parseFloat(String(v ?? '').replace(/,/g, ''));
    return Number.isFinite(n) ? n : 0;
};
const round = v => (v === null || v === undefined) ? null : Math.round(v * 100) / 100;
const f0 = n => Math.round(n).toLocaleString('en-US');
const pc = v => v === null || v === undefined ? '-' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;

// ============================================================
// 🆕 Phase 2: Realism helpers
// ============================================================

/**
 * قیمت خرید واقع‌گرایانه
 * - اگه ask واقعی هست → استفاده کن
 * - وگرنه close/last با haircut مثبت (چون ask > close معمولاً)
 */
function realisticBuyPrice(row, haircutPct) {
    if (!row) return null;
    if (row.ask > 0) return { price: row.ask, isReal: true, source: 'ask' };
    const base = row.close > 0 ? row.close : (row.last > 0 ? row.last : 0);
    if (!base) return null;
    return { price: base * (1 + haircutPct), isReal: false, source: row.close > 0 ? 'close' : 'last' };
}

/**
 * قیمت فروش واقع‌گرایانه
 * - اگه bid واقعی هست → استفاده کن
 * - وگرنه close/last با haircut منفی (چون bid < close معمولاً)
 */
function realisticSellPrice(row, haircutPct) {
    if (!row) return null;
    if (row.bid > 0) return { price: row.bid, isReal: true, source: 'bid' };
    const base = row.close > 0 ? row.close : (row.last > 0 ? row.last : 0);
    if (!base) return null;
    return { price: base * (1 - haircutPct), isReal: false, source: row.close > 0 ? 'close' : 'last' };
}

/**
 * Slippage داینامیک (Almgren-Chriss سبک)
 * - نسبت سفارش به حجم روز → impact ∝ sqrt(ratio)
 * - نقدینگی کم → جریمه بالاتر
 */
function computeDynamicSlippage(orderSize, dailyVolume, p) {
    const base = p.dynSlipBase || 0.001;
    const coef = p.dynSlipImpactCoef || 0.5;
    if (!dailyVolume || dailyVolume <= 0) {
        // نقدینگی صفر → جریمه‌ی سنگین (اسکالپ نمی‌شه)
        return base + 0.015;
    }
    const ratio = Math.min(1, orderSize / dailyVolume);
    const impact = coef * Math.sqrt(ratio) * 0.01;
    return base + impact;
}

/**
 * محاسبه‌ی نرخ پر شدن سفارش
 * - اگه حجم روز خیلی کمه → فقط بخشی fill می‌شه
 */
function computeFillRatio(orderSize, dailyVolume, maxParticipation) {
    if (!dailyVolume || dailyVolume <= 0) return 0;
    const maxFill = dailyVolume * (maxParticipation || 0.2);
    return Math.min(1, maxFill / orderSize);
}

/**
 * 🆕 Time-Decay Aware: کاهش قیمت به خاطر theta در طول نگه‌داری
 * برای trade های intraday که exit در همون روزه
 */
function applyIntradayThetaDecay(entryPrice, entryTime, exitTime, thetaDay, daysLeft) {
    const heldSec = Math.max(0, exitTime - entryTime);
    const heldDays = heldSec / 86400;
    if (heldDays < 0.01 || !thetaDay || thetaDay >= 0) return entryPrice;
    // فقط بخش کسری از theta روزانه رو اعمال کن
    const intradayDecay = Math.abs(thetaDay) * heldDays;
    // capped: نباید بیشتر از 30% قیمت رو ببره
    const maxDecay = entryPrice * 0.3;
    return entryPrice - Math.min(intradayDecay, maxDecay);
}

// ============================================================
// Black-Scholes
// ============================================================
function normCdf(x) {
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const d = 0.3989423 * Math.exp(-x * x / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return x >= 0 ? 1 - p : p;
}

function bsCall(S, K, T, r, sig) {
    if (T <= 0) {
        const v = Math.max(S - K * Math.exp(-r * Math.max(T, 0)), 0);
        return { price: v, delta: S > K ? 1 : 0, thetaDay: 0, vega: 0, gamma: 0 };
    }
    if (!(sig > 0.01)) sig = 0.01;
    const sq = Math.sqrt(T);
    const d1 = (Math.log(S / K) + (r + sig * sig / 2) * T) / (sig * sq);
    const d2 = d1 - sig * sq;
    const Nd1 = normCdf(d1), Nd2 = normCdf(d2);
    const pdf = Math.exp(-d1 * d1 / 2) / Math.sqrt(2 * Math.PI);

    return {
        price: S * Nd1 - K * Math.exp(-r * T) * Nd2,
        delta: Nd1,
        gamma: pdf / (S * sig * sq),
        thetaDay: (-(S * pdf * sig) / (2 * sq) - r * K * Math.exp(-r * T) * Nd2) / 365,
        vega: S * pdf * sq / 100
    };
}

function impliedVol(price, S, K, T, r) {
    if (!(price > 0) || T <= 0) return null;
    if (price <= Math.max(S - K * Math.exp(-r * T), 0) * 1.001) return null;
    let lo = 0.01, hi = 5;
    for (let i = 0; i < 60; i++) {
        const m = (lo + hi) / 2;
        if (bsCall(S, K, T, r, m).price > price) hi = m; else lo = m;
    }
    return (lo + hi) / 2;
}

// ============================================================
// Volatility helpers
// ============================================================
async function hvFromDaily(symbol, n = 20) {
    const db = requireDep('getDB')();
    const rows = await db.collection('candles_daily')
        .find({ symbol }).sort({ time: -1 }).limit(n + 1).toArray();
    if (rows.length < n + 1) return null;

    const closes = rows.reverse().map(r => r.close).filter(x => x > 0);
    const rets = [];
    for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
    if (rets.length < 5) return null;

    const m = rets.reduce((a, b) => a + b, 0) / rets.length;
    const v = rets.reduce((a, b) => a + (b - m) ** 2, 0) / (rets.length - 1);
    return Math.sqrt(v * TRADING_DAYS_PER_YEAR);
}

function historicalHV(closes, uptoIndex, n = 20) {
    const start = Math.max(0, uptoIndex - n);
    const slice = closes.slice(start, uptoIndex + 1);
    if (slice.length < 6) return null;
    const rets = [];
    for (let i = 1; i < slice.length; i++) rets.push(Math.log(slice[i] / slice[i - 1]));
    const m = rets.reduce((a, b) => a + b, 0) / rets.length;
    const v = rets.reduce((a, b) => a + (b - m) ** 2, 0) / (rets.length - 1);
    return Math.sqrt(v * TRADING_DAYS_PER_YEAR);
}

// ============================================================
// Settings
// ============================================================
let settingsCache = null;

async function getSettings(force = false) {
    if (settingsCache && !force) return settingsCache;
    const db = requireDep('getDB')();
    const doc = await db.collection('meta').findOne({ _id: 'option_settings' });
    settingsCache = { ...DEFAULT_SETTINGS, ...((doc && doc.values) || {}) };
    return settingsCache;
}

async function saveSettings(values) {
    const clean = {};
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
        if (values[k] !== undefined && Number.isFinite(+values[k])) clean[k] = +values[k];
    }
    const db = requireDep('getDB')();
    await db.collection('meta').updateOne(
        { _id: 'option_settings' },
        { $set: { values: clean } },
        { upsert: true }
    );
    return getSettings(true);
}

function getRiskFree() {
    // 🆕 اول از cache روزانه (risk-free.job)
    if (deps.settings && typeof deps.settings.getRiskFreeRate === 'function') {
        const r = deps.settings.getRiskFreeRate();
        if (Number.isFinite(r) && r > 0) return r;
    }
    // Fallback: مقدار ثابت settings
    const s = deps.settings ? deps.settings.get() : {};
    return s.RISK_FREE_RATE || 0.23;
}
function getFeeBuy() {
    const s = deps.settings ? deps.settings.get() : {};
    return s.OPTION_FEE_BUY || 0.0012;
}
function getFeeSell() {
    const s = deps.settings ? deps.settings.get() : {};
    return s.OPTION_FEE_SELL || 0.0012;
}

// ============================================================
// Underlying matching
// ============================================================
function matchUnderlying(contractUnderlying, names) {
    if (!contractUnderlying) return false;
    const cu = norm(contractUnderlying);
    for (const n of names) {
        const nn = norm(n);
        if (!nn) continue;
        if (cu === nn) return true;
        if (nn.length >= 4 && cu.length >= 4) {
            if (cu.includes(nn) || nn.includes(cu)) return true;
        }
    }
    return false;
}

function getNames(symbol) {
    if (deps.getUnderlyingNames) return deps.getUnderlyingNames(symbol);
    return [norm(symbol)];
}

// ============================================================
// Contract metrics
// ============================================================
function metrics(c, S, hv) {
    const RISK_FREE = getRiskFree();
    const T = Math.max(c.daysLeft, 0.5) / 365;
    const mid = c.bid > 0 && c.ask > 0 ? (c.bid + c.ask) / 2 : 0;
    const spreadPct = mid > 0 ? (c.ask - c.bid) / mid * 100 : null;
    const vol = hv || c.hvApi || 0.4;
    const theo = bsCall(S, c.strike, T, RISK_FREE, vol);

    let iv = c.ivApi;
    if (!iv || iv <= 0) iv = impliedVol(c.ask > 0 ? c.ask : c.last, S, c.strike, T, RISK_FREE);

    return {
        T, mid, spreadPct,
        hv: vol,
        theo: theo.price,
        theoApi: c.bsApi || null,
        delta: theo.delta, deltaApi: c.deltaApi || null,
        gamma: theo.gamma, gammaApi: c.gammaApi || null,
        thetaDay: theo.thetaDay, thetaApi: c.thetaApi || null,
        vega: theo.vega, vegaApi: c.vegaApi || null,
        iv, ivApi: c.ivApi || null,
        ivHv: iv ? iv / vol : null,
        leverage: c.ask > 0 ? theo.delta * S / c.ask : null,
        moneynessPct: (S / c.strike - 1) * 100,
        intrinsic: Math.max(S - c.strike, 0),
        timeValue: c.ask > 0 ? Math.max(c.ask - Math.max(S - c.strike, 0), 0) : null
    };
}

function rejectReasons(c, m, s) {
    const R = [];
    if (c.daysLeft < s.minDays) R.push('سررسید نزدیک');
    else if (c.daysLeft > s.maxDays) R.push('سررسید دور');
    if (!(c.bid > 0 && c.ask > 0)) R.push('سفارش دوطرفه ندارد');
    else if (m.spreadPct > s.maxSpreadPct) R.push('اسپرد بالا');
    if (c.oi < s.minOI) R.push('OI کم');
    if (c.trades < s.minTrades) R.push('بدون معامله امروز');
    if (c.ask > 0 && c.ask < s.minPremium) R.push('پرمیوم خیلی کم');
    if (m.delta < s.deltaMin) R.push('دلتا پایین');
    else if (m.delta > s.deltaMax) R.push('دلتا بالا');
    if (m.ivHv && m.ivHv > s.maxIvHv) R.push('IV گران');
    return R;
}

function breakevenMove(S, K, T2, sig, cost, halfSpread) {
    const RISK_FREE = getRiskFree();
    const FEE_SELL = getFeeSell();
    const f = x => Math.max(bsCall(x, K, T2, RISK_FREE, sig).price - halfSpread, 0) * (1 - FEE_SELL) - cost;
    let lo = S * 0.5, hi = S * 2;
    if (f(hi) < 0) return null;
    if (f(lo) > 0) return (lo / S - 1) * 100;
    for (let i = 0; i < 50; i++) {
        const m = (lo + hi) / 2;
        if (f(m) > 0) hi = m; else lo = m;
    }
    return ((lo + hi) / 2 / S - 1) * 100;
}

function rejectionScore(c, m, R, effective) {
    let score = 0;
    if (R.includes('OI کم')) score += Math.max(0, (effective.minOI - c.oi) / Math.max(effective.minOI, 1)) * 100;
    if (R.includes('اسپرد بالا')) score += Math.max(0, (m.spreadPct - effective.maxSpreadPct)) * 5;
    if (R.includes('دلتا پایین')) score += Math.max(0, (effective.deltaMin - m.delta)) * 500;
    if (R.includes('دلتا بالا')) score += Math.max(0, (m.delta - effective.deltaMax)) * 500;
    if (R.includes('IV گران')) score += Math.max(0, (m.ivHv - effective.maxIvHv)) * 100;
    return score;
}

function scoreContract(c, sc, s, effective) {
    const RISK_FREE = getRiskFree();
    const FEE_BUY = getFeeBuy();
    const FEE_SELL = getFeeSell();

    const S = sc.S || c.S;
    const m = metrics(c, S, sc.hv);
    const R = rejectReasons(c, m, effective);
    if (R.length) return { ok: false, reasons: R, m };

    const h = Math.min(sc.horizonDays, Math.max(c.daysLeft - 1, 1));
    const T2 = Math.max((c.daysLeft - h) / 365, 1 / 365);
    const sig = m.iv || m.hv;
    const cost = c.ask * (1 + FEE_BUY);
    const half = (c.ask - c.bid) / 2;
    const exitAdj = v => Math.max(v - half, 0) * (1 - FEE_SELL);

    const pt = exitAdj(bsCall(sc.target, c.strike, T2, RISK_FREE, sig).price) - cost;
    const pl = exitAdj(bsCall(sc.stop, c.strike, T2, RISK_FREE, sig).price) - cost;
    const pf = exitAdj(bsCall(S, c.strike, T2, RISK_FREE, sig).price) - cost;

    const rr = pl < 0 ? pt / -pl : (pt > 0 ? 99 : 0);
    const liq = Math.pow(Math.min(1, c.oi / 1000), 0.25) * (1 - (m.spreadPct / effective.maxSpreadPct) * 0.4);
    const ivPen = m.ivHv ? Math.max(0.6, Math.min(1, 1.3 / m.ivHv)) : 1;

    const pick = {
        symbol: c.symbol, fullName: c.fullName,
        strike: c.strike, expiry: c.expiry, daysLeft: c.daysLeft,
        ask: c.ask, bid: c.bid,
        askVol: c.askVol, bidVol: c.bidVol, last: c.last,
        oi: c.oi, oiChange: c.oiChange,
        volume: c.volume, trades: c.trades, size: c.size,
        spreadPct: m.spreadPct,
        theo: m.theo, theoApi: m.theoApi,
        intrinsic: m.intrinsic, timeValue: m.timeValue,
        iv: m.iv, ivApi: m.ivApi, hv: m.hv, ivHv: m.ivHv,
        delta: m.delta, deltaApi: m.deltaApi,
        gamma: m.gamma, gammaApi: m.gammaApi,
        thetaDay: m.thetaDay, thetaApi: m.thetaApi,
        vega: m.vega, vegaApi: m.vegaApi,
        leverage: m.leverage, moneynessPct: m.moneynessPct,
        profitPct: pt / cost * 100,
        lossPct: pl / cost * 100,
        flatPct: pf / cost * 100,
        rr,
        bePct: breakevenMove(S, c.strike, T2, sig, cost, half),
        score: rr * liq * ivPen,
        S
    };
    pick.positionSize = 1;
    return { ok: true, pick, m };
}

// ============================================================
// Contract selection
// ============================================================
function selectCalls(chain, underlying, sc, s) {
    const names = Array.isArray(underlying) ? underlying : [underlying];
    const cands = chain.filter(c => c.isCall && matchUnderlying(c.underlying, names));

    if (!cands.length) {
        return {
            picks: [], considered: 0, passed: 0, rejected: {},
            level: null, nearMisses: [], relaxed: false,
            matchedNames: names, totalChain: chain.length
        };
    }

    const nearMissesAll = [];

    for (const level of RELAX_LEVELS) {
        const effective = { ...s, ...level.overrides };
        const rejected = {};
        const scored = [];

        for (const c of cands) {
            const S = sc.S || c.S;
            const m = metrics(c, S, sc.hv);
            const res = scoreContract(c, sc, s, effective);

            if (!res.ok) {
                res.reasons.forEach(x => rejected[x] = (rejected[x] || 0) + 1);
                if (level.name === 'A+') {
                    nearMissesAll.push({
                        symbol: c.symbol, strike: c.strike, expiry: c.expiry, daysLeft: c.daysLeft,
                        ask: c.ask, bid: c.bid, oi: c.oi, trades: c.trades,
                        spreadPct: m.spreadPct, delta: m.delta, ivHv: m.ivHv,
                        reasons: res.reasons,
                        distance: rejectionScore(c, m, res.reasons, effective)
                    });
                }
                continue;
            }
            res.pick.level = level.name;
            scored.push(res.pick);
        }

        if (scored.length) {
            scored.sort((a, b) => b.score - a.score);
            return {
                picks: scored.slice(0, s.topN),
                considered: cands.length,
                passed: scored.length,
                rejected,
                level: level.name,
                tag: level.tag,
                relaxed: level.name !== 'A+',
                nearMisses: [],
                matchedNames: names,
                totalChain: chain.length
            };
        }
    }

    nearMissesAll.sort((a, b) => a.distance - b.distance);
    return {
        picks: [], considered: cands.length, passed: 0, rejected: {},
        level: null, tag: null, relaxed: false,
        nearMisses: nearMissesAll.slice(0, 5),
        matchedNames: names, totalChain: chain.length
    };
}

// ============================================================
// Scenario building
// ============================================================
function horizonDaysFor(config) {
    const bars = (config.params && config.params.maxHoldBars) || 10;
    const tfMin = deps.timeframeMinutes[config.timeframe] || 30;
    const tradingDays = tfMin >= 1440 ? bars : Math.max(1, Math.ceil(bars * tfMin / 210));
    return Math.max(2, Math.ceil(tradingDays * 7 / 5));
}

async function buildScenario(config, price, liveS, indicators, s) {
    const stop = indicators && indicators.stop;
    const atr = indicators && indicators.atr;
    const risk = stop && stop < price ? price - stop : atr ? 2 * atr : price * 0.03;

    return {
        S: liveS || price,
        entry: price,
        stop: price - risk,
        target: price + risk * s.rewardRisk,
        horizonDays: horizonDaysFor(config),
        hv: await hvFromDaily(config.symbol)
    };
}

// ============================================================
// Portfolio / position sizing
// ============================================================
async function getPortfolioState() {
    const db = requireDep('getDB')();
    const open = await db.collection('option_positions').find({ status: 'open' }).toArray();
    const bySymbol = {};
    let totalExposure = 0;

    for (const p of open) {
        const value = (p.entryAsk || 0) * (p.positionSize || 1) * (p.size || 1000);
        bySymbol[p.underlying] = (bySymbol[p.underlying] || 0) + value;
        totalExposure += value;
    }

    const capital = deps.settings.capital();
    return {
        totalCapital: capital,
        totalExposure,
        availableCash: capital - totalExposure,
        exposurePct: capital > 0 ? (totalExposure / capital * 100) : 0,
        openCount: open.length,
        bySymbol
    };
}

async function calcPositionSizeV3(pick, scenario, currentPortfolio, signalStrength, config) {
    const settings = deps.settings.get();
    const capital = deps.settings.capital();
    const riskAmt = deps.settings.riskAmount();
    const maxSymbol = deps.settings.maxSymbolExposure();
    const maxTotal = deps.settings.maxTotalExposure();
    const maxSize = settings.MAX_POSITION_SIZE || 10;

    const contractValue = pick.ask * (pick.size || 1000);
    if (!(contractValue > 0)) return { size: 0, reason: 'قیمت قرارداد نامعتبر', baseSize: 0 };

    // 🆕 Market Impact: اگه حجم سفارش بزرگ‌تر از حجم سرخط باشه
    const askVol = pick.askVol || 0;
    const requestedShares = 1 * (pick.size || 1000);
    const liquidityRatio = askVol > 0 ? requestedShares / askVol : 0;

    const impactPct = Math.min(0.05, liquidityRatio * 0.02);
    const effectiveContractValue = contractValue * (1 + impactPct);

    const baseSize = riskAmt / effectiveContractValue;
    const confluence = (signalStrength && signalStrength.confluence) || 1;
    const signalFac = deps.settings.signalFactor(confluence);
    const level = pick.level || 'A+';
    const levelFac = deps.settings.levelFactor(level);
    const ivFac = deps.settings.ivFactor(pick.ivHv);

    // 🆕 ضریب عمق دیتا — نمادهای با دیتای کمتر، وزن کمتر
    const dataDays = (config && Number.isFinite(config.dataDays)) ? config.dataDays : 90;
    const dataFac = deps.settings.dataDepthFactor(dataDays);

    // 🆕 محدودیت نقدینگی
    const maxFromLiquidity = askVol > 0
        ? Math.floor((askVol * 0.2) / (pick.size || 1000))
        : 999;

    const adjusted = Math.round(baseSize * signalFac * levelFac * ivFac * dataFac);

    const currentSymbolExposure = (currentPortfolio && currentPortfolio.bySymbol && currentPortfolio.bySymbol[pick.underlying]) || 0;
    const remainingSymbol = Math.max(0, maxSymbol - currentSymbolExposure);
    const bySymbol = Math.floor(remainingSymbol / effectiveContractValue);

    const currentTotal = (currentPortfolio && currentPortfolio.totalExposure) || 0;
    const remainingTotal = Math.max(0, maxTotal - currentTotal);
    const byTotal = Math.floor(remainingTotal / effectiveContractValue);

    const finalSize = Math.max(0, Math.min(adjusted, bySymbol, byTotal, maxSize, maxFromLiquidity));

    let limitReason = null;
    if (finalSize < adjusted) {
        if (maxFromLiquidity < adjusted && maxFromLiquidity <= bySymbol && maxFromLiquidity <= byTotal)
            limitReason = 'نقدینگی سرخط کافی نیست (impact)';
        else if (bySymbol < adjusted && bySymbol <= byTotal) limitReason = 'سقف درگیری این نماد پر شده';
        else if (byTotal < adjusted) limitReason = 'سقف کل درگیری پر شده';
        else if (maxSize < adjusted) limitReason = 'به حداکثر تعداد قرارداد رسیده';
    }
    if (finalSize === 0) {
        if (maxFromLiquidity === 0) limitReason = 'نقدینگی سرخط صفر است';
        else if (bySymbol === 0) limitReason = 'سقف درگیری این نماد پر شده';
        else if (byTotal === 0) limitReason = 'سقف کل درگیری پر شده';
        else if (baseSize < 0.5) limitReason = 'سرمایه برای این قرارداد کافی نیست';
    }

    return {
        size: finalSize,
        baseSize: Math.floor(baseSize),
        signalFactor: round(signalFac),
        levelFactor: round(levelFac),
        ivFactor: round(ivFac),
        dataFactor: round(dataFac),   // 🆕
        dataDays,                      // 🆕
        level, confluence, adjusted,
        bySymbol, byTotal, maxSize,
        maxFromLiquidity,
        impactPct: round(impactPct * 100),
        liquidityRatio: round(liquidityRatio * 100),
        contractValue,
        effectiveContractValue: round(effectiveContractValue),
        limitReason,
        limits: {
            riskAmount: riskAmt,
            maxSymbolExposure: maxSymbol,
            maxTotalExposure: maxTotal,
            currentSymbolExposure,
            currentTotalExposure: currentTotal
        }
    };
}

function suggestOrderPlan(pick, targetSize) {
    const askVol = pick.askVol || 0, askPrice = pick.ask;
    const totalShares = targetSize * (pick.size || 1000);

    if (askVol >= totalShares) {
        return { canFillAtAsk: true, plans: [{ shares: totalShares, price: askPrice }], note: null };
    }

    const plans = [];
    if (askVol > 0) plans.push({ shares: askVol, price: askPrice });
    const remaining = totalShares - askVol;
    if (remaining > 0) plans.push({ shares: remaining, price: Math.round(askPrice * 1.03), estimated: true });

    return {
        canFillAtAsk: false,
        plans,
        note: `حجم سرخط (${askVol.toLocaleString()} سهم) کمتر از نیاز (${totalShares.toLocaleString()} سهم) است - پله ای خرید کن`
    };
}

// ============================================================
// Recommendation text
// ============================================================
function formatRecommendation(symbol, sc, res, portfolio, signalStrength, title = 'انتخاب قرارداد کال') {
    let t = `${title} - ${symbol}\n`;
    if (signalStrength && signalStrength.confluence > 1) t += `هم گرایی ${signalStrength.confluence} استراتژی\n`;
    if (signalStrength && signalStrength.confirmers && signalStrength.confirmers.length) t += `تایید: ${signalStrength.confirmers.join('، ')}\n`;
    t += `سناریو: ورود ${f0(sc.entry)} | حد ضرر ${f0(sc.stop)} | هدف ${f0(sc.target)} | افق ~${sc.horizonDays} روز${sc.hv ? ` | HV ${(sc.hv * 100).toFixed(0)}%` : ''}\n`;

    if (res.level && res.level !== 'A+') t += `\nسطح فیلتر: ${res.level}${res.tag ? ' - ' + res.tag : ''}\n`;

    if (!res.picks.length) {
        t += `قرارداد مناسبی یافت نشد (${res.considered} بررسی شد)\n`;
        if (res.nearMisses && res.nearMisses.length) {
            t += `\nنزدیک ترین گزینه ها:\n`;
            res.nearMisses.forEach((n, i) => {
                t += `${i + 1}) ${n.symbol} | اعمال ${f0(n.strike)} | ${n.daysLeft} روز\n`;
                t += `   OI ${n.oi} | معاملات ${n.trades} | اسپرد ${n.spreadPct ? n.spreadPct.toFixed(1) + '%' : '-'} | دلتا ${n.delta ? n.delta.toFixed(2) : '-'}\n`;
                t += `   دلایل رد: ${n.reasons.join('، ')}\n`;
            });
        }
        return t;
    }

    res.picks.forEach((p, i) => {
        t += `\n${i + 1}) ${p.symbol} | اعمال ${f0(p.strike)} | ${p.expiry} (${p.daysLeft} روز)\n`;
        t += `   خرید: ${f0(p.ask)} | فروش: ${f0(p.bid)} | اسپرد ${p.spreadPct.toFixed(1)}%\n`;
        t += `   حجم سرخط خرید: ${(p.askVol || 0).toLocaleString()} سهم\n`;
        t += `   دلتا ${p.delta.toFixed(2)} | گاما ${p.gamma ? p.gamma.toFixed(4) : '-'} | تتا/روز ${f0(p.thetaDay)} | وگا ${p.vega ? p.vega.toFixed(2) : '-'}\n`;
        t += `   IV ${p.iv ? (p.iv * 100).toFixed(0) + '%' : '-'}${p.ivHv ? ` (${p.ivHv.toFixed(2)}xHV)` : ''} | OI ${p.oi}${p.oiChange ? ` (${p.oiChange > 0 ? '+' : ''}${p.oiChange})` : ''} | حجم ${p.volume}\n`;
        t += `   پرمیوم: ${f0(p.ask)} | ارزش ذاتی: ${f0(p.intrinsic)} | ارزش زمانی: ${f0(p.timeValue)} | اهرم: ${p.leverage ? p.leverage.toFixed(2) : '-'}\n`;
        t += `   هدف آپشن: ${pc(p.profitPct)} | حد ضرر: ${pc(p.lossPct)} | RR ${p.rr.toFixed(2)}\n`;
        if (p.bePct !== null && p.bePct !== undefined) t += `   سربه سر: حرکت ${p.bePct.toFixed(1)}% سهم\n`;

        if (p.positionInfo) {
            const pi = p.positionInfo;
            if (pi.size > 0) {
                t += `   حجم پیشنهادی: ${pi.size} قرارداد\n`;
                const plan = suggestOrderPlan(p, pi.size);
                if (plan.note) {
                    t += `   ${plan.note}\n`;
                    t += `   پیشنهاد خرید:\n`;
                    plan.plans.forEach(pl => {
                        t += `      - ${pl.shares.toLocaleString()} سهم در ${f0(pl.price)}${pl.estimated ? ' (تخمینی)' : ''}\n`;
                    });
                } else {
                    t += `   می توانی کل ${(pi.size * (p.size || 1000)).toLocaleString()} سهم را در ${f0(p.ask)} بخری\n`;
                }
                if (pi.limitReason) t += `   ${pi.limitReason}\n`;
            } else {
                t += `   حجم صفر - ${pi.limitReason || 'محدودیت'}\n`;
            }
        }
    });

    if (portfolio) {
        t += `\nسرمایه: ${f0(portfolio.totalCapital)} | درگیری فعلی: ${portfolio.exposurePct.toFixed(1)}% | نقد: ${f0(portfolio.availableCash)}\n`;
    }
    return t;
}

// ============================================================
// Signal handler
// ============================================================
async function onBuySignal({ config, indicators, price, liveS, tradeId, confluence = 1, confirmers = [] }) {
    const s = await getSettings();
    const chain = await requireDep('getChain')();
    const sc = await buildScenario(config, price, liveS, indicators, s);
    const names = getNames(config.symbol);
    const res = selectCalls(chain, names, sc, s);
    const portfolio = await getPortfolioState();
    const signalStrength = { confluence, confirmers };

    for (const p of res.picks) {
        try {
            const pi = await calcPositionSizeV3({ ...p, underlying: config.symbol }, sc, portfolio, signalStrength, config);
            p.positionSize = pi.size;
            p.positionInfo = pi;
        } catch (_) {
            p.positionSize = 0;
            p.positionInfo = null;
        }
    }

    await requireDep('notify')(formatRecommendation(config.symbol, sc, res, portfolio, signalStrength));

    if (res.picks.length) {
        const p = res.picks[0];
        if (!p.positionSize || p.positionSize <= 0) return res;

        const db = requireDep('getDB')();
        const existing = await db.collection('option_positions').findOne({
            configId: config._id.toString(), status: 'open'
        });
        if (existing) {
            await db.collection('option_positions').updateOne(
                { _id: existing._id },
                { $set: { status: 'closed', exitTime: new Date(), exitReason: 'رول به قرارداد جدید' } }
            );
        }

        await db.collection('option_positions').insertOne({
            configId: config._id.toString(),
            tradeId: tradeId ? tradeId.toString() : null,
            underlying: config.symbol,
            underlyingNames: names,
            symbol: p.symbol, fullName: p.fullName,
            strike: p.strike, expiry: p.expiry,
            entryTime: new Date(),
            entryAsk: p.ask, entryBid: p.bid, entryLast: p.last,
            entryS: p.S, entryIv: p.iv, entryDelta: p.delta,
            entryGamma: p.gamma, entryTheta: p.thetaDay, entryVega: p.vega,
            entryOi: p.oi, entryVolume: p.volume, entrySpreadPct: p.spreadPct,
            entryDaysLeft: p.daysLeft,
            size: p.size,
            positionSize: p.positionSize,
            entryValue: p.ask * p.positionSize * (p.size || 1000),
            level: p.level,
            scenario: sc,
            paper: true,
            status: 'open',
            confluence,
            stagedExits: []
        });
    }
    return res;
}

async function recommendForState(config, state) {
    const s = await getSettings();
    const chain = await require('./options-chain-bridge').getChain();
    const sc = await buildScenario(config, state.price, state.livePrice, state.indicators, s);
    const names = getNames(config.symbol);
    return { scenario: sc, ...selectCalls(chain, names, sc, s) };
}

// ============================================================
// Position management
// ============================================================
async function managePositions(chain) {
    const db = requireDep('getDB')();
    const s = await getSettings();
    const RISK_FREE = getRiskFree();
    const FEE_BUY = getFeeBuy();
    const FEE_SELL = getFeeSell();

    const open = await db.collection('option_positions').find({ status: 'open' }).toArray();
    if (!open.length) return;

    const map = new Map(chain.map(c => [c.symbol, c]));
    const longIds = new Set(
        (await db.collection('signals_state').find({ position: 'LONG' })
            .project({ configId: 1 }).toArray()).map(x => x.configId)
    );

    const monitored = await db.collection('monitored_symbols').find({}).toArray();
    const sellQueueSet = new Set();
    for (const m of monitored) {
        const q = deps.getQuote ? deps.getQuote(m.symbol) : null;
        if (q && q.queue === 'sell') sellQueueSet.add(m.symbol);
    }

    const now = new Date();
    const tehranMin = now.getUTCHours() * 60 + now.getUTCMinutes() + 210;
    const isLast30Min = tehranMin >= 720 && tehranMin <= 750;

    for (const p of open) {
        const c = map.get(p.symbol);
        if (!c) {
            if (!p.missingWarned) {
                await requireDep('notify')(`قرارداد ${p.symbol} در داده آپشن یافت نشد.`);
                await db.collection('option_positions').updateOne(
                    { _id: p._id }, { $set: { missingWarned: true } }
                );
            }
            continue;
        }

        const exitPx = c.bid > 0 ? c.bid : c.last;
        const cost = p.entryAsk * (1 + FEE_BUY);
        const pnlPct = (exitPx * (1 - FEE_SELL) / cost - 1) * 100;
        const T = Math.max(c.daysLeft, 0.5) / 365;
        const iv = impliedVol(
            (c.bid > 0 && c.ask > 0) ? (c.bid + c.ask) / 2 : c.last,
            c.S, c.strike, T, RISK_FREE
        );
        const spreadPct = c.bid > 0 && c.ask > 0 ? (c.ask - c.bid) / ((c.ask + c.bid) / 2) * 100 : null;
        const m = metrics(c, c.S, null);

        const upd = {
            lastBid: c.bid, lastAsk: c.ask, lastS: c.S,
            lastPnlPct: pnlPct, lastIv: iv,
            lastDelta: m.delta, lastTheta: m.thetaDay,
            lastOi: c.oi, lastVolume: c.volume,
            lastSpreadPct: spreadPct,
            lastDaysLeft: c.daysLeft,
            lastCheck: new Date()
        };

        let reason = null;
        const staged = p.stagedExits || [];
        const taken1 = staged.includes(1), taken2 = staged.includes(2);

        if (!reason && pnlPct >= s.take1Pct && !taken1) {
            upd.stagedExits = [...staged, 1];
            await requireDep('notify')(`${p.symbol} | سود ${pnlPct.toFixed(0)}% - فروش 33% موقعیت (پله 1)`);
        }
        if (!reason && pnlPct >= s.take2Pct && !taken2) {
            upd.stagedExits = [...(upd.stagedExits || staged), 2];
            await requireDep('notify')(`${p.symbol} | سود ${pnlPct.toFixed(0)}% - فروش 33% موقعیت (پله 2)`);
        }

        if (!longIds.has(p.configId)) reason = 'سیگنال خروج یا لغو روی سهم پایه';
        else if (c.daysLeft <= s.closeDaysBefore) reason = `${c.daysLeft} روز تا سررسید`;
        else if (pnlPct <= -s.optionStopPct) reason = `حد ضرر آپشن (${pnlPct.toFixed(0)}%)`;
        else if (pnlPct >= s.take2Pct && taken2) reason = `حد سود کامل (${pnlPct.toFixed(0)}%)`;

        const warns = [];
        if (sellQueueSet.has(p.underlying)) warns.push(`نماد پایه در صف فروش است - برای بستن آپشن باید منتظر باز شدن صف بمانی`);
        if (!reason && pnlPct >= s.take1Pct && !p.take1Notified) {
            warns.push(`سود ${pnlPct.toFixed(0)}% - پیشنهاد: فروش نیمی`);
            upd.take1Notified = true;
        }
        if (!reason && p.entryIv && iv && iv < p.entryIv * 0.8 && !p.ivWarned) {
            warns.push(`IV از ${(p.entryIv * 100).toFixed(0)}% به ${(iv * 100).toFixed(0)}% افت کرد`);
            upd.ivWarned = true;
        }
        if (!reason && spreadPct !== null && spreadPct > 15 && !p.spreadWarned) {
            warns.push(`اسپرد ${spreadPct.toFixed(0)}%`);
            upd.spreadWarned = true;
        }
        if (isLast30Min && !reason && !p.timeWarned) {
            warns.push(`30 دقیقه آخر بازار`);
            upd.timeWarned = true;
        }

        if (reason) {
            Object.assign(upd, {
                status: 'closed', exitTime: new Date(),
                exitBid: exitPx, exitS: c.S, pnlPct, exitReason: reason
            });

            let roll = '';
            if (longIds.has(p.configId) && c.daysLeft <= s.closeDaysBefore && p.scenario) {
                const names = p.underlyingNames && p.underlyingNames.length ? p.underlyingNames : [norm(p.underlying)];
                const r = selectCalls(chain, names, { ...p.scenario, S: c.S }, s);
                if (r.picks.length) {
                    const q = r.picks[0];
                    roll = `\nپیشنهاد رول: ${q.symbol} اعمال ${f0(q.strike)} سررسید ${q.expiry} (${q.daysLeft} روز) خرید ${f0(q.ask)}`;
                }
            }

            await requireDep('notify')(`بستن کال ${p.symbol} (${p.underlying})\nدلیل: ${reason}\nورود ${f0(p.entryAsk)} -> خروج ${f0(exitPx)} | بازده ${pc(pnlPct)}\nسهم پایه: ${f0(p.entryS)} -> ${f0(c.S)} (${pc((c.S / p.entryS - 1) * 100)})${roll}`);
        } else if (warns.length) {
            await requireDep('notify')(`${p.symbol} (${p.underlying}) | بازده ${pc(pnlPct)}\n${warns.join('\n')}`);
        }

        await db.collection('option_positions').updateOne({ _id: p._id }, { $set: upd });
    }
}

const openPositionsCount = () =>
    requireDep('getDB')().collection('option_positions').countDocuments({ status: 'open' });

// ============================================================
// Storage helpers
// ============================================================
const wanted = (c, set) => c.isCall && set.has(c.underlying) && (c.oi > 0 || c.trades > 0);

async function storeSnapshots(chain, monitoredSet) {
    const time = new Date();
    const docs = chain.filter(c => wanted(c, monitoredSet)).map(c => ({
        symbol: c.symbol, underlying: c.underlying, time,
        S: c.S, last: c.last, bid: c.bid, ask: c.ask,
        oi: c.oi, volume: c.volume, trades: c.trades
    }));
    if (docs.length) {
        await requireDep('getDB')().collection('option_snapshots').insertMany(docs, { ordered: false });
    }
    return docs.length;
}

async function storeFullOptionHistory(chain, monitoredSet) {
    const time = new Date();
    const docs = chain.filter(c => wanted(c, monitoredSet)).map(c => ({
        symbol: c.symbol, underlying: c.underlying,
        strike: c.strike, expiry: c.expiry, daysLeft: c.daysLeft, time,
        S: c.S, bid: c.bid, ask: c.ask, last: c.last,
        bidVol: c.bidVol, askVol: c.askVol,
        oi: c.oi, volume: c.volume, trades: c.trades,
        ivApi: c.ivApi, hvApi: c.hvApi,
        deltaApi: c.deltaApi, gammaApi: c.gammaApi,
        thetaApi: c.thetaApi, vegaApi: c.vegaApi, bsApi: c.bsApi
    }));
    if (docs.length) {
        try {
            await requireDep('getDB')().collection('option_history').insertMany(docs, { ordered: false });
        } catch (_) {}
    }
    return docs.length;
}

async function storeEOD(chain, monitoredSet) {
    const date = deps.todayDateString ? deps.todayDateString() : new Date().toISOString().slice(0, 10);
    const col = requireDep('getDB')().collection('option_daily');
    let n = 0;
    for (const c of chain.filter(c => wanted(c, monitoredSet))) {
        const m = metrics(c, c.S, null);
        await col.updateOne(
            { symbol: c.symbol, date },
            { $set: {
                symbol: c.symbol, underlying: c.underlying, date,
                strike: c.strike, expiry: c.expiry, daysLeft: c.daysLeft,
                S: c.S, last: c.last, final: c.final, bid: c.bid, ask: c.ask,
                oi: c.oi, volume: c.volume, value: c.value, trades: c.trades,
                iv: m.iv, delta: m.delta, hvApi: c.hvApi
            }},
            { upsert: true }
        );
        n++;
    }
    return n;
}

// ============================================================
// Backtest — real & approximate
// ============================================================
async function tryGetRealTradeData(symbol, t, p) {
    const db = requireDep('getDB')();
    const RISK_FREE = getRiskFree();
    const FEE_BUY = getFeeBuy();
    const FEE_SELL = getFeeSell();

    // از لحظه ورود/خروج واقعی استفاده کن (بعد از close کندل)
    const entrySec = t.entryFillTime || t.entryTime;
    const exitSec  = t.exitFillTime  || t.exitTime;
    const entryDate = new Date(entrySec * 1000);
    const exitDate  = new Date(exitSec  * 1000);

    // پنجره بزرگ‌تر — 30 دقیقه به جای 5
    const WINDOW_MS = 30 * 60 * 1000;

    const entryCandidates = await db.collection('option_history').find({
        underlying: norm(symbol),
        time: { $gte: new Date(entryDate.getTime() - WINDOW_MS), $lte: new Date(entryDate.getTime() + WINDOW_MS) },
        daysLeft: { $gte: p.minDays, $lte: p.maxDays },
        bid: { $gt: 0 }, ask: { $gt: 0 }, oi: { $gt: 0 }
    }).toArray();

    if (!entryCandidates.length) return null;

    const targetDelta = 0.55;
    let best = null, bestDiff = Infinity;
    for (const c of entryCandidates) {
        const delta = c.deltaApi || 0;
        if (delta < p.deltaMin || delta > p.deltaMax) continue;
        const diff = Math.abs(delta - targetDelta);
        if (diff < bestDiff) { bestDiff = diff; best = c; }
    }
    if (!best) return null;

    const exitRows = await db.collection('option_history').find({
        symbol: best.symbol,
        time: { $gte: new Date(exitDate.getTime() - WINDOW_MS), $lte: new Date(exitDate.getTime() + WINDOW_MS) }
    }).toArray();

    let exitBid = null, exitRow = null;
    if (exitRows.length) {
        exitBid = exitRows[0].bid;
        exitRow = exitRows[0];
    } else {
        const lastRow = await db.collection('option_history').find({
            symbol: best.symbol, time: { $lt: exitDate }
        }).sort({ time: -1 }).limit(1).toArray();
        if (lastRow.length) { exitBid = lastRow[0].bid; exitRow = lastRow[0]; }
    }
    if (!exitBid) return null;

    // 🆕 fallback: اگه ask/bid نداریم، از close/last استفاده کن
    const bestBase = best.close > 0 ? best.close : (best.last > 0 ? best.last : 0);
    const effectiveEntryAsk = best.ask > 0 ? best.ask : bestBase;
    if (effectiveEntryAsk <= 0) return null;

    const exitBase = exitRow && exitRow.close > 0 ? exitRow.close
                   : exitRow && exitRow.last > 0 ? exitRow.last
                   : exitBid;
    const effectiveExitBid = (exitRow && exitRow.bid > 0) ? exitRow.bid : exitBase;
    if (effectiveExitBid <= 0) return null;

    const entryCost = effectiveEntryAsk * (1 + FEE_BUY);
    const exitProceeds = effectiveExitBid * (1 - FEE_SELL);
    const spreadPct = best.bid > 0 && best.ask > 0
        ? (best.ask - best.bid) / ((best.ask + best.bid) / 2) * 100 : null;

    return {
        entryTime: t.entryTime, exitTime: t.exitTime,
        stockEntry: t.entryPrice, stockExit: t.exitPrice,
        symbol: best.symbol, strike: best.strike, expiry: best.expiry, daysLeft: best.daysLeft,
        optionEntry: best.ask, optionExit: exitBid,
        optionEntryBid: best.bid, optionExitAsk: exitRow ? exitRow.ask : null,
        optionEntryLast: best.last, optionExitLast: exitRow ? exitRow.last : null,
        oi: best.oi, volume: best.volume, spreadPct,
        delta: best.deltaApi, gamma: best.gammaApi, theta: best.thetaApi, vega: best.vegaApi,
        iv: best.ivApi, hv: best.hvApi,
        ivHv: best.ivApi && best.hvApi ? best.ivApi / best.hvApi : null,
        pnlPct: (exitProceeds / entryCost - 1) * 100,
        exitReason: t.exitReason,
        source: 'real'
    };
}
// ============================================================
// 🆕 نسخه سریع tryGetRealTradeData — Phase 2 Realism
// ============================================================
const OPT_SLIPPAGE_PCT = 0.003;      // base (legacy)
const OPT_IMPACT_PCT = 0.001;        // base (legacy)
const OPT_LATENCY_SEC = 1;           // legacy

function tryGetRealTradeDataFast(symbol, t, p, rowsBySymbol) {
    const FEE_BUY = getFeeBuy();
    const FEE_SELL = getFeeSell();

    // 🆕 Latency با p.latencySec
    const latency = p.latencySec || 1;
    const entrySec = (t.entryFillTime || t.entryTime) + latency;
    const exitSec  = (t.exitFillTime  || t.exitTime)  + latency;

    // 🆕 پنجره‌ی محدودتر (1 روز پیش‌فرض)
    const WINDOW_SEC = (p.timeWindowDays || 1) * 24 * 3600;

    // ---- انتخاب قرارداد ورود ----
    const candidateRows = [];
    for (const [sym, rows] of rowsBySymbol) {
        for (const r of rows) {
            const sec = Math.floor(new Date(r.time).getTime() / 1000);
            if (sec < entrySec - WINDOW_SEC || sec > entrySec + WINDOW_SEC) continue;
            if (r.bid > 0 || r.ask > 0 || r.close > 0 || r.last > 0) {
                candidateRows.push(r);
            }
        }
    }
    if (!candidateRows.length) return null;

    const targetDelta = 0.55;
    const valid = candidateRows.filter(c => {
        const d = c.deltaApi;
        if (d === null || d === undefined) return false;
        return d >= p.deltaMin && d <= p.deltaMax;
    });
    if (!valid.length) return null;

    valid.sort((a, b) => {
        const da = Math.abs((a.deltaApi || 0) - targetDelta);
        const db = Math.abs((b.deltaApi || 0) - targetDelta);
        if (Math.abs(da - db) > 0.01) return da - db;
        const secA = Math.floor(new Date(a.time).getTime() / 1000);
        const secB = Math.floor(new Date(b.time).getTime() / 1000);
        return Math.abs(secA - entrySec) - Math.abs(secB - entrySec);
    });

    const best = valid[0];

    // ---- انتخاب رکورد خروج (نزدیک‌ترین) ----
    const contractRows = rowsBySymbol.get(best.symbol) || [];
    let exitRow = null, exitDist = Infinity;
    for (const r of contractRows) {
        const sec = Math.floor(new Date(r.time).getTime() / 1000);
        if (sec < exitSec - WINDOW_SEC || sec > exitSec + WINDOW_SEC) continue;
        if (!(r.bid > 0 || r.close > 0 || r.last > 0)) continue;
        const dist = Math.abs(sec - exitSec);
        if (dist < exitDist) { exitDist = dist; exitRow = r; }
    }
    if (!exitRow) return null;

    // ---- 🆕 قیمت‌های واقع‌گرایانه ----
    const haircut = p.closeHaircutPct || 0.025;
    const entry = realisticBuyPrice(best, haircut);
    const exit  = realisticSellPrice(exitRow, haircut);
    if (!entry || !exit) return null;

    // ---- 🆕 Slippage داینامیک ----
    const orderSize = best.size || 1000;
    const dailyVol = best.volume || 0;
    const dynSlip = computeDynamicSlippage(orderSize, dailyVol, p);

    // ---- 🆕 پر شدن سفارش ----
    const fillRatio = computeFillRatio(orderSize, dailyVol, p.maxParticipation);
    if (fillRatio < (p.minFillRatio || 0.05)) {
        return null;
    }

    // ---- قیمت‌های نهایی ----
    const entryFillPrice = entry.price * (1 + dynSlip);
    const exitFillPrice  = exit.price  * (1 - dynSlip);

    // ---- 🆕 Intraday theta decay ----
    const heldDays = (exitSec - entrySec) / 86400;
    let thetaDecay = 0;
    if (!entry.isReal && best.thetaApi && heldDays < 1) {
        const thetaPct = Math.abs(best.thetaApi) / Math.max(entry.price, 1);
        const intradayFraction = Math.min(1, heldDays / 1);
        thetaDecay = entry.price * thetaPct * intradayFraction * 0.5;
    }
    const finalEntryPrice = entryFillPrice + thetaDecay;

    const entryCost = finalEntryPrice * (1 + FEE_BUY);
    const exitProceeds = exitFillPrice * (1 - FEE_SELL);

    const spreadPct = best.bid > 0 && best.ask > 0
        ? (best.ask - best.bid) / ((best.ask + best.bid) / 2) * 100
        : (best.close > 0 && best.bid > 0 ? (best.close - best.bid) / best.close * 100 : null);

    return {
        entryTime: t.entryTime, exitTime: t.exitTime,
        entryFillTime: entrySec, exitFillTime: exitSec,
        stockEntry: t.entryPrice, stockExit: t.exitPrice,
        symbol: best.symbol, strike: best.strike, expiry: best.expiry, daysLeft: best.daysLeft,

        entrySource: entry.source, exitSource: exit.source,
        entryWasReal: entry.isReal, exitWasReal: exit.isReal,

        optionEntryRaw: entry.price, optionExitRaw: exit.price,
        optionEntry: finalEntryPrice, optionExit: exitFillPrice,

        slippagePct: dynSlip * 100,
        thetaDecay: thetaDecay,
        fillRatio: fillRatio * 100,
        latencySec: latency,

        oi: best.oi, volume: best.volume, spreadPct,
        delta: best.deltaApi, gamma: best.gammaApi, theta: best.thetaApi, vega: best.vegaApi,
        iv: best.ivApi, hv: best.hvApi,
        ivHv: best.ivApi && best.hvApi ? best.ivApi / best.hvApi : null,
        pnlPct: (exitProceeds / entryCost - 1) * 100,
        exitReason: t.exitReason,
        source: 'real'
    };
}

function tryGetApproxTradeData(t, closes, times, p) {
    const RISK_FREE = getRiskFree();
    const FEE_BUY = getFeeBuy();
    const FEE_SELL = getFeeSell();

    let idx = -1;
    for (let i = 0; i < times.length; i++) {
        if (times[i] <= t.entryTime) idx = i; else break;
    }
    const hv = (idx >= 0 ? historicalHV(closes, idx) : null) || 0.4;
    const sigmaBase = Math.max(hv * p.ivMultiplier, 0.05);
    const daysHeld = Math.max((t.exitTime - t.entryTime) / 86400, 0.1);

    const moveRatio = Math.abs(t.exitPrice / t.entryPrice - 1);
    const ivCrushFactor = Math.max(p.minIvCrush, 1 - moveRatio * p.volCrushFactor);
    const sigmaExit = sigmaBase * ivCrushFactor;

    const dynamicSpreadPct = p.spreadPct * (1 + moveRatio * p.spreadMoveMult);
    const halfSpreadEntry = p.spreadPct / 200;
    const halfSpreadExit = dynamicSpreadPct / 200;

    const Tentry = p.assumedMaturityDays / 365;
    const Texit = Math.max(p.assumedMaturityDays - daysHeld, p.minExitDays) / 365;
    const strike = Math.round(t.entryPrice);

    const entryTheo = bsCall(t.entryPrice, strike, Tentry, RISK_FREE, sigmaBase);
    const exitTheo = bsCall(t.exitPrice, strike, Texit, RISK_FREE, sigmaExit);

    // 🆕 Slippage داینامیک (چون حجم تقریبیه، از form بازه‌ی متوسط استفاده می‌کنیم)
    const dynSlip = (p.dynSlipBase || 0.001) + (p.dynSlipImpactCoef || 0.5) * 0.5 * 0.01;

    const entryFillPrice = entryTheo.price
        * (1 + halfSpreadEntry + dynSlip);
    const exitFillPrice = exitTheo.price
        * (1 - halfSpreadExit - dynSlip);

    const entryCost = entryFillPrice * (1 + FEE_BUY);
    const exitProceeds = exitFillPrice * (1 - FEE_SELL);
    if (!(entryCost > 0) || !isFinite(exitProceeds)) return null;

    let pnlPct = (exitProceeds / entryCost - 1) * 100;
    if (pnlPct > p.maxReturnPct) pnlPct = p.maxReturnPct;

    return {
        entryTime: t.entryTime, exitTime: t.exitTime,
        stockEntry: t.entryPrice, stockExit: t.exitPrice,
        strike, hv, sigma: sigmaBase, sigmaExit, ivCrushFactor,
        dynamicSpreadPct,
        optionEntryRaw: entryTheo.price,
        optionExitRaw: exitTheo.price,
        optionEntry: entryFillPrice,
        optionExit: exitFillPrice,
        optionEntryBid: entryFillPrice * (1 - halfSpreadEntry),
        optionExitAsk: exitFillPrice * (1 + halfSpreadExit),
        slippagePct: dynSlip * 100,
        delta: entryTheo.delta, deltaExit: exitTheo.delta,
        gamma: entryTheo.gamma, theta: entryTheo.thetaDay, vega: entryTheo.vega,
        iv: sigmaBase, ivHv: sigmaBase / hv,
        pnlPct,
        exitReason: t.exitReason,
        source: 'approximate'
    };
}

async function runHybridOptionBacktest(symbol, closedTrades, opts = {}) {
    const db = requireDep('getDB')();
    const p = { ...OPT_BT_DEFAULTS, ...opts };

    if (!closedTrades.length) {
        return {
            assumptions: p,
            stats: { count: 0, winRate: 0, avgPnl: 0, totalPnl: 0, profitFactor: null, avgWin: 0, avgLoss: 0, maxWin: 0, maxLoss: 0 },
            trades: [], mode: 'hybrid',
            realUsed: 0, approxUsed: 0, hasAnyOptionData: false,
            diagnostic: 'هیچ معامله بسته شده ای تولید نشده.'
        };
    }

    const sampleCount = await db.collection('option_history')
        .countDocuments({ underlying: norm(symbol) });
    const hasAnyOptionData = sampleCount > 0;
    const realEnabled = p.realEnabled !== false;

    // ---------- Prefetch: یه query به جای N query ----------
    let optionRowsBySymbolTime = new Map();
    if (realEnabled && hasAnyOptionData) {
        try {
            const allSec = [];
            for (const t of closedTrades) {
                allSec.push(t.entryFillTime || t.entryTime);
                allSec.push(t.exitFillTime || t.exitTime);
            }
            // 🆕 پنجره‌ی مبتنی بر p.timeWindowDays
            const WINDOW_MS = (p.timeWindowDays || 1) * 24 * 3600 * 1000 * 2;
            const minTime = new Date(Math.min(...allSec) * 1000 - WINDOW_MS);
            const maxTime = new Date(Math.max(...allSec) * 1000 + WINDOW_MS);

            // 🆕 قبول رکوردهایی که bid/ask دارن یا close>0 دارن
            const bulkRows = await db.collection('option_history').find({
                underlying: norm(symbol),
                time: { $gte: minTime, $lte: maxTime },
                daysLeft: { $gte: p.minDays, $lte: Math.max(p.maxDays, 200) },
                $or: [
                    { bid: { $gt: 0 }, ask: { $gt: 0 } },
                    { close: { $gt: 0 } },
                    { last: { $gt: 0 } }
                ]
            }).toArray();

            // group by symbol
            for (const r of bulkRows) {
                if (!optionRowsBySymbolTime.has(r.symbol)) {
                    optionRowsBySymbolTime.set(r.symbol, []);
                }
                optionRowsBySymbolTime.get(r.symbol).push(r);
            }
        } catch (_) { /* fallback به query per trade */ }
    }

    const daily = await db.collection('candles_daily')
        .find({ symbol }).sort({ time: 1 }).toArray();
    const closes = daily.map(r => r.close);
    const times = daily.map(r => Math.floor(new Date(r.time).getTime() / 1000));

    const trades = [];
    let realUsed = 0, approxUsed = 0;

    for (const t of closedTrades) {
        let result = null;
        if (realEnabled && hasAnyOptionData) {
            try {
                result = tryGetRealTradeDataFast(symbol, t, p, optionRowsBySymbolTime);
            } catch (_) { result = null; }
        }
        if (result) { trades.push(result); realUsed++; }
        else {
            const approx = tryGetApproxTradeData(t, closes, times, p);
            if (approx) { trades.push(approx); approxUsed++; }
        }
    }

    const wins = trades.filter(x => x.pnlPct > 0);
    const losses = trades.filter(x => x.pnlPct <= 0);
    const sum = a => a.reduce((s, x) => s + x.pnlPct, 0);
    const gp = sum(wins), gl = -sum(losses);
    const pf = gl > 0 ? gp / gl : (gp > 0 ? null : 0);
    const maxWin = trades.length ? Math.max(...trades.map(t => t.pnlPct)) : 0;
    const maxLoss = trades.length ? Math.min(...trades.map(t => t.pnlPct)) : 0;

    const result = {
        assumptions: p,
        stats: {
            count: trades.length,
            winRate: trades.length ? wins.length / trades.length * 100 : 0,
            avgPnl: trades.length ? sum(trades) / trades.length : 0,
            totalPnl: sum(trades),
            profitFactor: pf,
            avgWin: wins.length ? gp / wins.length : 0,
            avgLoss: losses.length ? -gl / losses.length : 0,
            maxWin, maxLoss,
            avgDaysHeld: trades.length
                ? trades.reduce((s, t) => s + (t.exitTime - t.entryTime) / 86400, 0) / trades.length
                : 0
        },
        trades, mode: 'hybrid',
        realUsed, approxUsed, hasAnyOptionData,
        coverage: closedTrades.length ? trades.length / closedTrades.length * 100 : 0
    };

    if (!trades.length) result.diagnostic = 'هیچ معامله ای در بک تست تولید نشد.';
    else if (realUsed > 0 && approxUsed > 0) result.diagnostic = `ترکیبی: ${realUsed} واقعی + ${approxUsed} تقریبی`;
    else if (realUsed > 0) result.diagnostic = `همه ${realUsed} معامله از دیتای واقعی`;
    else result.diagnostic = `همه ${approxUsed} معامله تقریبی (volCrush ${p.volCrushFactor}، سقف ${p.maxReturnPct}%)`;

    return result;
}

// ============================================================
// Position stats
// ============================================================
function positionStats(list) {
    const closed = list.filter(p => p.status === 'closed' && typeof p.pnlPct === 'number');
    const wins = closed.filter(p => p.pnlPct > 0);
    const sum = a => a.reduce((x, p) => x + p.pnlPct, 0);
    const gp = sum(wins), gl = -sum(closed.filter(p => p.pnlPct <= 0));
    const pf = gl > 0 ? gp / gl : (gp > 0 ? null : 0);

    return {
        open: list.length - closed.length,
        closed: closed.length,
        winRate: closed.length ? wins.length / closed.length * 100 : 0,
        avgPnl: closed.length ? sum(closed) / closed.length : 0,
        totalPnl: sum(closed),
        profitFactor: pf,
        avgWin: wins.length ? gp / wins.length : 0,
        avgLoss: closed.length - wins.length ? -gl / (closed.length - wins.length) : 0
    };
}

// ============================================================
// Exports
// ============================================================
module.exports = {
    init,
    getRiskFree, getFeeBuy, getFeeSell,
    // helpers
    norm, num, round, f0, pc,
    // BS
    bsCall, impliedVol, normCdf,
    // volatility
    hvFromDaily, historicalHV,
    // settings
    getSettings, saveSettings, DEFAULT_SETTINGS,
    // contracts
    matchUnderlying, metrics, rejectReasons,
    selectCalls, buildScenario, horizonDaysFor,
    // recommendation
    formatRecommendation, suggestOrderPlan,
    // position sizing
    getPortfolioState, calcPositionSizeV3,
    // signal handlers
    onBuySignal, recommendForState, managePositions,
    openPositionsCount,
    // storage
    storeSnapshots, storeFullOptionHistory, storeEOD,
    // backtest
    runHybridOptionBacktest,
    runApproxOptionBacktest: (symbol, trades, opts) => runHybridOptionBacktest(symbol, trades, { ...opts, realEnabled: false }),
    runRealOptionBacktest: (symbol, trades, opts) => runHybridOptionBacktest(symbol, trades, { ...opts, realEnabled: true }),
    // stats
    positionStats,
    // constants
    OPT_BT_DEFAULTS
};