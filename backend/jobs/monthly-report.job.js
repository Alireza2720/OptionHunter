'use strict';
// ============================================================
// monthly-report.job.js — گزارش ماهانه‌ی کامل استراتژی‌ها
// ============================================================
// اول هر ماه ساعت 10:00 تهران: تولید + ارسال + ذخیره

const cron = require('node-cron');

let deps = { getDB: null, logger: null, notify: null };
function init(d) { deps = { ...deps, ...d }; }

const STRATEGY_FA = {
    smc_unicorn: 'SMC Unicorn',
    ob_sweep: 'OB + Sweep',
    supply_demand: 'Supply & Demand',
    ob_after_sweep: 'OB After Sweep',
    supertrend: 'Supertrend',
    bb_squeeze: 'BB Squeeze',
    donchian: 'Donchian',
    keltner_pb: 'Keltner Pullback',
    ensemble: 'Ensemble'
};

function fmtPF(pf) {
    if (pf === null || pf === undefined) return '—';
    if (!Number.isFinite(pf)) return '∞';
    return pf.toFixed(2);
}

function statusEmoji(pf, n) {
    if (n < 5) return '⚪';
    if (pf >= 2.0) return '🟢';
    if (pf >= 1.2) return '🟡';
    if (pf >= 0.7) return '🟠';
    return '🔴';
}

async function generate() {
    const db = deps.getDB();
    const { COLLECTIONS } = require('../config/constants');

    const now = new Date();
    const since30 = new Date(now.getTime() - 30 * 86400000);
    const since90 = new Date(now.getTime() - 90 * 86400000);

    // ── داده‌ها ──
    const monitored = await db.collection(COLLECTIONS.MONITORED_SYMBOLS).find({}).toArray();
    const configs = await db.collection(COLLECTIONS.STRATEGY_CONFIGS).find({}).toArray();

    // آخرین بک‌تست compare با details
    const lastJob = await db.collection(COLLECTIONS.BACKTEST_JOBS)
        .find({ type: 'backtest-compare', status: 'DONE' })
        .sort({ finishedAt: -1 }).limit(1).toArray();
    const btJobId = lastJob[0] ? String(lastJob[0]._id) : null;

    let details = [];
    if (btJobId) {
        details = await db.collection(COLLECTIONS.BACKTEST_COMPARE_DETAILS)
            .find({ jobId: btJobId }).toArray();
    }

    // positions زنده (اختیاری)
    const livePositions = await db.collection(COLLECTIONS.OPTION_POSITIONS)
        .find({ status: 'closed', exitTime: { $gte: since90 } }).toArray();

    // meta
    const btpf = await db.collection(COLLECTIONS.META).findOne({ _id: 'last_backtest_pf' });

    // ── محاسبات per-strategy ──
    const stratMap = {};
    for (const d of details) {
        const t = d.optionStats || d.stockStats || {};
        const sid = d.strategyId;
        if (!stratMap[sid]) stratMap[sid] = {
            strategyId: sid,
            name: STRATEGY_FA[sid] || sid,
            pairs: 0, totalTrades: 0, totalWins: 0, totalPnl: 0,
            // 🆕 جمع GP/GL برای محاسبه PF درست
            totalGrossWin: 0, totalGrossLoss: 0,
            pfs: [], best: null, worst: null
        };
        const s = stratMap[sid];
        const tradeCount = t.count || 0;
        const wr = (t.winRate || 0) / 100;
        const wins = tradeCount * wr;
        const losses = tradeCount - wins;
        // تخمین GP و GL از avgWin/avgLoss
        const avgWin = Math.abs(t.avgWin || 0);
        const avgLoss = Math.abs(t.avgLoss || 0);
        const gp = wins * avgWin;
        const gl = losses * avgLoss;

        s.pairs++;
        s.totalTrades += tradeCount;
        s.totalWins += wins;
        s.totalPnl += t.totalPnl || 0;
        s.totalGrossWin += gp;
        s.totalGrossLoss += gl;

        // برای median و best/worst از PF per-pair استفاده می‌کنیم
        const pf = t.profitFactor;
        const safePf = Number.isFinite(pf) ? pf : (pf === Infinity ? 999 : 0);
        if (safePf > 0 && tradeCount >= 5) s.pfs.push(safePf);  // فقط pairهای N>=5
        if (!s.best || safePf > s.best.pf) s.best = { symbol: d.symbol, pf: safePf, n: tradeCount };
        if (!s.worst || safePf < s.worst.pf) s.worst = { symbol: d.symbol, pf: safePf, n: tradeCount };
    }

    const stratStats = Object.values(stratMap).map(s => {
        // 🆕 PF درست: aggregate (sum GP / sum GL)
        const aggregatePF = s.totalGrossLoss > 0
            ? s.totalGrossWin / s.totalGrossLoss
            : (s.totalGrossWin > 0 ? 999 : 0);

        // 🆕 median PF (robust نسبت به outliers)
        const sortedPfs = [...s.pfs].sort((a, b) => a - b);
        const medianPF = sortedPfs.length
            ? sortedPfs[Math.floor(sortedPfs.length / 2)]
            : 0;

        const wr = s.totalTrades ? (s.totalWins / s.totalTrades * 100) : 0;
        const configCount = configs.filter(c => c.strategyId === s.strategyId).length;
        const leaderCount = configs.filter(c => c.strategyId === s.strategyId && c.role === 'leader').length;
        const confirmerCount = configs.filter(c => c.strategyId === s.strategyId && c.role === 'confirmer').length;

        return {
            strategyId: s.strategyId,
            name: s.name,
            pairs: s.pairs,
            totalTrades: s.totalTrades,
            totalPnl: Math.round(s.totalPnl * 100) / 100,
            // 🆕 فیلدهای درست
            avgPF: Math.round(aggregatePF * 100) / 100,
            medianPF: Math.round(medianPF * 100) / 100,
            grossWin: Math.round(s.totalGrossWin),
            grossLoss: Math.round(s.totalGrossLoss),
            winRate: Math.round(wr * 10) / 10,
            avgPnlPerTrade: s.totalTrades ? Math.round(s.totalPnl / s.totalTrades * 100) / 100 : 0,
            leaderCount, confirmerCount, configCount,
            best: s.best,
            worst: s.worst,
            status: statusEmoji(aggregatePF, s.totalTrades)
        };
    }).sort((a, b) => b.avgPF - a.avgPF);

    // ── محاسبات per-symbol ──
    const symMap = {};
    for (const d of details) {
        const t = d.optionStats || d.stockStats || {};
        const sid = d.strategyId;
        if (!symMap[d.symbol]) symMap[d.symbol] = {
            symbol: d.symbol,
            configs: 0, strategies: [],
            totalTrades: 0, totalGrossWin: 0, totalGrossLoss: 0,
            best: null, worst: null
        };
        const s = symMap[d.symbol];
        const tradeCount = t.count || 0;
        const wr = (t.winRate || 0) / 100;
        const wins = tradeCount * wr;
        const losses = tradeCount - wins;
        const gp = wins * Math.abs(t.avgWin || 0);
        const gl = losses * Math.abs(t.avgLoss || 0);

        s.configs++;
        s.totalTrades += tradeCount;
        s.totalGrossWin += gp;
        s.totalGrossLoss += gl;

        // 🆕 فقط pairهای با N>=10 برای best/worst
        if (tradeCount >= 10) {
            const pf = t.profitFactor;
            const safePf = Number.isFinite(pf) ? pf : (pf === Infinity ? 999 : 0);
            s.strategies.push({ id: sid, name: STRATEGY_FA[sid] || sid, pf: safePf, n: tradeCount });
            if (!s.best || safePf > s.best.pf) s.best = { name: STRATEGY_FA[sid] || sid, pf: safePf, n: tradeCount };
            if (!s.worst || safePf < s.worst.pf) s.worst = { name: STRATEGY_FA[sid] || sid, pf: safePf, n: tradeCount };
        }
    }

    const symStats = Object.values(symMap).map(s => {
        // 🆕 aggregate PF برای هر نماد
        const aggPF = s.totalGrossLoss > 0
            ? s.totalGrossWin / s.totalGrossLoss
            : (s.totalGrossWin > 0 ? 999 : 0);
        return {
            symbol: s.symbol,
            configs: s.configs,
            totalTrades: s.totalTrades,
            aggregatePF: Math.round(aggPF * 100) / 100,
            best: s.best,
            worst: s.worst,
            status: statusEmoji(aggPF, s.totalTrades)
        };
    }).sort((a, b) => b.aggregatePF - a.aggregatePF);

    // ── هشدارها ──
    const warnings = [];
    // فقط warnings معنادار
    for (const s of stratStats) {
        if (s.avgPF < 0.5 && s.totalTrades >= 100) {
            warnings.push(`🔴 <b>${s.name}</b>: PF=${s.avgPF} در ${s.totalTrades} معامله (ضعیف)`);
        } else if (s.avgPF >= 2.0 && s.totalTrades >= 50) {
            warnings.push(`🟢 <b>${s.name}</b>: PF=${s.avgPF} در ${s.totalTrades} معامله (قوی)`);
        }
    }
    for (const s of symStats) {
        // فقط نمادهایی که aggregate PF خیلی ضعیفه
        if (s.aggregatePF < 0.3 && s.totalTrades >= 50) {
            warnings.push(`🔴 <b>${s.symbol}</b>: PF=${s.aggregatePF} در ${s.totalTrades} معامله`);
        }
    }

    // ── آمار کلی ──
    const overall = {
        symbolsMonitored: monitored.length,
        totalConfigs: configs.length,
        enabledConfigs: configs.filter(c => c.enabled).length,
        strategies: stratStats.length,
        leaders: configs.filter(c => c.role === 'leader').length,
        confirmers: configs.filter(c => c.role === 'confirmer').length,
        btJobId,
        btTotalTrades: details.reduce((a, d) => a + ((d.optionStats && d.optionStats.count) || 0), 0),
        btPf: btpf ? btpf.pf : null,
        btMaxDD: btpf ? btpf.maxDD : null,
        btSharpe: btpf ? btpf.sharpe : null,
        btReturn: btpf ? btpf.returnPct : null,
        livePositions: livePositions.length
    };

    const report = {
        generatedAt: new Date(),
        monthLabel: new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
            year: 'numeric', month: 'long'
        }).format(now),
        overall, stratStats, symStats, warnings
    };

    // ذخیره در meta
    await db.collection(COLLECTIONS.META).updateOne(
        { _id: 'monthly_report_latest' },
        { $set: { ...report, generatedAt: new Date() } },
        { upsert: true }
    );
    // آرشیو
    await db.collection(COLLECTIONS.META).insertOne({
        _id: `monthly_report_${now.toISOString().slice(0, 7)}`,
        ...report
    }).catch(() => {}); // ممکنه دوباره اجرا بشه

    return report;
}

function buildText(report) {
    const o = report.overall;
    let t = `📊 گزارش ماهانه — ${report.monthLabel}\n`;
    t += `━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    // کلیات
    t += `🎯 کلیات\n`;
    t += `• نماد پایش‌شده: ${o.symbolsMonitored}\n`;
    t += `• استراتژی فعال: ${o.enabledConfigs} از ${o.totalConfigs}\n`;
    t += `• راهبر/تأیید: ${o.leaders}/${o.confirmers}\n`;
    t += `• استراتژی‌های در دسترس: ${o.strategies}\n\n`;

    // عملکرد
    if (o.btPf) {
        t += `📈 برآورد بک‌تست\n`;
        t += `• معاملات: ${o.btTotalTrades}\n`;
        t += `• PF: ${fmtPF(o.btPf)}\n`;
        t += `• بازده: ${o.btReturn ? o.btReturn.toFixed(1) + '%' : '—'}\n`;
        t += `• Sharpe: ${o.btSharpe ? o.btSharpe.toFixed(2) : '—'}\n`;
        t += `• MaxDD: ${o.btMaxDD ? o.btMaxDD.toFixed(1) + '%' : '—'}\n\n`;
    }

    // استراتژی‌ها
    t += `🎯 استراتژی‌ها (${report.stratStats.length})\n`;
    t += `━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    for (const s of report.stratStats) {
        t += `${s.status} <b>${s.name}</b>\n`;
        t += `   راهبر: ${s.leaderCount} | تأیید: ${s.confirmerCount} | pair: ${s.pairs}\n`;
        t += `   PF: <b>${s.avgPF}</b> (median ${s.medianPF}) | WR: ${s.winRate}% | N: ${s.totalTrades}\n`;
        t += `   GP/GL: ${s.grossWin.toLocaleString()}/${s.grossLoss.toLocaleString()}\n`;
        if (s.best && s.best.pf > 0 && s.best.n >= 10) {
            t += `   🥇 ${s.best.symbol} (PF=${fmtPF(s.best.pf)}, N=${s.best.n})\n`;
        }
        if (s.worst && s.worst.pf < 1 && s.worst.pf > 0 && s.worst.n >= 10) {
            t += `   ⚠️ ${s.worst.symbol} (PF=${fmtPF(s.worst.pf)}, N=${s.worst.n})\n`;
        }
        t += `\n`;
    }

    // بهترین نمادها
    t += `📊 نمادها — برترین‌ها (${report.symStats.length})\n`;
    t += `━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    const top5 = report.symStats.slice(0, 5);
    for (const s of top5) {
        const best = s.best ? ` — ${s.best.name} (PF=${fmtPF(s.best.pf)}, N=${s.best.n})` : '';
        t += `${s.status} <b>${s.symbol}</b> | PF=${s.aggregatePF} | N=${s.totalTrades}${best}\n`;
    }
    t += `\n`;

    // ضعیف‌ها
    const bot5 = report.symStats.filter(s => s.best.pf < 1.2).slice(-5).reverse();
    if (bot5.length) {
        t += `⚠️ نیاز به بررسی\n`;
        t += `━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        for (const s of bot5) {
            t += `• ${s.symbol} — ${s.best.name} (PF=${fmtPF(s.best.pf)})\n`;
        }
        t += `\n`;
    }

    // هشدارها
    if (report.warnings.length) {
        t += `🚨 هشدارها\n`;
        t += `━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        for (const w of report.warnings.slice(0, 10)) {
            t += `• ${w}\n`;
        }
        t += `\n`;
    }

    t += `━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    t += `📅 گزارش بعدی: اول ماه بعد`;

    return t;
}

async function run() {
    try {
        deps.logger && deps.logger.info('monthly-report: generating...');
        const report = await generate();

        if (deps.notify) {
            const text = buildText(report);
            // تلگرام محدودیت 4096 داره
            if (text.length <= 4000) {
                await deps.notify(text).catch(() => {});
            } else {
                // split
                const parts = [];
                let cur = '';
                for (const line of text.split('\n')) {
                    if (cur.length + line.length + 1 > 3500) {
                        parts.push(cur);
                        cur = line;
                    } else {
                        cur += (cur ? '\n' : '') + line;
                    }
                }
                if (cur) parts.push(cur);
                for (let i = 0; i < parts.length; i++) {
                    await deps.notify(`(${i + 1}/${parts.length})\n${parts[i]}`).catch(() => {});
                    await new Promise(r => setTimeout(r, 1500));
                }
            }
        }

        deps.logger && deps.logger.info('monthly-report: sent');
        return report;
    } catch (e) {
        deps.logger && deps.logger.error('monthly-report: ' + e.message);
        return { error: e.message };
    }
}

let task = null;
function start() {
    if (task) return;
    // اول هر ماه ساعت 10:00 تهران
    task = cron.schedule('0 10 1 * *', run, { timezone: 'Asia/Tehran' });
    deps.logger && deps.logger.info('monthly-report.job started');
}
function stop() { if (task) { task.stop(); task = null; } }

module.exports = { init, start, stop, run, generate, buildText };