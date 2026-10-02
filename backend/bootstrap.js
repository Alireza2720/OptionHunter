'use strict';
// ============================================================
// bootstrap.js — Wire up همه dependency ها
// ============================================================
// این فایل تنها جاییه که init() و dependency تزریق می‌شه.
// server.js از این استفاده می‌کنه.
// ============================================================

const { TIMEFRAME_MINUTES, COLLECTIONS } = require('./config/constants');
const env = require('./config/env');

// infra
const mongo = require('./infra/mongo');
const logger = require('./infra/logger');
const telegram = require('./infra/telegram');
const algotik = require('./infra/algotik');
const optionsChain = require('./infra/options-chain');

// core
const optionsCore = require('./core/options');
const signalsCore = require('./core/signals');
const backtestCore = require('./core/backtest');

// services
const dataService = require('./services/data.service');
const configService = require('./services/config.service');
const backtestService = require('./services/backtest.service');
const signalService = require('./services/signal.service');
const analysisService = require('./services/analysis.service');
const portfolioService = require('./services/portfolio.service');
const correlationService = require('./services/correlation.service');
const signalFilterService = require('./services/signal-filter.service');
const wfService = require('./services/wf.service');
const regimeService = require('./services/regime.service');
const dailyBackfillJob = require('./jobs/daily-backfill.job');
const gapDetectorJob = require('./jobs/gap-detector.job');
const monthlyReportJob = require('./jobs/monthly-report.job');
const retentionJob = require('./jobs/retention.job');
const journalService = require('./services/journal.service');
const journalUpdaterJob = require('./jobs/journal-updater.job');
const executionGuard = require('./core/execution-guard');
const pipelineService = require('./services/pipeline.service');
const backtestOrchestrator = require('./services/backtest-orchestrator.service');
const dualStageService = require('./services/dual-stage-pipeline.service');

// settings (ساده — از فایل اصلی)
const settingsModule = require('./settings');

// jobs
const tickJob = require('./jobs/tick.job');
const eodJob = require('./jobs/eod.job');
const autoConfigJob = require('./jobs/auto-config.job');
const riskFreeJob = require('./jobs/risk-free.job');
const healthJob = require('./jobs/health.job');
const correlationJob = require('./jobs/correlation.job');
const regimeJob = require('./jobs/regime.job');
const driftJob = require('./jobs/drift.job');
const sectorRankJob = require('./jobs/sector-rank.job');   // 🆕

// strategies
const strategiesModule = require('./strategies');

let booted = false;

// ============================================================
// 🆕 Cleanup stale meta & cache after strategy updates
// ============================================================
async function cleanupStaleMeta(logger) {
    try {
        const db = mongo.getDB();
        const validList = Object.keys(strategiesModule.STRATEGIES);
        const validSet = new Set(validList);
        let totalCleaned = 0;

        // 1) signal_whitelist — pairهای حاوی استراتژی حذف‌شده
        const sw = await db.collection(COLLECTIONS.META).findOne({ _id: 'signal_whitelist' });
        if (sw && Array.isArray(sw.pairs)) {
            const validPairs = sw.pairs.filter(p => {
                const parts = String(p).split('::');
                return parts.length === 2 && validSet.has(parts[1]);
            });
            if (validPairs.length !== sw.pairs.length) {
                const dropped = sw.pairs.length - validPairs.length;
                logger.info(`cleanup: signal_whitelist dropping ${dropped} stale pairs`);
                if (validPairs.length === 0) {
                    await db.collection(COLLECTIONS.META).deleteOne({ _id: 'signal_whitelist' });
                } else {
                    await db.collection(COLLECTIONS.META).updateOne(
                        { _id: 'signal_whitelist' },
                        { $set: { pairs: validPairs, cleanedAt: new Date() } }
                    );
                }
                totalCleaned += dropped;
            }
        }

        // 2) wf_strategy_whitelist — استراتژی‌های حذف‌شده
        const wf = await db.collection(COLLECTIONS.META).findOne({ _id: 'wf_strategy_whitelist' });
        if (wf && Array.isArray(wf.strategies)) {
            const valid = wf.strategies.filter(sid => validSet.has(sid));
            if (valid.length !== wf.strategies.length) {
                const dropped = wf.strategies.length - valid.length;
                logger.info(`cleanup: wf_whitelist dropping ${dropped} stale strategies`);
                if (valid.length === 0) {
                    await db.collection(COLLECTIONS.META).deleteOne({ _id: 'wf_strategy_whitelist' });
                } else {
                    await db.collection(COLLECTIONS.META).updateOne(
                        { _id: 'wf_strategy_whitelist' },
                        { $set: { strategies: valid, cleanedAt: new Date() } }
                    );
                }
                totalCleaned += dropped;
            }
        }

        // 3) backtest_trade_cache — entryهای استراتژی‌های حذف‌شده
        try {
            const cacheRes = await db.collection(COLLECTIONS.BACKTEST_TRADE_CACHE).deleteMany({
                'signature.strategyId': { $nin: validList }
            });
            if (cacheRes.deletedCount > 0) {
                logger.info(`cleanup: backtest_trade_cache removed ${cacheRes.deletedCount} stale`);
                totalCleaned += cacheRes.deletedCount;
            }
        } catch (_) {}

        // 4) backtest_result_cache — کش‌های قدیمی‌تر از 7 روز (خودکار توسط TTL ولی برای اطمینان)
        try {
            const res = await db.collection(COLLECTIONS.BACKTEST_RESULT_CACHE).deleteMany({
                createdAt: { $lt: new Date(Date.now() - 7 * 86400 * 1000) }
            });
            if (res.deletedCount > 0) {
                logger.info(`cleanup: backtest_result_cache removed ${res.deletedCount} old`);
            }
        } catch (_) {}

        // 5) signal_whitelist cache در حافظه پاک می‌شه
        try {
            const sf = require('./services/signal-filter.service');
            if (sf && typeof sf.clear === 'function') {
                // هیچ کاری نمی‌کنیم چون هر بار از DB می‌خونه
            }
        } catch (_) {}

        if (totalCleaned > 0) {
            logger.info(`cleanup: total ${totalCleaned} items cleaned`);
        }
        return totalCleaned;
    } catch (e) {
        logger.warn('cleanupStaleMeta: ' + e.message);
        return 0;
    }
}

// ============================================================
// Symbols cache (sync access from getUnderlyingNames)
// ============================================================
let symbolsCache = [];
let symbolsCacheMap = new Map();    // برای O(1) lookup

async function loadSymbolsCache() {
    try {
        const doc = await mongo.getDB().collection(COLLECTIONS.META)
            .findOne({ _id: 'symbols_cache' });
        symbolsCache = (doc && doc.symbols) || [];
        symbolsCacheMap = new Map(symbolsCache.map(s => [s.symbol, s]));
        logger.info(`symbols cache loaded: ${symbolsCache.length}`);
    } catch (e) {
        logger.warn('symbols cache: ' + e.message);
        symbolsCache = [];
        symbolsCacheMap = new Map();
    }

    // 🆕 auto-sync: هر نمادی که در strategy_configs هست ولی در monitored_symbols نیست رو اضافه کن
    try {
        const db = mongo.getDB();
        const configSyms = await db.collection(COLLECTIONS.STRATEGY_CONFIGS)
            .distinct('symbol');
        const monitoredSyms = new Set(
            (await db.collection(COLLECTIONS.MONITORED_SYMBOLS)
                .find({}, { projection: { symbol: 1 } }).toArray())
                .map(x => x.symbol)
        );
        const missing = configSyms.filter(s => s && !monitoredSyms.has(s));
        if (missing.length) {
            const docs = missing.map(s => ({
                symbol: s,
                name: s,
                enabled: true,
                collectEnabled: true,
                addedAt: new Date(),
                autoSynced: true,
            }));
            await db.collection(COLLECTIONS.MONITORED_SYMBOLS).insertMany(docs, { ordered: false });
            logger.info(`auto-sync: added ${missing.length} symbols from configs → monitored: ${missing.join(', ')}`);
        } else {
            logger.info(`auto-sync: monitored_symbols already in sync (${monitoredSyms.size} symbols)`);
        }
    } catch (e) {
        logger.warn('auto-sync symbols: ' + e.message);
    }
}

function getUnderlyingNames(symbol) {
    const names = new Set([optionsCore.norm(symbol)]);
    const found = symbolsCacheMap.get(symbol);
    if (found && found.name) names.add(optionsCore.norm(found.name));
    return Array.from(names);
}

// ============================================================
// Main bootstrap
// ============================================================
async function bootstrap() {
    if (booted) throw new Error('bootstrap already called');
    booted = true;

    // 1) env
    env.load();
    env.validate();
    const envConf = env.get();

    // 2) logger (اول از همه تا خطاها ثبت شن)
    logger.patchConsole();
    logger.init(() => mongo.getDB());

    // 3) mongo
    await mongo.connect(envConf.MONGO_URI);

    // 4) infra clients
    telegram.init(() => mongo.getDB());
    algotik.setBaseUrl(envConf.ALGOTIK_URL);
    optionsChain.setUrl(envConf.OPTIONS_API_URL);

    // 5) settings (مستقیم از settings.js)
    settingsModule.init({ getDB: mongo.getDB });
    await settingsModule.load();

    // 6) data service
    dataService.init({
        getDB: mongo.getDB,
        algotik,
        logger
    });

    // 7) options core
    optionsCore.init({
        getDB: mongo.getDB,
        notify: telegram.notify,
        settings: settingsModule,
        timeframeMinutes: TIMEFRAME_MINUTES,
        todayDateString: () => signalService.todayDateStr(),
        getQuote: (sym) => signalService.getLastQuotes().get(sym),
        getUnderlyingNames,
        getChain: async () => optionsChain.fetchChain(60000)
    });

    // 8) strategies bundle
    const strategiesBundle = {
        STRATEGIES: strategiesModule.STRATEGIES,
        getRequiredCandles: strategiesModule.getRequiredCandles,
        getRequiredHtfCandles: strategiesModule.getRequiredHtfCandles,
        TIMEFRAME_MINUTES
    };

    // 9) backtest core
    backtestCore.init({
        getDB: mongo.getDB,
        strategies: strategiesBundle,
        dataService,
        options: optionsCore,
        entryWindow: () => settingsModule.entryWindow(),
        getTehranParts: dataService.getTehranParts
    });

    // 9.5) regime service — قبل از signalsCore
    regimeService.init({
        getDB: mongo.getDB,
        logger
    });

    // 10) signals core (با guard مشترک)
    signalsCore.init({
        getDB: mongo.getDB,
        strategies: strategiesBundle,
        dataService,
        options: optionsCore,
        settings: settingsModule,
        notify: telegram.notify,
        logger,   // 🆕 برای دیباگ
        entryWindow: () => settingsModule.entryWindow(),
        confluenceWindow: () => settingsModule.confluenceTimeWindow(),
        multiConfirmerMin: () => settingsModule.multiConfirmerMin(),
        minTargetPct: () => settingsModule.minTargetPct(),
        executionGuard,
        signalFilterService,
        correlationService,
        regimeService   // 🆕 Phase 6
    });

    // 11) services
    configService.init({
        getDB: mongo.getDB,
        strategies: strategiesBundle,
        settings: settingsModule,
        backtest: backtestCore,
        logger
    });

    backtestService.init({
        getDB: mongo.getDB,
        strategies: strategiesBundle,
        backtest: backtestCore,
        options: optionsCore,
        dataService,
        signals: signalsCore,
        settings: settingsModule,
        logger,
        notify: telegram.notify
    });

    signalService.init({
        getDB: mongo.getDB,
        dataService,
        signals: signalsCore,
        options: {
            ...optionsCore,
            fetchChain: optionsChain.fetchChain,
            norm: optionsCore.norm
        },
        algotik,
        settings: settingsModule,
        notify: telegram.notify,
        logger
    });

    // 11.5) analysis service (Phase 1)
    analysisService.init({
        getDB: mongo.getDB,
        logger
    });

    // 11.5.5) signal filter service
    signalFilterService.init({
        getDB: mongo.getDB,
        logger,
        analysisService
    });

    // 11.9) walk-forward service (Phase 5)
    wfService.init({
        getDB: mongo.getDB,
        logger,
        signalFilterService
    });

    // 11.11) regime job
    regimeJob.init({
        regimeService,
        logger
    });

    // 11.12) drift job
    driftJob.init({
        getDB: mongo.getDB,
        logger,
        notify: telegram.notify
    });

    // 11.12.5) sector-rank job 🆕
    sectorRankJob.init({
        getDB: mongo.getDB,
        dataService,
        logger
    });

    // daily-backfill
    dailyBackfillJob.init({
        logger,
        algotik,
        notify: telegram.notify
    });

    gapDetectorJob.init({
        getDB: mongo.getDB,
        algotik,
        logger,
        notify: telegram.notify
    });

    monthlyReportJob.init({
        getDB: mongo.getDB,
        logger,
        notify: telegram.notify
    });

    retentionJob.init({
        getDB: mongo.getDB,
        logger
    });

    // 11.13) pipeline service
    pipelineService.init({
        getDB: mongo.getDB,
        logger,
        backtestService,
        analysisService,
        wfService,
        regimeService,
        portfolioService,
        signalFilterService,
        notify: telegram.notify
    });

    // 🆕 11.13.5) dual-stage pipeline
    dualStageService.init({
        getDB: mongo.getDB,
        logger,
        backtest: backtestCore,
        backtestService,
        analysisService,
        signalFilterService,
        configService,
        settings: settingsModule,
        notify: telegram.notify
    });

    journalService.init({ getDB: mongo.getDB, logger });
    journalUpdaterJob.init({ journalService, logger });

    backtestOrchestrator.init({
        getDB: mongo.getDB,
        logger,
        backtestService,
        analysisService,
        wfService,
        regimeService,
        portfolioService,
        signalFilterService,
        notify: telegram.notify   // 🆕
    });

    // refresh اولیه (async — non-blocking)
    regimeService.refreshAll().catch(e =>
        logger.warn('initial regime refresh: ' + e.message)
    );

    // 🆕 Warm-up: coverage رو از هر دو مسیر پر کن
    setTimeout(() => {
        // 1) مستقیم از collector (cache روی collector)
        algotik.getCoverage()
            .then(() => logger.info('✅ coverage cache warmed (collector)'))
            .catch(e => logger.warn('coverage warmup: ' + e.message));

        // 🆕 2) از مسیر dataService.cached (cache مشترک backend)
        //    چون /api/monitored-symbols و /api/algotik/coverage از این استفاده می‌کنن
        dataService.cached('coverage', 15 * 60 * 1000, () => algotik.getCoverage())
            .then(() => logger.info('✅ coverage cache warmed (backend)'))
            .catch(e => logger.warn('coverage warmup backend: ' + e.message));
    }, 3000);

    // 11.6) correlation service (Phase 3 Step 2)
    correlationService.init({
        getDB: mongo.getDB,
        logger
    });

    // 11.7) portfolio service (Phase 3)
    portfolioService.init({
        getDB: mongo.getDB,
        logger,
        settings: settingsModule,
        correlationService,
        analysisService,
        signalFilterService,
        regimeService   // 🆕 Phase 6
    });

    // 11.8) correlation job
    correlationJob.init({
        correlationService,
        logger
    });

    // initial correlation compute (async, non-blocking)
    correlationService.computeAndStore(30).catch(e =>
        logger.warn('initial correlation compute: ' + e.message)
    );

    // 12) jobs
    tickJob.init({
        getDB: mongo.getDB,
        signalService,
        dataService,
        algotik,
        logger,
        notify: telegram.notify
    });

    eodJob.init({
        getDB: mongo.getDB,
        signalService,
        dataService,
        options: {
            ...optionsCore,
            fetchChain: optionsChain.fetchChain,
            norm: optionsCore.norm
        },
        settings: settingsModule,
        configService,
        logger,
        notify: telegram.notify,
        telegram
    });

    autoConfigJob.init({
        getDB: mongo.getDB,
        backtestService,
        configService,
        settings: settingsModule,
        notify: telegram.notify,
        telegram,
        logger
    });

    // 🆕 risk-free job
    riskFreeJob.init({
        getDB: mongo.getDB,
        settings: settingsModule,
        logger
    });
    // 🆕 health job
    healthJob.init({
        algotik,
        telegram,
        logger,
        getDB: mongo.getDB
    });

    // refresh اولیه (async)
    await riskFreeJob.refresh().catch(e =>
        logger.warn('risk-free initial refresh: ' + e.message)
    );
    // 13) symbols cache
    await loadSymbolsCache();

    // 14) بازیابی state
    // holiday
    try {
        const holDoc = await mongo.getDB().collection(COLLECTIONS.META)
            .findOne({ _id: 'holiday' });
        if (holDoc && holDoc.date) {
            signalService.loadHoliday();
            logger.info(`holiday restored: ${holDoc.date}`);
        }
    } catch (_) { /* بی‌اهمیت */ }

    // 15) clean orphans
    try {
        const n = await configService.cleanOrphans();
        if (n) logger.info(`cleaned ${n} orphan configs`);
    } catch (_) {}

    // 15.5) 🆕 cleanup stale meta & cache (بعد از هر تغییر استراتژی)
    try {
        await cleanupStaleMeta(logger);
    } catch (e) {
        logger.warn('cleanup stale meta: ' + e.message);
    }

    logger.info('bootstrap complete');

    // برگرداندن همه deps
    return {
        env: envConf,
        mongo,
        logger,
        telegram,
        algotik,
        optionsChain,
        // core
        options: optionsCore,
        signals: signalsCore,
        backtest: backtestCore,
        // services
        dataService,
        settingsService: settingsModule,
        configService,
        backtestService,
        signalService,
        analysisService,
        portfolioService,
        correlationService,
        correlationJob,
        signalFilterService,
        wfService,
        regimeService,
        regimeJob,
        // jobs
        tickJob,
        eodJob,
        autoConfigJob,
        riskFreeJob,
        healthJob,
        correlationJob,
        regimeJob,
        driftJob,
        sectorRankJob,   // 🆕
        dailyBackfillJob,
        gapDetectorJob,
        monthlyReportJob,
        retentionJob,
        journalService,
        journalUpdaterJob,
        // misc
        strategies: strategiesModule,
        pipelineService,      // 🆕
        backtestOrchestrator, // 🆕
        dualStageService,     // 🆕
    };
}

module.exports = { bootstrap, getUnderlyingNames, loadSymbolsCache };