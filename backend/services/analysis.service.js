'use strict';
// ============================================================
// analysis.service.js — تحلیل آماری فاز ۱ (Prove Edge)
// ============================================================
// - Bootstrap CI 95% روی PF
// - One-sample t-test (H0: mean=0)
// - Rolling segments (پنجره‌های ۳ گانه) با skip برای N کم
// - Sharpe ratio
// - Gate evaluation
// ============================================================

const { COLLECTIONS } = require('../config/constants');

let deps = { getDB: null, logger: null };
function init(d) { deps = { ...deps, ...d }; }

// ============================================================
// Helpers
// ============================================================
function mean(arr) {
    if (!arr.length) return 0;
    return arr.reduce((s, x) => s + x, 0) / arr.length;
}

function stdev(arr) {
    if (arr.length < 2) return 0;
    const m = mean(arr);
    const v = arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1);
    return Math.sqrt(v);
}

function profitFactorFromPnls(pnls) {
    const wins = pnls.filter(x => x > 0);
    const losses = pnls.filter(x => x <= 0);
    const gp = wins.reduce((s, x) => s + x, 0);
    const gl = -losses.reduce((s, x) => s + x, 0);
    if (gl > 0) return gp / gl;
    if (gp > 0) return Infinity;   // هیچ ضرری نبوده
    return 0;
}

// 🆕 round برای اعداد با پشتیبانی از Infinity
function roundPF(v) {
    if (v === null || v === undefined) return null;
    if (v === Infinity) return 999;
    if (!Number.isFinite(v)) return null;
    return Math.round(v * 100) / 100;
}

function round2(v) {
    if (v === null || v === undefined || !Number.isFinite(v)) return null;
    return Math.round(v * 100) / 100;
}

function round4(v) {
    if (v === null || v === undefined || !Number.isFinite(v)) return null;
    return Math.round(v * 10000) / 10000;
}

// ============================================================
// Bootstrap CI
// ============================================================
function bootstrapCI(pnls, iterations = 10000) {
    if (!pnls || pnls.length < 3) {
        return { error: 'need at least 3 trades' };
    }
    const N = pnls.length;
    const pfs = new Array(iterations);
    const totalReturns = new Array(iterations);

    for (let i = 0; i < iterations; i++) {
        const sample = new Array(N);
        for (let j = 0; j < N; j++) {
            sample[j] = pnls[Math.floor(Math.random() * N)];
        }
        pfs[i] = profitFactorFromPnls(sample);
        let eq = 100;
        for (const p of sample) eq *= (1 + p / 100);
        totalReturns[i] = eq - 100;
    }

    pfs.sort((a, b) => a - b);
    totalReturns.sort((a, b) => a - b);

    const pct = (arr, p) => arr[Math.max(0, Math.min(arr.length - 1, Math.floor(arr.length * p)))];

    // 🆕 cap بدترین PF روی 999 برای حلقه‌های بی‌ضرر
    const capPF = v => Number.isFinite(v) ? v : 999;

    const lowerBound = capPF(pct(pfs, 0.025));
    const finalPF = profitFactorFromPnls(pnls);

    return {
        iterations,
        // PF خام نمونه اصلی (بدون rounding)
        rawPF: finalPF === Infinity ? 999 : round2(finalPF),
        pf: {
            p2_5:   capPF(pct(pfs, 0.025)),
            p5:     capPF(pct(pfs, 0.05)),
            p25:    capPF(pct(pfs, 0.25)),
            median: capPF(pct(pfs, 0.50)),
            p75:    capPF(pct(pfs, 0.75)),
            p95:    capPF(pct(pfs, 0.95)),
            p97_5:  capPF(pct(pfs, 0.975)),
            mean:   capPF(mean(pfs)),
            significant: lowerBound > 1.0
        },
        totalReturn: {
            p2_5:   round2(pct(totalReturns, 0.025)),
            median: round2(pct(totalReturns, 0.50)),
            p97_5:  round2(pct(totalReturns, 0.975)),
            probLoss: round2(totalReturns.filter(x => x < 0).length / iterations * 100)
        }
    };
}

// ============================================================
// One-sample t-test (H0: mean=0, H1: mean>0)
// ============================================================
function tTestOneSample(pnls, mu0 = 0) {
    const N = pnls.length;
    if (N < 3) return { error: 'need at least 3 trades' };
    const m = mean(pnls);
    const sd = stdev(pnls);
    if (sd === 0) return { t: 0, df: N - 1, p: 1, mean: m, sd: 0, significant: false };
    const se = sd / Math.sqrt(N);
    const t = (m - mu0) / se;
    const p = 1 - studentTCdf(t, N - 1);
    return {
        t: round2(t), df: N - 1, p: round4(p),
        mean: round2(m), sd: round2(sd), se: round4(se),
        significant: p < 0.05
    };
}

function studentTCdf(t, df) {
    const x = df / (df + t * t);
    const ib = incompleteBeta(x, df / 2, 0.5);
    return t >= 0 ? 1 - 0.5 * ib : 0.5 * ib;
}

function incompleteBeta(x, a, b) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    const bt = Math.exp(
        logGamma(a + b) - logGamma(a) - logGamma(b) +
        a * Math.log(x) + b * Math.log(1 - x)
    );
    if (x < (a + 1) / (a + b + 2)) {
        return bt * betacf(x, a, b) / a;
    }
    return 1 - bt * betacf(1 - x, b, a) / b;
}

function betacf(x, a, b) {
    const MAXIT = 200, EPS = 3e-7, FPMIN = 1e-30;
    const qab = a + b, qap = a + 1, qam = a - 1;
    let c = 1;
    let d = 1 - qab * x / qap;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    d = 1 / d;
    let h = d;
    for (let m = 1; m <= MAXIT; m++) {
        const m2 = 2 * m;
        let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
        d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
        c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
        d = 1 / d; h *= d * c;
        aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
        d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
        c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
        d = 1 / d;
        const del = d * c;
        h *= del;
        if (Math.abs(del - 1) < EPS) break;
    }
    return h;
}

function logGamma(x) {
    const cof = [
        76.18009172947146, -86.50532032941677, 24.01409824083091,
        -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5
    ];
    let y = x, tmp = x + 5.5;
    tmp -= (x + 0.5) * Math.log(tmp);
    let ser = 1.000000000190015;
    for (let j = 0; j < 6; j++) ser += cof[j] / ++y;
    return -tmp + Math.log(2.5066282746310005 * ser / x);
}

// ============================================================
// Rolling segments — با حداقل اندازه‌ی segment
// ============================================================
function rollingSegments(pnls, requestedSegments = 3, minSegSize = 3) {
    const N = pnls.length;

    // 🆕 اگه تعداد کمه، skip کن
    if (N < requestedSegments * minSegSize) {
        // تلاش برای کاهش تعداد segments
        const possible = Math.floor(N / minSegSize);
        if (possible < 2) {
            return {
                skipped: true,
                reason: `only ${N} trades — need at least ${minSegSize * 2} for rolling`,
                tradeCount: N,
                minSegSize,
                consistencyPct: null,
                profitable: null,
                segments: []
            };
        }
        // با تعداد کمتر segments ادامه بده
        return buildSegments(pnls, possible, minSegSize);
    }
    return buildSegments(pnls, requestedSegments, minSegSize);
}

function buildSegments(pnls, numSegments, minSegSize) {
    const N = pnls.length;
    const segSize = Math.floor(N / numSegments);
    const segments = [];
    for (let i = 0; i < numSegments; i++) {
        const from = i * segSize;
        const to = i === numSegments - 1 ? N : (i + 1) * segSize;
        const seg = pnls.slice(from, to);
        if (seg.length < minSegSize) continue;
        const rawPf = profitFactorFromPnls(seg);
        segments.push({
            index: i + 1,
            count: seg.length,
            // 🆕 هم نسخه‌ی گرد‌شده، هم خام
            pf: roundPF(rawPf),
            pfRaw: rawPf,
            mean: round2(mean(seg)),
            totalPnl: round2(seg.reduce((s, x) => s + x, 0)),
            winRate: round2(seg.filter(x => x > 0).length / seg.length * 100)
        });
    }
    const profitable = segments.filter(s => s.pfRaw > 1).length;
    const withData = segments.length;
    const consistency = withData > 0 ? (profitable / withData * 100) : null;

    return {
        skipped: false,
        segments,
        numSegments: withData,
        profitable,
        withData,
        consistencyPct: round2(consistency),
        minSegSize
    };
}

// ============================================================
// Main: analyze single config
// ============================================================
async function analyzeConfig(jobId, symbol, strategyId, opts = {}) {
    const db = deps.getDB();
    const detail = await db.collection(COLLECTIONS.BACKTEST_COMPARE_DETAILS).findOne({
        jobId: String(jobId),
        symbol,
        strategyId
    });
    if (!detail) {
        throw Object.assign(new Error('جزئیات یافت نشد'), { status: 404 });
    }
    const trades = detail.trades || [];
    if (trades.length < 3) {
        return {
            jobId, symbol, strategyId,
            strategyName: detail.strategyName,
            error: 'تعداد معاملات کمتر از 3 — تحلیل معنادار نیست',
            tradeCount: trades.length
        };
    }

    const pnls = trades.map(t => t.pnlPct);
    const iterations = Math.min(opts.iterations || 10000, 50000);

    const bootstrap = bootstrapCI(pnls, iterations);
    const ttest = tTestOneSample(pnls);
    const rolling = rollingSegments(pnls, 3, 3);

    // Sharpe
    const annualFactor = Math.sqrt(245 / 65);
    const sharpe = stdev(pnls) > 0
        ? round2((mean(pnls) / stdev(pnls)) * Math.sqrt(pnls.length) * annualFactor)
        : null;

    // 🆕 Gate: اگه rolling skip شده، به عنوان pass در نظر نگیر ولی fail هم نکن
    const rollingPassed = rolling.skipped
        ? null  // → مشخص می‌کنه insufficient
        : rolling.consistencyPct >= 66.7;

    const gate = {
        bootstrapLowerBoundPF: bootstrap.pf.p2_5 > 1.0,
        ttestSignificant: ttest.p < 0.05,
        rollingConsistency: rollingPassed,
        sharpeOk: sharpe !== null && sharpe > 1.0
    };

    // 🆕 اگه rolling نامعلومه، فقط 3 شرط دیگه چک می‌شن
    const hardGates = [gate.bootstrapLowerBoundPF, gate.ttestSignificant, gate.sharpeOk];
    const allHardPassed = hardGates.every(x => x === true);

    gate.allPassed = rollingPassed === null
        ? allHardPassed  // rolling skip → 3 شرط سخت‌گیرانه دیگه
        : (allHardPassed && rollingPassed);

    gate.rollingInsufficient = rollingPassed === null;

    return {
        jobId, symbol, strategyId,
        strategyName: detail.strategyName,
        timeframe: detail.timeframe,
        tradeCount: trades.length,
        rawStats: {
            mean: round2(mean(pnls)),
            totalPnl: round2(pnls.reduce((s, x) => s + x, 0)),
            pf: roundPF(profitFactorFromPnls(pnls)),        // 🆕 Infinity→999
            winRate: round2(pnls.filter(x => x > 0).length / pnls.length * 100),
            stdev: round2(stdev(pnls)),
            sharpe
        },
        bootstrap,
        ttest,
        rolling,
        gate
    };
}

// ============================================================
// Analyze whole job
// ============================================================
async function analyzeJob(jobId, opts = {}) {
    const db = deps.getDB();
    const minTrades = opts.minTrades || 5;
    const details = await db.collection(COLLECTIONS.BACKTEST_COMPARE_DETAILS)
        .find({ jobId: String(jobId) })
        .toArray();

    const results = [];
    for (const d of details) {
        if (!d.trades || d.trades.length < minTrades) continue;
        try {
            const r = await analyzeConfig(jobId, d.symbol, d.strategyId, opts);
            if (!r.error) results.push(r);
        } catch (e) {
            deps.logger && deps.logger.warn(`analyze ${d.symbol}/${d.strategyId}: ${e.message}`);
        }
    }

    // sort by lower bound PF (کنسرواتیوترین معیار)
    results.sort((a, b) => (b.bootstrap.pf.p2_5 || 0) - (a.bootstrap.pf.p2_5 || 0));
    const passing = results.filter(r => r.gate.allPassed);
    const rollingInsufficient = results.filter(r => r.gate.rollingInsufficient).length;

    return {
        jobId,
        analyzedAt: new Date(),
        minTrades,
        iterations: opts.iterations || 10000,
        totalAnalyzed: results.length,
        passing: passing.length,
        rollingInsufficient,
        results
    };
}

module.exports = {
    init,
    analyzeConfig,
    analyzeJob,
    bootstrapCI,
    tTestOneSample,
    rollingSegments,
    profitFactorFromPnls
};