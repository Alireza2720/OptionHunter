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

// 🆕 cache رتبه‌ی صنایع (5 دقیقه)
let _sectorRankCache = { at: 0, data: null };
const SECTOR_RANK_TTL = 5 * 60 * 1000;

async function getSectorRanking() {
    const now = Date.now();
    if (_sectorRankCache.data && (now - _sectorRankCache.at) < SECTOR_RANK_TTL) {
        return _sectorRankCache.data;
    }
    try {
        const doc = await deps.getDB().collection(COLLECTIONS.META)
            .findOne({ _id: 'sector_ranking' });
        _sectorRankCache.data = doc;
        _sectorRankCache.at = now;
        return doc;
    } catch (_) {
        return null;
    }
}

function getSectorRankFor(sectorRanking, symbol) {
    if (!sectorRanking || !sectorRanking.symbols || !sectorRanking.ranked) return null;
    const symInfo = sectorRanking.symbols[symbol];
    if (!symInfo || !symInfo.sector) return null;
    const entry = sectorRanking.ranked.find(r => r.sector === symInfo.sector);
    return entry ? entry.rank : null;
}

// ============================================================
// 🆕 بررسی guard قبل از ارسال سیگنال BUY
// ============================================================
// ============================================================
// 🆕 Phase 6 — Regime Guard
// ============================================================
async function checkRegimeGuard(config) {
    if (!deps.regimeService) return { allowed: true, factor: 1.0, reason: 'regime service not wired' };

    try {
        const regime = await deps.regimeService.getForSymbol(config.symbol);
        if (!regime || !regime.macro || regime.macro === 'unknown') {
            return { allowed: true, factor: 0.7, reason: 'رژیم محاسبه نشده (70%)', regime: 'unknown' };
        }

        const regimeCore = require('./regime');
        const rf = regimeCore.regimeSizeFactor(config.strategyId, regime.macro, regime.vol);

        return {
            allowed: rf.factor > 0,
            factor: rf.factor,
            regime: `${regime.macro}/${regime.vol}`,
            macro: regime.macro,
            vol: regime.vol,
            reason: rf.reason
        };
    } catch (e) {
        deps.logger && deps.logger.warn('checkRegimeGuard: ' + e.message);
        return { allowed: true, factor: 1.0, error: e.message };
    }
}

async function checkSignalGuard(config, last, lastPrice, info) {
    try {
        const db = deps.getDB();
        const configId = config._id.toString();

        // 1) whitelist (اگه فعال باشه)
        const whitelist = deps.signalFilterService
            ? await deps.signalFilterService.getWhitelist()
            : null;

        if (whitelist && whitelist.pairs instanceof Set) {
            const key = `${config.symbol}::${config.strategyId}`;
            if (!whitelist.pairs.has(key)) {
                return {
                    allowed: false,
                    reason: `pair ${key} در whitelist نیست`,
                    violations: [{ rule: 'signalWhitelist', message: `pair در whitelist نیست` }]
                };
            }
        }

        // 2) duplicate — پوزیشن باز روی همین نماد
        const openPos = await db.collection(COLLECTIONS.OPTION_POSITIONS)
            .findOne({ underlying: config.symbol, status: 'open' });
        if (openPos) {
            return {
                allowed: false,
                reason: `پوزیشن باز روی ${config.symbol} وجود دارد`,
                violations: [{ rule: 'duplicate', message: 'پوزیشن باز' }]
            };
        }

        // 🆕 3) چک exposure کل و سرمایه
        const settings = deps.settings.get();
        const capital = deps.settings.capital();
        const maxTotalExposure = capital * (settings.MAX_TOTAL_EXPOSURE_PCT / 100);
        const minCashReserve = capital * (settings.MIN_CASH_RESERVE_PCT / 100);

        const openAll = await db.collection(COLLECTIONS.OPTION_POSITIONS)
            .find({ status: 'open' }).toArray();
        let totalExposure = 0;
        for (const p of openAll) {
            totalExposure += (p.entryAsk || 0) * (p.positionSize || 1) * (p.size || 1000);
        }

        if (totalExposure >= maxTotalExposure) {
            return {
                allowed: false,
                reason: `سقف کل درگیری پر شده (${(totalExposure/capital*100).toFixed(1)}% از ${settings.MAX_TOTAL_EXPOSURE_PCT}%)`,
                violations: [{ rule: 'exposure', message: 'سقف کل درگیری' }]
            };
        }

        if (capital - totalExposure < minCashReserve) {
            return {
                allowed: false,
                reason: `نقد ذخیره زیر حد مجاز (${(minCashReserve/capital*100).toFixed(0)}%)`,
                violations: [{ rule: 'cash', message: 'نقد کم' }]
            };
        }

        // ✅ اجازه بده — سایز دقیق در options layer محاسبه می‌شه
        return {
            allowed: true,
            reason: `whitelist + duplicate + exposure ok (${(totalExposure/capital*100).toFixed(1)}% درگیری)`,
            size: 1,
            sizing: { size: 1, limitReason: 'deferred to options layer' }
        };
    } catch (e) {
        deps.logger && deps.logger.warn('checkSignalGuard: ' + e.message);
        return { allowed: true, error: e.message };   // fail-open
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

    // 🆕 pair candles برای pairs_spread
    let pairCandles = null, pairSymbol = null;
    if (config.strategyId === 'pairs_spread' || config.pairSymbol) {
        pairSymbol = config.pairSymbol;
        if (pairSymbol) {
            try {
                pairCandles = deps.dataService.closedOnly(
                    await deps.dataService.getCandles(pairSymbol, config.timeframe),
                    config.timeframe
                );
            } catch (e) {
                deps.logger && deps.logger.warn('pair candles (live): ' + e.message);
            }
        }
    }

    // 🆕 sector peer candles برای sector_momentum
    let sectorPeerCandles = null;
    if (config.strategyId === 'sector_momentum') {
        try {
            const { getSectorPeers } = require('./sectors');
            const peers = getSectorPeers(config.symbol);
            sectorPeerCandles = {};
            for (const psym of peers) {
                const pc = deps.dataService.closedOnly(
                    await deps.dataService.getCandles(psym, config.timeframe),
                    config.timeframe
                );
                sectorPeerCandles[psym] = pc;
            }
        } catch (e) {
            deps.logger && deps.logger.warn('sector peers (live): ' + e.message);
        }
    }

    let result;
    try {
        result = def.run(
            candles,
            { ...config.params, candleType: config.candleType },
            {
                htfCandles, htfTimeframe: htfTf, entryWindow: ew,
                pairCandles,          // 🆕
                pairSymbol,           // 🆕
                sectorPeerCandles     // 🆕
            }
        );
    } catch (e) {
        deps.notify && deps.notify(`خطا در اجرای استراتژی ${config.symbol}: ${e.message}`).catch(() => {});
        return;
    }

    const prev = await stateColl.findOne({ configId });
    const latest = result.signals[result.signals.length - 1];
    if (!latest) return;

    // 🆕 فقط وقتی کندل بسته شده سیگنال معتبره
    const _sigTfMin = TIMEFRAME_MINUTES[config.timeframe] || 30;
    const _sigNowSec = Math.floor(Date.now() / 1000);
    const _sigLastCloseTime = latest.time + _sigTfMin * 60;

    if (_sigLastCloseTime > _sigNowSec) {
        // کندل در حال تشکیل — سیگنال رو skip کن (نه صادر کن، نه state رو خراب کن)
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
                reason: 'کندل در حال تشکیل — بدون سیگنال',
                lastSkippedAt: new Date(),
                lastSkipReason: 'candle_forming'
            }},
            { upsert: true }
        );
        return;
    }

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
            const r = deps.regimeService ? await deps.regimeService.getForSymbol(config.symbol) : null;
            // 🆕 رتبه‌ی صنعت
            const sectorRanking = await getSectorRanking();
            const sectorRank = getSectorRankFor(sectorRanking, config.symbol);

            signalScoreResult = scoreMod.computeSignalScore({
                confluenceEffective,
                htfTrend: result.htfTrend || null,
                atr: last.indicators && last.indicators.atr,
                price: lastPrice,
                rsiFast: last.indicators && last.indicators.rsiFast,
                ivHv: info && info.ivHv,
                regimeMacro: r ? r.macro : 'unknown',
                regimeVol: r ? r.vol : 'normal',
                sectorRank   // 🆕
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
        // ۱. Regime guard (soft — فقط خیلی خطرناک رو رد می‌کنه)
        const regimeResult = await checkRegimeGuard(config);
        if (!regimeResult.allowed) {
            const reasonText = `⛔ سیگنال ${config.symbol} رد شد (Regime خطرناک)\n${def.name}\nرژیم: ${regimeResult.regime}\nدلیل: ${regimeResult.reason}`;
            await deps.notify(reasonText);

            await db.collection(COLLECTIONS.SIGNAL_HISTORY).insertOne({
                configId, symbol: config.symbol,
                pairSymbol: config.pairSymbol || null,   // 🆕
                strategyId: config.strategyId, strategyName: def.name,
                timeframe: config.timeframe,
                signalType: last.signalType,
                price: lastPrice, time: last.time,
                reason: last.reason || null,
                rejected: true,
                rejectionReason: `Regime خطرناک: ${regimeResult.reason}`,
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
                pairSymbol: config.pairSymbol || null,   // 🆕
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
        pairSymbol: config.pairSymbol || null,   // 🆕
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

        // 🆕 رژیم‌محور: bear → skip، range → 1.5R، bull → 3R
        const regime = deps.regimeService ? await deps.regimeService.getForSymbol(config.symbol) : null;
        const macro = regime ? regime.macro : 'unknown';

        if (macro === 'bear') {
            await deps.notify(`${config.symbol}: رژیم نزولی — سیگنال آپشن داده نمی‌شود.`);
            return;
        }

        let targetMultiplier;
        if (macro === 'range') targetMultiplier = 1.5;
        else if (macro === 'bull') targetMultiplier = 3.0;
        else targetMultiplier = 2.0;   // unknown — محافظه‌کارانه

        const stop = last.indicators && last.indicators.stop;
        const atr = last.indicators && last.indicators.atr;
        const risk = stop && stop < lastPrice ? lastPrice - stop : (atr ? 2 * atr : lastPrice * 0.03);
        const targetPct = (risk * targetMultiplier / lastPrice) * 100;
        const minTarget = deps.minTargetPct();

        if (targetPct < minTarget) {
            await deps.notify(`${config.symbol}: هدف سهم فقط ${targetPct.toFixed(1)}% (${targetMultiplier}R در ${macro}) - کمتر از حداقل ${minTarget}%.`);
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
                signalScore: signalScoreResult,
                regimeFactor: regimeResult.factor || 1.0,
                regimeReason: regimeResult.reason,
                targetMultiplier   // 🆕
            });
        } catch (e) {
            await deps.notify(`انتخاب قرارداد ${config.symbol} ناموفق: ${e.message}`);
        }
    }
}

// ============================================================
// Bulk evaluation — با skip هوشمند (بدون از دست دادن سیگنال)
// ============================================================
async function evaluateAll(marketInfo) {
    const db = deps.getDB();
    const configs = await db.collection(COLLECTIONS.STRATEGY_CONFIGS)
        .find({ enabled: true }).toArray();

    const confirmers = configs.filter(c => c.role === 'confirmer');
    const leaders = configs.filter(c => c.role !== 'confirmer');

    // 🆕 بارگذاری state همه configها یک‌بار
    const stateColl = db.collection(COLLECTIONS.SIGNALS_STATE);
    const stateMap = new Map();
    try {
        const configIds = configs.map(c => c._id.toString());
        const states = await stateColl.find({ configId: { $in: configIds } }).toArray();
        for (const s of states) stateMap.set(s.configId, s);
    } catch (_) {}

    let skipped = 0, evaluated = 0;

    const evaluateOne = async (c, roleLabel) => {
        const cid = c._id.toString();
        const st = stateMap.get(cid);

        // 🆕 Skip اگه هیچ تغییر مفیدی نداره
        // نکته‌ی مهم: exit یا تغییر position همیشه چک می‌شه، فقط "warmup state" skip می‌شه
        if (st && st.position !== 'LONG' && st.updatedAt && !st.insufficientData) {
            const sinceUpdate = Date.now() - new Date(st.updatedAt).getTime();
            const info = marketInfo && marketInfo.get(c.symbol);
            const currentPrice = info ? info.price : null;
            // فقط اگه 30s نگذشته و قیمت همون قبلیه و کندل جدیدی نیومده
            if (sinceUpdate < 30000 && currentPrice && st.livePrice === currentPrice) {
                skipped++;
                return;
            }
        }

        try {
            await evaluateConfig(c, marketInfo);
            evaluated++;
        } catch (e) {
            deps.notify && deps.notify(`eval ${roleLabel} ${c.symbol}: ${e.message}`).catch(() => {});
        }
    };

    for (const c of confirmers) await evaluateOne(c, 'confirmer');
    for (const c of leaders) await evaluateOne(c, 'leader');

    if (skipped > 0 && deps.logger) {
        deps.logger.info(`signal eval: ${evaluated} evaluated, ${skipped} skipped (no change)`);
    }

    return { total: configs.length, evaluated, skipped };
}

module.exports = { init, evaluateConfig, evaluateAll };