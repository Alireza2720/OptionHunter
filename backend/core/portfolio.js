'use strict';
// ============================================================
// portfolio.js — شبیه‌ساز پرتفولیو (Phase 3)
// ============================================================
// منطق: trades خام ورودی + capital limits → equity curve با محدودیت‌های واقعی
// - Capital reuse T+0
// - Symbol exposure limit
// - Total exposure limit
// - Cash reserve
// ============================================================

// ------------------------------------------------------------
// تنظیمات پیش‌فرض
// ------------------------------------------------------------
const DEFAULT_LIMITS = {
    capital: 100_000_000,        // ۱۰۰ میلیون تومان
    riskPct: 1.5,                 // ریسک هر معامله % سرمایه
    maxSymPct: 20,                // سقف درگیری هر نماد %
    maxTotalPct: 50,              // سقف کل درگیری %
    minCashPct: 20,               // حداقل نقد ذخیره %
    maxPositionSize: 10           // حداکثر تعداد قرارداد
};

// ------------------------------------------------------------
// محاسبه‌ی حجم پوزیشن (بدون وابستگی به settings)
// ------------------------------------------------------------
function calcPositionSize(trade, portfolio, limits) {
    const capital = limits.capital;
    const riskAmt = capital * (limits.riskPct / 100);
    const maxSym = capital * (limits.maxSymPct / 100);
    const maxTotal = capital * (limits.maxTotalPct / 100);

    const contractValue = (trade.optionEntry || 0) * (trade.size || 1000);
    if (!(contractValue > 0)) {
        return { size: 0, reason: 'قیمت قرارداد نامعتبر' };
    }

    // حجم پایه از ریسک
    const baseSize = Math.floor(riskAmt / contractValue);

    // سقف نماد
    const currentSym = portfolio.exposureBySymbol[trade.symbol] || 0;
    const remainSym = Math.max(0, maxSym - currentSym);
    const bySymbol = Math.floor(remainSym / contractValue);

    // سقف کل
    const remainTotal = Math.max(0, maxTotal - portfolio.totalExposure);
    const byTotal = Math.floor(remainTotal / contractValue);

    // سقف نقد موجود
    const availableCash = capital - portfolio.totalExposure;
    const byCash = Math.floor(availableCash / contractValue);

    // سقف تعداد
    const byMaxSize = limits.maxPositionSize;

    const finalSize = Math.max(0, Math.min(baseSize, bySymbol, byTotal, byCash, byMaxSize));

    let reason = null;
    if (finalSize === 0) {
        if (bySymbol === 0) reason = 'سقف درگیری نماد پر شده';
        else if (byTotal === 0) reason = 'سقف کل درگیری پر شده';
        else if (byCash === 0) reason = 'نقد کافی نیست';
        else if (baseSize === 0) reason = 'سرمایه برای این قرارداد کافی نیست';
        else reason = 'محدودیت';
    }

    return {
        size: finalSize,
        baseSize,
        bySymbol, byTotal, byCash,
        limitReason: reason
    };
}

// ------------------------------------------------------------
// تشخیص پایان پوزیشن (برای آزادسازی سرمایه)
// ------------------------------------------------------------
function computeExitTime(trade) {
    // اگه exitFillTime هست ازش استفاده کن، وگرنه exitTime
    return trade.exitFillTime || trade.exitTime || (trade.entryTime + 3600);
}

// ------------------------------------------------------------
// شبیه‌سازی کل پرتفولیو
// ------------------------------------------------------------
function simulate(trades, limitsInput = {}) {
    const limits = { ...DEFAULT_LIMITS, ...limitsInput };
    const capital = limits.capital;
    const minCash = capital * (limits.minCashPct / 100);

    // مرتب‌سازی بر اساس زمان ورود
    const sorted = [...trades].sort((a, b) => {
        const ta = a.entryFillTime || a.entryTime || 0;
        const tb = b.entryFillTime || b.entryTime || 0;
        return ta - tb;
    });

    // state پرتفولیو
    const portfolio = {
        cash: capital,
        totalExposure: 0,
        exposureBySymbol: {},
        openPositions: []   // {exitTime, value, symbol}
    };

    const acceptedTrades = [];
    const rejectedTrades = [];
    let equity = 100;
    let peakEquity = 100;
    let maxDD = 0;
    const equityCurve = [{ time: sorted.length ? (sorted[0].entryFillTime || sorted[0].entryTime) : 0, equity: 100 }];

    // تابع کمکی: آزادسازی پوزیشن‌های منقضی قبل از زمان داده‌شده
    function releaseExpired(nowTs) {
        const stillOpen = [];
        for (const p of portfolio.openPositions) {
            if (p.exitTime <= nowTs) {
                // آزادسازی
                portfolio.totalExposure -= p.value;
                portfolio.exposureBySymbol[p.symbol] =
                    Math.max(0, (portfolio.exposureBySymbol[p.symbol] || 0) - p.value);
                // سود/زیان نهایی هم در equity لحاظ شده بود موقع ثبت
            } else {
                stillOpen.push(p);
            }
        }
        portfolio.openPositions = stillOpen;
    }

    for (const t of sorted) {
        const entryTs = t.entryFillTime || t.entryTime || 0;
        const exitTs = computeExitTime(t);

        // آزادسازی پوزیشن‌های منقضی
        releaseExpired(entryTs);

        // محاسبه‌ی حجم
        const sizing = calcPositionSize(t, portfolio, limits);

        if (sizing.size <= 0) {
            rejectedTrades.push({
                symbol: t.symbol,
                strategyId: t.strategyId,
                entryTime: t.entryTime,
                skipReason: sizing.limitReason || 'حجم صفر',
                baseSize: sizing.baseSize
            });
            continue;
        }

        // ارزش پوزیشن
        const contractValue = (t.optionEntry || 0) * (t.size || 1000);
        const entryValue = contractValue * sizing.size;
        const posReturnPct = t.pnlPct || 0;
        const pnlAbs = entryValue * (posReturnPct / 100);

        // ثبت در پرتفولیو
        portfolio.totalExposure += entryValue;
        portfolio.exposureBySymbol[t.symbol] = (portfolio.exposureBySymbol[t.symbol] || 0) + entryValue;
        portfolio.openPositions.push({
            symbol: t.symbol,
            value: entryValue,
            exitTime: exitTs
        });

        // به‌روزرسانی equity
        equity *= (1 + posReturnPct / 100);
        if (equity > peakEquity) peakEquity = equity;
        const dd = ((peakEquity - equity) / peakEquity) * 100;
        if (dd > maxDD) maxDD = dd;

        acceptedTrades.push({
            symbol: t.symbol,
            strategyId: t.strategyId,
            strategyName: t.strategyName,
            entryTime: t.entryTime,
            exitTime: t.exitTime,
            positionSize: sizing.size,
            entryValue: Math.round(entryValue),
            pnlPct: posReturnPct,
            pnlAbs: Math.round(pnlAbs),
            equityAfter: equity,
            limitReason: null
        });

        equityCurve.push({ time: exitTs, equity: Math.round(equity * 100) / 100 });
    }

    // آمار پایانی
    const accepted = acceptedTrades;
    const wins = accepted.filter(t => t.pnlPct > 0);
    const losses = accepted.filter(t => t.pnlPct <= 0);
    const gp = wins.reduce((s, t) => s + t.pnlPct, 0);
    const gl = -losses.reduce((s, t) => s + t.pnlPct, 0);
    const pf = gl > 0 ? gp / gl : (gp > 0 ? Infinity : 0);

    // Sharpe
    const meanRet = accepted.length ? accepted.reduce((s, t) => s + t.pnlPct, 0) / accepted.length : 0;
    const variance = accepted.length > 1
        ? accepted.reduce((s, t) => s + (t.pnlPct - meanRet) ** 2, 0) / (accepted.length - 1)
        : 0;
    const sd = Math.sqrt(variance);
    const sharpe = sd > 0 ? (meanRet / sd) * Math.sqrt(accepted.length) : null;

    return {
        limits,
        totalTrades: sorted.length,
        acceptedTrades: acceptedTrades.length,
        rejectedTrades: rejectedTrades.length,
        trades: acceptedTrades,
        rejected: rejectedTrades,
        equityCurve,
        stats: {
            finalEquity: Math.round(equity * 100) / 100,
            totalReturnPct: Math.round((equity - 100) * 100) / 100,
            maxDD: Math.round(maxDD * 100) / 100,
            winRate: accepted.length ? (wins.length / accepted.length * 100) : 0,
            profitFactor: pf === Infinity ? null : pf,
            sharpe: sharpe !== null ? Math.round(sharpe * 100) / 100 : null,
            avgReturn: Math.round(meanRet * 100) / 100,
            peakExposure: Math.max(...acceptedTrades.map(t => t.entryValue), 0)
        }
    };
}

module.exports = {
    simulate,
    calcPositionSize,
    DEFAULT_LIMITS
};