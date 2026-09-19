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

// settings (ساده — از فایل اصلی)
const settingsModule = require('./settings');

// jobs
const tickJob = require('./jobs/tick.job');
const eodJob = require('./jobs/eod.job');
const autoConfigJob = require('./jobs/auto-config.job');

// strategies
const strategiesModule = require('./strategies');

let booted = false;

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
        entryWindow: () => settingsModule.entryWindow()
    });

    // 10) signals core
    signalsCore.init({
        getDB: mongo.getDB,
        strategies: strategiesBundle,
        dataService,
        options: optionsCore,
        settings: settingsModule,
        notify: telegram.notify,
        entryWindow: () => settingsModule.entryWindow(),
        confluenceWindow: () => settingsModule.confluenceTimeWindow(),
        multiConfirmerMin: () => settingsModule.multiConfirmerMin(),
        minTargetPct: () => settingsModule.minTargetPct()
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
        // jobs
        tickJob,
        eodJob,
        autoConfigJob,
        // misc
        strategies: strategiesModule,
        getUnderlyingNames,
        loadSymbolsCache
    };
}

module.exports = { bootstrap, getUnderlyingNames, loadSymbolsCache };