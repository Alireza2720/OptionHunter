'use strict';
// ============================================================
// mongo.js — اتصال و مدیریت MongoDB
// ============================================================
// - اتصال singleton
// - ساخت ایندکس‌ها
// - پاکسازی collection های قدیمی
// ============================================================

const { MongoClient } = require('mongodb');
const { COLLECTIONS } = require('../config/constants');

const DB_NAME = 'trading_bot';

let client = null;
let db = null;

async function connect(uri) {
    if (db) return db;
    if (!uri) throw new Error('MONGO_URI تنظیم نشده است.');

    client = new MongoClient(uri, {
        maxPoolSize: 10,
        minPoolSize: 2,
        serverSelectionTimeoutMS: 5000
    });
    await client.connect();
    db = client.db(DB_NAME);

    await ensureIndexes();
    await cleanupLegacy();

    return db;
}

function getDB() {
    if (!db) throw new Error('دیتابیس هنوز متصل نشده است.');
    return db;
}

async function close() {
    if (client) {
        await client.close();
        client = null;
        db = null;
    }
}

async function ensureIndexes() {
    // --- کندل‌ها ---
    try { await db.collection(COLLECTIONS.CANDLES_BASE).dropIndex('time_1'); } catch (_) {}
    await db.collection(COLLECTIONS.CANDLES_BASE).createIndex({ time: 1 });
    await db.collection(COLLECTIONS.CANDLES_BASE).createIndex({ symbol: 1, time: 1 }, { unique: true });
    await db.collection(COLLECTIONS.CANDLES_BASE).createIndex({ source: 1 });

    await db.collection(COLLECTIONS.CANDLES_DAILY).createIndex({ symbol: 1, time: 1 }, { unique: true });

    await db.collection(COLLECTIONS.CANDLES_TF).createIndex({ symbol: 1, tf: 1, time: 1 }, { unique: true });

    // --- سیگنال‌ها ---
    await db.collection(COLLECTIONS.SIGNAL_HISTORY).createIndex({ createdAt: -1 });
    await db.collection(COLLECTIONS.SIGNAL_HISTORY).createIndex({ symbol: 1, createdAt: -1 });
    await db.collection(COLLECTIONS.SIGNALS_STATE).createIndex({ configId: 1 }, { unique: true });

    // --- کانفیگ‌ها ---
    await db.collection(COLLECTIONS.STRATEGY_CONFIGS).createIndex({ symbol: 1 });
    await db.collection(COLLECTIONS.STRATEGY_CONFIGS).createIndex({ enabled: 1 });
    await db.collection(COLLECTIONS.MONITORED_SYMBOLS).createIndex({ symbol: 1 }, { unique: true });

    // --- Jobs ---
    await db.collection(COLLECTIONS.BACKTEST_JOBS).createIndex({ status: 1, createdAt: 1 });
    await db.collection(COLLECTIONS.BACKTEST_JOBS).createIndex({ createdAt: -1 });
    await db.collection(COLLECTIONS.BACKTEST_JOBS).createIndex({ 'progress.chunks.status': 1 });

    // --- کش ----
    await db.collection(COLLECTIONS.BACKTEST_TRADE_CACHE).createIndex({ computedAt: 1 });
    await db.collection(COLLECTIONS.BACKTEST_TRADE_CACHE).createIndex({ 'signature.symbol': 1 });
    await db.collection(COLLECTIONS.BACKTEST_RESULT_CACHE).createIndex(
        { createdAt: 1 },
        { expireAfterSeconds: 7 * 86400 }
    );

    // --- آپشن ---
    await db.collection(COLLECTIONS.OPTION_SNAPSHOTS).createIndex({ symbol: 1, time: 1 });
    await db.collection(COLLECTIONS.OPTION_SNAPSHOTS).createIndex({ time: 1 });
    await db.collection(COLLECTIONS.OPTION_DAILY).createIndex({ symbol: 1, date: 1 }, { unique: true });
    await db.collection(COLLECTIONS.OPTION_DAILY).createIndex({ underlying: 1, date: 1 });
    await db.collection(COLLECTIONS.OPTION_POSITIONS).createIndex({ status: 1, configId: 1 });
    await db.collection(COLLECTIONS.OPTION_HISTORY).createIndex({ symbol: 1, time: 1 });
    await db.collection(COLLECTIONS.OPTION_HISTORY).createIndex({ underlying: 1, time: 1 });
    await db.collection(COLLECTIONS.OPTION_HISTORY).createIndex({ time: 1 });

    // --- Telegram ---
    await db.collection(COLLECTIONS.TELEGRAM_OUTBOX).createIndex({ sentAt: 1, createdAt: 1 });

    // --- TSETMC ---
    await db.collection(COLLECTIONS.TSETMC_FETCH_LOG).createIndex({ symbol: 1, date: 1 });
    await db.collection(COLLECTIONS.TSETMC_FETCH_LOG).createIndex({ createdAt: -1 });
    await db.collection(COLLECTIONS.TSETMC_FETCH_LOG).createIndex({ symbol: 1, date: 1, status: 1 });

    // --- لاگ‌ها ---
    try { await db.collection(COLLECTIONS.LOGS).dropIndex('at_1'); } catch (_) {}
    await db.collection(COLLECTIONS.LOGS).createIndex({ at: 1 });
    await db.collection(COLLECTIONS.LOGS).createIndex({ level: 1, at: -1 });
}

async function cleanupLegacy() {
    try {
        // حذف meta های قدیمی
        await db.collection(COLLECTIONS.META).deleteMany({
            _id: { $in: ['candlestick_usage', 'allsymbols_usage', 'history_usage_key1', 'history_usage_key2', 'history_usage_key3'] }
        });

        // حذف collection های منسوخ
        const legacyCollections = ['seed_log'];
        for (const name of legacyCollections) {
            const cols = await db.listCollections({ name }).toArray();
            if (cols.length) await db.collection(name).drop();
        }
    } catch (_) { /* بی‌اهمیت */ }
}

module.exports = { connect, getDB, close, ensureIndexes };