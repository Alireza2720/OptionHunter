'use strict';
// ============================================================
// server.js — Bootstrap نهایی برنامه
// ============================================================
// - راه‌اندازی همه سرویس‌ها از طریق bootstrap
// - ساخت Express app از api/index
// - اجرای job ها
// - Graceful shutdown
// ============================================================

const { createApp } = require('./api');
const bootstrapModule = require('./bootstrap');
const { LIMITS } = require('./config/constants');

let server = null;
let deps = null;
let shuttingDown = false;

const SERVER_VERSION = 'v10.0-clean';

async function start() {
    try {
        // 1) bootstrap
        deps = await bootstrapModule.bootstrap();
        const { env, logger, telegram } = deps;

        // 2) build express app
        const app = createApp({
            // deps
            getDB: deps.mongo.getDB,
            logger: deps.logger,
            telegram: deps.telegram,
            algotik: deps.algotik,
            optionsChain: deps.optionsChain,
            options: deps.options,
            signals: deps.signals,
            backtest: deps.backtest,
            dataService: deps.dataService,
            settings: deps.settingsService,
            configService: deps.configService,
            backtestService: deps.backtestService,
            signalService: deps.signalService,
            analysisService: deps.analysisService,
            portfolioService: deps.portfolioService,
            correlationService: deps.correlationService,
            signalFilterService: deps.signalFilterService,
            wfService: deps.wfService,
            regimeService: deps.regimeService,
            autoConfigJob: deps.autoConfigJob,
            strategies: deps.strategies,
            getUnderlyingNames: deps.getUnderlyingNames,
            pipelineService: deps.pipelineService,     // 🆕

            // config
            adminToken: env.ADMIN_TOKEN,
            version: SERVER_VERSION,
            startedAt: new Date(),
            reloadEntryWindow: async () => {
                // settings در DB ذخیره شده و entryWindow از settingsService میاد
                // پس نیازی به reload نیست
            }
        });

        // 3) listen
        server = app.listen(env.PORT, env.HOST, () => {
            logger.info(`${SERVER_VERSION} | port ${env.PORT} | host ${env.HOST}`);
        });

        server.keepAliveTimeout = LIMITS.KEEPALIVE_TIMEOUT;
        server.headersTimeout = LIMITS.KEEPALIVE_TIMEOUT + 60000;
        server.requestTimeout = LIMITS.HTTP_TIMEOUT;

        // 4) resume stuck jobs
        try {
            const n = await deps.backtestService.resumeStuckJobs();
            if (n) logger.info(`resumed ${n} stuck jobs`);
            deps.backtestService.processQueue().catch(e =>
                logger.error('queue: ' + e.message)
            );
        } catch (e) {
            logger.error('resumeStuckJobs: ' + e.message);
        }

        // 5) start cron jobs
        deps.tickJob.start();
        deps.eodJob.start();
        deps.autoConfigJob.start();
        if (deps.riskFreeJob) deps.riskFreeJob.start();
        if (deps.healthJob) deps.healthJob.start();   // 🆕
        if (deps.correlationJob) deps.correlationJob.start();
        if (deps.regimeJob) deps.regimeJob.start();
        if (deps.driftJob) deps.driftJob.start();
        if (deps.dailyBackfillJob) deps.dailyBackfillJob.start();
        if (deps.driftJob) deps.driftJob.start();     // 🆕

        // 6) startup notification
        await deps.telegram.notify(`سرور ری استارت شد (${SERVER_VERSION})`).catch(() => {});

        // 7) graceful shutdown
        process.on('SIGTERM', () => shutdown('SIGTERM'));
        process.on('SIGINT', () => shutdown('SIGINT'));
        process.on('uncaughtException', (e) => {
            logger.error('uncaughtException: ' + (e.stack || e.message));
        });
        process.on('unhandledRejection', (r) => {
            logger.error('unhandledRejection: ' + (r && r.stack ? r.stack : r));
        });

        return server;
    } catch (e) {
        console.error('❌ FATAL startup:', e);
        process.exit(1);
    }
}

async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;

    const logger = deps && deps.logger;
    if (logger) logger.info(`shutdown (${signal})`);

    // بستن سرور HTTP
    try {
        await new Promise((resolve) => {
            if (!server) return resolve();
            server.close(() => resolve());
            // force close بعد از ۱۰ ثانیه
            setTimeout(resolve, 10000);
        });
    } catch (_) {}

    // بستن اتصال MongoDB
    try {
        if (deps && deps.mongo) await deps.mongo.close();
    } catch (_) {}

    if (logger) logger.info('shutdown complete');
    process.exit(0);
}

start();