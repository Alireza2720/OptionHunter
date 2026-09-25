'use strict';
// ============================================================
// signal-score.js — Signal Intelligence (Phase 4)
// ============================================================
// - Weighted confluence (diversity-based)
// - Signal strength score [0, 1]
// ============================================================

// ------------------------------------------------------------
// Diversity-weighted confluence
// ------------------------------------------------------------
// اگه ۳ تا config از یه استراتژی سیگنال بدن → وزن کمتر
// اگه ۳ تا config از ۳ استراتژی مختلف → وزن کامل
function diversityWeightedConfluence(confirmers) {
    // confirmers: [{ strategyId, role }]
    if (!confirmers || !confirmers.length) return { effective: 0, raw: 0, diversity: 0 };

    const byStrategy = {};
    for (const c of confirmers) {
        const sid = c.strategyId || 'unknown';
        byStrategy[sid] = (byStrategy[sid] || 0) + 1;
    }

    let effective = 0;
    for (const [sid, count] of Object.entries(byStrategy)) {
        // هر استراتژی: مجموع وزن = 1 (نه به تعداد config)
        // یعنی ۳ config از smc_unicorn → 1.0 (نه 3.0)
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
// Signal Strength Score [0, 1]
// ------------------------------------------------------------
// ترکیب: htf trend + atr + rsi (اگه بود) + confluence + regime
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
    } = input;

    let score = 0;
    const parts = [];

    // ۱. Confluence (0-0.35)
    // effective 1 → 0.10، 2 → 0.20، 3+ → 0.35
    let confScore = 0;
    if (confluenceEffective >= 3) confScore = 0.35;
    else if (confluenceEffective >= 2) confScore = 0.20;
    else confScore = 0.10;
    score += confScore;
    parts.push({ name: 'confluence', value: confScore, weight: 0.35 });

    // ۲. HTF Trend (0-0.20)
    let trendScore = 0;
    if (htfTrend === 'صعودی' || htfTrend === 'bull') trendScore = 0.20;
    else if (htfTrend === 'خنثی' || htfTrend === 'range') trendScore = 0.10;
    else trendScore = 0;
    score += trendScore;
    parts.push({ name: 'htfTrend', value: trendScore, weight: 0.20 });

    // ۳. ATR (نوسان مناسب = امتیاز بالاتر) (0-0.15)
    // ATR/price بین 0.5% تا 3% = ایده‌آل
    let atrScore = 0;
    if (atr && price && price > 0) {
        const atrPct = (atr / price) * 100;
        if (atrPct >= 0.5 && atrPct <= 3.0) atrScore = 0.15;
        else if (atrPct >= 0.3 && atrPct < 5.0) atrScore = 0.08;
    }
    score += atrScore;
    parts.push({ name: 'atr', value: atrScore, weight: 0.15 });

    // ۴. RSI (اختیاری) (0-0.10)
    let rsiScore = 0;
    if (rsiFast !== null) {
        if (rsiFast >= 40 && rsiFast <= 70) rsiScore = 0.10;   // zone سالم
        else if (rsiFast >= 30 && rsiFast <= 80) rsiScore = 0.05;
    } else {
        rsiScore = 0.05;   // خنثی وقتی اطلاعات نیست
    }
    score += rsiScore;
    parts.push({ name: 'rsi', value: rsiScore, weight: 0.10 });

    // ۵. IV/HV (0-0.10) — آپشن ارزان = بهتر
    let ivScore = 0;
    if (ivHv !== null && ivHv !== undefined) {
        if (ivHv >= 0.8 && ivHv <= 1.3) ivScore = 0.10;
        else if (ivHv <= 1.5) ivScore = 0.05;
    } else {
        ivScore = 0.05;
    }
    score += ivScore;
    parts.push({ name: 'ivHv', value: ivScore, weight: 0.10 });

    // ۶. Regime (0-0.10)
    let regimeScore = 0;
    if (regimeMacro === 'bull') regimeScore = 0.10;
    else if (regimeMacro === 'range') regimeScore = 0.05;
    else regimeScore = 0;   // bear = پرهیز
    if (regimeVol === 'high') regimeScore *= 0.5;   // نوسان بالا = ریسک
    score += regimeScore;
    parts.push({ name: 'regime', value: regimeScore, weight: 0.10 });

    return {
        score: Math.round(score * 1000) / 1000,
        level: score >= 0.7 ? 'high' : score >= 0.4 ? 'mid' : 'low',
        parts
    };
}

// ------------------------------------------------------------
// Size factor from score
// ------------------------------------------------------------
function scoreToSizeFactor(score) {
    if (score >= 0.80) return 1.3;
    if (score >= 0.65) return 1.0;
    if (score >= 0.50) return 0.8;
    if (score >= 0.35) return 0.6;
    if (score >= 0.20) return 0.4;
    return 0.2;   // حداقل — نه صفر، چون می‌خوایم سیگنال بگیریم
}

// ------------------------------------------------------------
// Historical Score — برای بک‌تست
// ------------------------------------------------------------
// از داده‌ی تاریخی موجود، score تقریبی می‌سازد
function computeHistoricalScore(trade, regimeAtEntry) {
    // مثل live — دقیقاً همون computeSignalScore
    return computeSignalScore({
        confluenceEffective: trade.confluenceEffective || 1,
        htfTrend: trade.htfTrend || null,
        atr: trade.atr || null,
        price: trade.stockEntry || null,
        rsiFast: trade.rsiFast || null,
        ivHv: trade.ivHv || null,
        regimeMacro: regimeAtEntry ? regimeAtEntry.macro : 'unknown',
        regimeVol: regimeAtEntry ? regimeAtEntry.vol : 'normal'
    });
}

module.exports = {
    diversityWeightedConfluence,
    computeSignalScore,
    computeHistoricalScore,
    scoreToSizeFactor
};