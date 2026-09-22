'use strict';
// ============================================================
// constants.js — ثابت‌های سراسری برنامه
// ============================================================

// ---- تایم‌فریم‌ها ----
const TIMEFRAME_MINUTES = {
    '1m': 1, '3m': 3, '5m': 5, '10m': 10,
    '15m': 15, '30m': 30, '1h': 60, '1d': 1440
};

const ALL_CHART_TIMEFRAMES = {
    ...TIMEFRAME_MINUTES,
    '1w': 10080, '1M': 43200, '1Y': 525600
};

const TF_LABELS_FA = {
    '1m': '1 دقیقه', '3m': '3 دقیقه', '5m': '5 دقیقه', '10m': '10 دقیقه',
    '15m': '15 دقیقه', '30m': '30 دقیقه', '1h': '1 ساعت', '1d': 'روزانه',
    '1w': 'هفتگی', '1M': 'ماهانه', '1Y': 'سالانه'
};

// ---- ساعات بازار ----
const SESSION_START_MIN = 9 * 60;          // 09:00
const SESSION_END_MIN = 12 * 60 + 30;      // 12:30
const TRADING_DAYS_PER_YEAR = 245;

// ---- تایم‌زون ----
const TEHRAN_TZ = 'Asia/Tehran';
const TEHRAN_OFFSET_MINUTES = 210;         // UTC+3:30

// ---- Job ----
const JOB_STATUS = {
    QUEUED: 'QUEUED',
    RUNNING: 'RUNNING',
    PAUSED: 'PAUSED',
    DONE: 'DONE',
    FAILED: 'FAILED',
    CANCELLED: 'CANCELLED'
};

const JOB_TYPE = {
    BACKTEST: 'backtest',
    AUTO_CONFIG: 'auto-config',
    BACKTEST_COMPARE: 'backtest-compare'
};

const ACTIVE_JOB_STATUSES = [JOB_STATUS.QUEUED, JOB_STATUS.RUNNING, JOB_STATUS.PAUSED];
const FINISHED_JOB_STATUSES = [JOB_STATUS.DONE, JOB_STATUS.FAILED, JOB_STATUS.CANCELLED];

// ---- کش ----
const CACHE_TTL = {
    SYMBOLS_SEARCH: 24 * 60 * 60 * 1000,     // 24 ساعت
    DAILY_HISTORY: 60 * 60 * 1000,           // 1 ساعت
    OPTION_CHAIN: 60 * 1000,                 // 1 دقیقه
    LIVE_MARKET: 15 * 1000,                  // 15 ثانیه
    BACKTEST_RESULT: 7 * 24 * 60 * 60 * 1000 // 7 روز
};

// ---- Collections ----
const COLLECTIONS = {
    META: 'meta',
    LOGS: 'logs',
    CANDLES_BASE: 'candles_base',
    CANDLES_DAILY: 'candles_daily',
    CANDLES_TF: 'candles_tf',
    MONITORED_SYMBOLS: 'monitored_symbols',
    STRATEGY_CONFIGS: 'strategy_configs',
    SIGNALS_STATE: 'signals_state',
    SIGNAL_HISTORY: 'signal_history',
    BACKTEST_JOBS: 'backtest_jobs',
    BACKTEST_COMPARE_DETAILS: 'backtest_compare_details',
    BACKTEST_TRADE_CACHE: 'backtest_trade_cache',
    BACKTEST_RESULT_CACHE: 'backtest_result_cache',
    OPTION_SNAPSHOTS: 'option_snapshots',
    OPTION_HISTORY: 'option_history',
    OPTION_DAILY: 'option_daily',
    OPTION_POSITIONS: 'option_positions',
    OPTION_SNAPSHOTS_ALGOTIK: 'option_snapshots_algotik',
    OPTION_DAILY_ALGOTIK: 'option_daily_algotik',
    TSETMC_FETCH_LOG: 'tsetmc_fetch_log',
    TELEGRAM_OUTBOX: 'telegram_outbox'
};

// ---- برچسب‌های خطا ----
const ERROR_CODES = {
    CANCELED_BY_USER: 'CANCELLED_BY_USER',
    INSUFFICIENT_DATA: 'INSUFFICIENT_DATA',
    SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE'
};

// ---- محدودیت‌های امنیتی ----
const LIMITS = {
    MAX_JSON_BODY: '5mb',
    DEFAULT_PAGE_SIZE: 50,
    MAX_PAGE_SIZE: 200,
    LOG_RING_SIZE: 300,
    HTTP_TIMEOUT: 30 * 60 * 1000,            // 30 دقیقه برای backtest
    KEEPALIVE_TIMEOUT: 10 * 60 * 1000
};

module.exports = {
    TIMEFRAME_MINUTES,
    ALL_CHART_TIMEFRAMES,
    TF_LABELS_FA,
    SESSION_START_MIN,
    SESSION_END_MIN,
    TRADING_DAYS_PER_YEAR,
    TEHRAN_TZ,
    TEHRAN_OFFSET_MINUTES,
    JOB_STATUS,
    JOB_TYPE,
    ACTIVE_JOB_STATUSES,
    FINISHED_JOB_STATUSES,
    CACHE_TTL,
    COLLECTIONS,
    ERROR_CODES,
    LIMITS
};