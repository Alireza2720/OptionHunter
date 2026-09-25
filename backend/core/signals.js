'use strict';
// ============================================================
// signals.js — ارزیابی سیگنال‌ها (منطق دامنه)
// ============================================================
// این ماژول جایگزین evaluateStrategyConfig و evaluateAll در server.js قدیمی است.
//
// مسئولیت‌ها:
//   - اجرای استراتژی روی کندل‌های بسته‌شده
//   - تشخیص سیگنال BUY / EXIT_LONG
//   - محاسبه confluence (هم‌گرایی)
//   - ارسال به notify و ذخیره در signal_history
//   - فراخوانی options.onBuySignal برای پیشنهاد قرارداد
//
// هیچ وابستگی به HTTP یا تنظیمات global نداره. همه چیز inject می‌شه.
// ============================================================

const { TIMEFRAME_MINUTES, COLLECTIONS } = require('../config/constants');

let deps = {
    getDB: null,
    strategies: null,
    dataService: null,
    options: null,
    settings: null,
    notify: null,
    entryWindow: () => ({ start: 9 * 60 + 30, end: 12 * 60 }),
    confluenceWindow: () => 0,
    multiConfirmerMin: () => 2,
    minTargetPct: () => 4.5,
    executionGuard: null,
    signalFilterService: null,
    correlationService: null,
    regimeService: null   // 🆕 Phase 6
};

function init(d) {
    deps = { ...deps, ...d };
}

// ============================================================
// Helpers
// ============================================================
const short = (s, n = 60) => String(s || '').slice(0, n);

const { getSectorMap } = require('./sectors');

// ============================================================
// 🆕 ساخت state پرتفولیو از option_positions باز
// ============================================================
async function buildPortfolioState() {
    const db = deps.getDB();
    const open = await db.collection(COLLECTIONS.OPTION_POSITIONS)
        .find({ status: 'open' }).toArray();
    const portfolio = deps.executionGuard.emptyPortfolio();
    const now = Math.floor(Date.now() / 1000);
    for (const p of open) {
        const value = (p.entryAsk || 0) * (p.positionSize || 1) * (p.size || 1000);
        // تخمین exitTime: از scenario.horizonDays
        const horizonDays = (p.scenario && p.scenario.horizonDays) || 14;
        const entryTs = Math.floor(new Date(p.entryTime).getTime() / 1000);
        const exitTs = entryTs + horizonDays * 86400;
        // اگه منقضی شده (گذشته) نادیده بگیر
        if (exitTs <= now) continue;
        deps.executionGuard.addPosition(portfolio, p.underlying, value, exitTs);
    }
    return portfolio;
}

// ============================================================
// 🆕 بررسی guard قبل از ارسال سیگنال BUY
// ============================================================
// ============================================================
// 🆕 Phase 6 — Regime Guard
// ============================================================
async function checkRegimeGuard(config) {
    if (!deps.regimeService) return { allowed: true, reason: 'regime service not wired' };

    try {
        const regime = await deps.regimeService.getForSymbol(config.symbol);
        if (!regime || !regime.macro || regime.macro === 'unknown') {
            // اگه رژیم محاسبه نشده، اجازه بده (fail-open)
            return { allowed: true, reason: 'رژیم محاسبه نشده', regime: 'unknown' };
        }

        const regimeCore = require('./regime');
        const result = regimeCore.isStrategyAllowed(config.strategyId, regime.macro, regime.vol);

        return {
            allowed: result.allowed,
            regime: `${regime.macro}/${regime.vol}`,
            macro: regime.macro,
            vol: regime.vol,
            reason: result.reason
        };
    } catch (e) {
        deps.logger && deps.logger.warn('checkRegimeGuard: ' + e.message);
        return { allowed: true, error: e.message };
    }
}

async function checkSignalGuard(config, last, lastPrice, info) {
    if (!deps.executionGuard) return { allowed: true };   // backward compat

    try {
        // 1) portfolio state
        const portfolio = await buildPortfolioState();

        // 2) limits از settings
        const s = deps.settings.get();
        const whitelist = deps.signalFilterService
            ? await deps.signalFilterService.getWhitelist()
            : null;

        const limits = {
            ...deps.executionGuard.DEFAULT_LIMITS,
            capital: deps.settings.capital(),
            riskPct: s.RISK_PER_TRADE_PCT || 1.5,
            maxSymPct: s.MAX_SYMBOL_EXPOSURE_PCT || 20,
            maxTotalPct: s.MAX_TOTAL_EXPOSURE_PCT || 50,
            useSignalFilter: !!whitelist,
            signalWhitelist: whitelist ? whitelist.pairs : null
        };

        // 3) ctx
        const corrDoc = deps.correlationService
            ? await deps.correlationService.getCached()
            : null;
        const corrMatrix = corrDoc ? corrDoc.matrix : null;

        const monitored = await deps.getDB()
            .collection(COLLECTIONS.MONITORED_SYMBOLS).find({}).toArray();
        const sectorMap = getSectorMap(monitored.map(m => m.symbol));

        // 4) همه‌ی configهای enabled → stats
        const allConfigs = await deps.getDB()
            .collection(COLLECTIONS.STRATEGY_CONFIGS).find({ enabled: true }).toArray();
        const allTrades = [];   // TODO: from backtest details اگه داشتیم — فعلاً خالی
        const stats = deps.executionGuard.computeGlobalStats(allTrades);

        const ctx = deps.executionGuard.buildContext(limits, [], {
            corrMatrix, sectorMap, stats
        });

        // 5) candidate
        const candidate = {
            symbol: config.symbol,
            strategyId: config.strategyId,
            optionEntry: lastPrice,   // تخمین — actual entry در options.onBuySignal
            size: 1000,
            entryTime: Math.floor(Date.now() / 1000)
        };

        // 6) decision
        const decision = deps.executionGuard.canOpen(candidate, portfolio, limits, ctx);
        return decision;
    } catch (e) {
        deps.logger && deps.logger.warn('checkSignalGuard: ' + e.message);
        return { allowed: true, error: e.message };   // در خطا، اجازه بده (fail-open)
    }
}

function sameDay(t1, t2) {
    const a = deps.dataService.getTehranParts(new Date(t1 * 1000));
    const b = deps.dataService.getTehranParts(new Date(t2 * 1000));
    return a.year === b.year && a.month === b.month && a.day === b.day;
}

// ============================================================
// Single config evaluation
// ============================================================
async function evaluateConfig(config, marketInfo) {
    const STRATEGIES = deps.strategies.STRATEGIES;
    const def = STRATEGIES[config.strategyId];
    if (!def) return;

    const isConfirmer = config.role === 'confirmer';
    const db = deps.getDB();
    const stateColl = db.collection(COLLECTIONS.SIGNALS_STATE);
    const configId = config._id.toString();

    const htfTf = config.htfTimeframe || def.htfTimeframe || '1d';
    const candles = deps.dataService.closedOnly(
        await deps.dataService.getCandles(config.symbol, config.timeframe),
        config.timeframe
    );
    const htfCandles = deps.dataService.closedOnly(
        await deps.dataService.getCandles(config.symbol, htfTf),
        htfTf
    );

    const required = deps.strategies.getRequiredCandles(config.strategyId, config.params);
    const requiredHtf = deps.strategies.getRequiredHtfCandles
        ? deps.strategies.getRequiredHtfCandles(config.strategyId, config.params)
        : 0;

    const info = marketInfo && marketInfo.get(config.symbol);
    const base = {
        configId,
        symbol: config.symbol,
        strategyId: config.strategyId,
        timeframe: config.timeframe,
        htfTimeframe: htfTf,
        candleCount: candles.length,
        requiredCandles: required,
        htfCandleCount: htfCandles.length,
        requiredHtfCandles: requiredHtf,
        updatedAt: new Date(),
        queue: info ? info.queue : null,
        livePrice: info ? info.price : null
    };

    if (candles.length < required || htfCandles.length < requiredHtf) {
        await stateColl.updateOne(
            { configId },
            { $set: { ...base, insufficientData: true, position: null } },
            { upsert: true }
        );
        return;
    }

    const ew = deps.entryWindow();
    let result;
    try {
        result = def.run(
            candles,
            { ...config.params, candleType: config.candleType },
            { htfCandles, htfTimeframe: htfTf, entryWindow: ew }
        );
    } catch (e) {
        deps.notify && deps.notify(`خطا در اجرای استراتژی ${config.symbol}: ${e.message}`).catch(() => {});
        return;
    }

    const prev = await stateColl.findOne({ configId });
    const latest = result.signals[result.signals.length - 1];
    if (!latest) return;

    // ---- Warmup (اولین بار) ----
    if (!prev) {
        await stateColl.updateOne(
            { configId },
            { $set: {
                ...base,
                insufficientData: false,
                position: latest.position,
                indicators: latest.indicators,
                price: candles[candles.length - 1].close,
                lastCandleTime: latest.time,
                htfTrend: result.htfTrend || null,
                reason: latest.reason || null,
                lastNotifiedTime: latest.time,
                lastNotifiedType: latest.signalType || null,
                warmup: true
            }},
            { upsert: true }
        );
        return;
    }

    // ---- جستجوی آخرین سیگنال معنی‌دار بعد از notify قبلی ----
    const prevNotified = prev.lastNotifiedTime || 0;
    let last = latest;
    for (let i = result.signals.length - 1, k = 0; i >= 0 && k < 5; i--, k--) {
        const s = result.signals[i];
        if ((s.signalType === 'BUY' || s.signalType === 'EXIT_LONG') && s.time > prevNotified) {
            last = s;
            break;
        }
    }
    const late = last !== latest;
    const lastPrice = candles[candles.length - 1].close;

    // ---- ذخیره state ----
    await stateColl.updateOne(
        { configId },
        { $set: {
            ...base,
            insufficientData: false,
            position: latest.position,
            indicators: latest.indicators,
            price: lastPrice,
            lastCandleTime: latest.time,
            htfTrend: result.htfTrend || null,
            reason: latest.reason || null
        }},
        { upsert: true }
    );

    const label = `${config.symbol} | ${def.name} | ${config.timeframe} -> ${htfTf}`;
    const lastHa = result.ha.find(h => h.time === last.time);

    const tfMin = TIMEFRAME_MINUTES[config.timeframe] || 30;
    const isFormingNow = lastHa && (lastHa.time + tfMin * 60) > (Date.now() / 1000);
    const isIncomplete = isFormingNow && !!(lastHa && lastHa.complete === false);
    const incompleteTag = isIncomplete ? '\nکندل در حال تشکیل' : '';

    // ---- Cancel signal ----
    if (prev && prev.position === 'LONG' && latest.position !== 'LONG' && last.signalType !== 'EXIT_LONG') {
        if (!isConfirmer) {
            await deps.notify(`لغو سیگنال\n${label}\nموقعیت خرید قبلی وجود ندارد.`);
        }
    }

    const actionable = last.signalType === 'BUY' || last.signalType === 'EXIT_LONG';
    const already = prev && prev.lastNotifiedTime === last.time && prev.lastNotifiedType === last.signalType;
    if (!actionable || already) return;

    const signalT = deps.dataService.getTehranParts(new Date(last.time * 1000));
    const signalMin = signalT.hour * 60 + signalT.minute;
    const inWindow = signalMin >= ew.start && signalMin <= ew.end;

    const queueTag = info && info.queue === 'buy' ? '\nصف خرید'
        : info && info.queue === 'sell' ? '\nصف فروش' : '';
    const windowTag = last.signalType === 'BUY' && !inWindow ? `\nخارج از بازه` : '';

    // ---- Confluence (correlation-aware) ----
    let confluence = 1;
    let confluenceEffective = 1;
    let confluenceBreakdown = null;
    const confirmersList = [];
    const confirmersRaw = [];
    if (last.signalType === 'BUY') {
        try {
            const otherConfigs = await db.collection(COLLECTIONS.STRATEGY_CONFIGS).find({
                symbol: config.symbol,
                _id: { $ne: config._id },
                enabled: true
            }).toArray();
            const otherIds = otherConfigs.map(oc => oc._id.toString());
            const otherStates = await stateColl.find({ configId: { $in: otherIds } }).toArray();
            const stateMap = new Map(otherStates.map(s => [s.configId, s]));
            const tw = deps.confluenceWindow();
            const nowSec = Math.floor(Date.now() / 1000);

            // خود config اصلی
            confirmersRaw.push({ strategyId: config.strategyId, role: config.role });

            for (const oc of otherConfigs) {
                const ost = stateMap.get(oc._id.toString());
                if (!ost || ost.position !== 'LONG') continue;
                if (tw > 0) {
                    const diff = Math.abs(nowSec - (ost.updatedAt ? Math.floor(new Date(ost.updatedAt).getTime() / 1000) : 0));
                    if (diff > tw) continue;
                }
                confluence++;
                confirmersRaw.push({ strategyId: oc.strategyId, role: oc.role });
                if (oc.role === 'confirmer') {
                    const cfDef = STRATEGIES[oc.strategyId];
                    confirmersList.push(cfDef ? cfDef.name : oc.strategyId);
                }
            }

            // 🆕 Diversity-weighted effective confluence
            const signalScore = require('./signal-score');
            const dw = signalScore.diversityWeightedConfluence(confirmersRaw);
            confluenceEffective = dw.effective;
            confluenceBreakdown = dw.byStrategy;
        } catch (_) {}
    }

    const confluenceTag = confluence > 1 ? `\nهم گرایی ${confluence} استراتژی` : '';
    const confirmersTag = confirmersList.length ? `\nتایید: ${confirmersList.join('، ')}` : '';

    // ---- علامت‌گذاری notify ----
    await stateColl.updateOne(
        { configId },
        { $set: { lastNotifiedTime: last.time, lastNotifiedType: last.signalType } }
    );

    // 🆕 Signal score
    let signalScoreResult = null;
    if (last.signalType === 'BUY') {
        try {
            const scoreMod = require('./signal-score');
            const regimeMod = deps.regimeService ? require('./regime') : null;
            const r = deps.regimeService ? await deps.regimeService.getForSymbol(config.symbol) : null;
            signalScoreResult = scoreMod.computeSignalScore({
                confluenceEffective,
                htfTrend: result.htfTrend || null,
                atr: last.indicators && last.indicators.atr,
                price: lastPrice,
                rsiFast: last.indicators && last.indicators.rsiFast,
                ivHv: info && info.ivHv,
                regimeMacro: r ? r.macro : 'unknown',
                regimeVol: r ? r.vol : 'normal'
            });
        } catch (_) {}
    }

    let shouldNotifyConfirmer = false;
    if (isConfirmer && last.signalType === 'BUY' && confirmersList.length >= deps.multiConfirmerMin()) {
        shouldNotifyConfirmer = true;
    }

    // ---- ذخیره در history (حتی اگر notify نمی‌شود) ----
    if (isConfirmer && !shouldNotifyConfirmer) {
        await db.collection(COLLECTIONS.SIGNAL_HISTORY).insertOne({
            configId, symbol: config.symbol,
            strategyId: config.strategyId, strategyName: def.name,
            timeframe: config.timeframe,
            signalType: last.signalType,
            price: lastPrice, time: last.time,
            reason: last.reason || null,
            htfTrend: result.htfTrend || null,
            inWindow, queue: info ? info.queue : null,
            incomplete: isIncomplete,
            confluence, role: 'confirmer',
            createdAt: new Date()
        });
        return;
    }

    // ---- متن پیام ----
    let title;
    if (isConfirmer) title = `سیگنال چند-تاییدکننده (${confirmersList.length} تایید)`;
    else title = (last.signalType === 'BUY' ? 'سیگنال خرید (کال)' : 'خروج از خرید (بستن کال)') + (late ? ' (تاخیری)' : '');

    const roleTag = isConfirmer ? '[چند-تایید]' : '[لیدر]';
    const text = `${title}\n${label} ${roleTag}\n` +
        `روند ${htfTf}: ${result.htfTrend || '-'}\n` +
        `قیمت: ${lastPrice.toLocaleString()}` +
        `${info ? ` | لحظه ای: ${info.price.toLocaleString()}` : ''}\n` +
        `دلیل: ${short(last.reason || '-', 200)}` +
        `${confluenceTag}${confirmersTag}${queueTag}${windowTag}${incompleteTag}`;

    // 🆕 اگه BUY هست، guardهای مختلف رو چک کن
    if (last.signalType === 'BUY') {
        // ۰. Signal score gate
        if (signalScoreResult && signalScoreResult.score < 0.30) {
            const reasonText = `⛔ سیگنال ${config.symbol} رد شد (Score پایین)\n${def.name}\nScore: ${signalScoreResult.score}`;
            await deps.notify(reasonText);

            await db.collection(COLLECTIONS.SIGNAL_HISTORY).insertOne({
                configId, symbol: config.symbol,
                strategyId: config.strategyId, strategyName: def.name,
                timeframe: config.timeframe,
                signalType: last.signalType,
                price: lastPrice, time: last.time,
                reason: last.reason || null,
                rejected: true,
                rejectionReason: `Score ${signalScoreResult.score} < 0.30`,
                signalScore: signalScoreResult,
                createdAt: new Date()
            });
            return;
        }
        // ۱. Regime guard
        const regimeResult = await checkRegimeGuard(config);
        if (!regimeResult.allowed) {
            const reasonText = `⛔ سیگنال ${config.symbol} رد شد (Regime)\n${def.name}\nرژیم: ${regimeResult.regime}\nدلیل: ${regimeResult.reason}`;
            await deps.notify(reasonText);

            await db.collection(COLLECTIONS.SIGNAL_HISTORY).insertOne({
                configId, symbol: config.symbol,
                strategyId: config.strategyId, strategyName: def.name,
                timeframe: config.timeframe,
                signalType: last.signalType,
                price: lastPrice, time: last.time,
                reason: last.reason || null,
                rejected: true,
                rejectionReason: `Regime: ${regimeResult.reason}`,
                regime: regimeResult.regime,
                createdAt: new Date()
            });
            return;
        }

        // ۲. Execution guard (whitelist + sizing)
        const guardResult = await checkSignalGuard(config, last, lastPrice, info);
        if (!guardResult.allowed) {
            const reasonText = `⛔ سیگنال ${config.symbol} رد شد\n${def.name}\nدلیل: ${guardResult.reason}`;
            await deps.notify(reasonText);

            await db.collection(COLLECTIONS.SIGNAL_HISTORY).insertOne({
                configId, symbol: config.symbol,
                strategyId: config.strategyId, strategyName: def.name,
                timeframe: config.timeframe,
                signalType: last.signalType,
                price: lastPrice, time: last.time,
                reason: last.reason || null,
                rejected: true,
                rejectionReason: guardResult.reason,
                violations: guardResult.violations || [],
                regime: regimeResult.regime,
                createdAt: new Date()
            });
            return;
        }
    }

    await deps.notify(text);

    await db.collection(COLLECTIONS.SIGNAL_HISTORY).insertOne({
        configId, symbol: config.symbol,
        strategyId: config.strategyId, strategyName: def.name,
        timeframe: config.timeframe,
        signalType: last.signalType,
        price: lastPrice, time: last.time,
        reason: last.reason || null,
        htfTrend: result.htfTrend || null,
        inWindow, queue: info ? info.queue : null,
        incomplete: isIncomplete,
        confluence,
        confluenceEffective,
        confluenceBreakdown,
        signalScore: signalScoreResult,
        role: isConfirmer ? 'multi-confirmer' : 'leader',
        confirmers: confirmersList,
        createdAt: new Date()
    });

    // ---- پیشنهاد قرارداد ----
    if (last.signalType === 'BUY') {
        if (!inWindow || (info && info.queue === 'buy')) {
            await deps.notify(`${config.symbol}: به دلیل ${!inWindow ? 'خارج از بازه' : 'صف خرید'} آپشن پیشنهاد نشد.`);
            return;
        }

        const stop = last.indicators && last.indicators.stop;
        const atr = last.indicators && last.indicators.atr;
        const risk = stop && stop < lastPrice ? lastPrice - stop : (atr ? 2 * atr : lastPrice * 0.03);
        const targetPct = (risk * 3.0 / lastPrice) * 100;
        const minTarget = deps.minTargetPct();

        if (targetPct < minTarget) {
            await deps.notify(`${config.symbol}: هدف سهم فقط ${targetPct.toFixed(1)}% - کمتر از حداقل ${minTarget}%.`);
            return;
        }

        try {
            await deps.options.onBuySignal({
                config,
                indicators: last.indicators,
                price: lastPrice,
                liveS: info ? info.price : null,
                tradeId: null,
                confluence,
                confirmers: confirmersList,
                signalScore: signalScoreResult   // 🆕 Phase 4
            });
        } catch (e) {
            await deps.notify(`انتخاب قرارداد ${config.symbol} ناموفق: ${e.message}`);
        }
    }
}

// ============================================================
// Bulk evaluation
// ============================================================
async function evaluateAll(marketInfo) {
    const db = deps.getDB();
    const configs = await db.collection(COLLECTIONS.STRATEGY_CONFIGS)
        .find({ enabled: true }).toArray();

    const confirmers = configs.filter(c => c.role === 'confirmer');
    const leaders = configs.filter(c => c.role !== 'confirmer');

    for (const c of confirmers) {
        try { await evaluateConfig(c, marketInfo); }
        catch (e) { deps.notify && deps.notify(`eval confirmer ${c.symbol}: ${e.message}`).catch(() => {}); }
    }
    for (const c of leaders) {
        try { await evaluateConfig(c, marketInfo); }
        catch (e) { deps.notify && deps.notify(`eval leader ${c.symbol}: ${e.message}`).catch(() => {}); }
    }

    return configs.length;
}

module.exports = { init, evaluateConfig, evaluateAll };