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
// ----------------------------------------------------------------
// Idempotent index helper — هم‌راست با collector/pipeline/db.py
// ----------------------------------------------------------------
async function safeCreateIndex(collection, keys, options = {}) {
    try {
        await collection.createIndex(keys, options);
        return true;
    } catch (e) {
        const msg = String(e.message || '');
        if (
            e.code === 86 ||                          // IndexKeySpecsConflict
            e.code === 85 ||                          // IndexOptionsConflict
            e.codeName === 'IndexKeySpecsConflict' ||
            e.codeName === 'IndexOptionsConflict' ||
            msg.includes('already exists') ||
            msg.includes('same name as the requested index')
        ) {
            return false;   // skip — tolerance
        }
        throw e;            // خطای واقعی → بالا بره
    }
}
async function ensureIndexes() {
    // --- کندل‌ها ---
    try { await db.collection(COLLECTIONS.CANDLES_BASE).dropIndex('time_1'); } catch (_) {}
    await safeCreateIndex(db.collection(COLLECTIONS.CANDLES_BASE), { time: 1 });
    await safeCreateIndex(db.collection(COLLECTIONS.CANDLES_BASE), { symbol: 1, time: 1 }, { unique: true });
    await safeCreateIndex(db.collection(COLLECTIONS.CANDLES_BASE), { source: 1 });

    await safeCreateIndex(db.collection(COLLECTIONS.CANDLES_DAILY), { symbol: 1, time: 1 }, { unique: true });

    await safeCreateIndex(db.collection(COLLECTIONS.CANDLES_TF), { symbol: 1, tf: 1, time: 1 }, { unique: true });

    // --- سیگنال‌ها ---
    await safeCreateIndex(db.collection(COLLECTIONS.SIGNAL_HISTORY), { createdAt: -1 });
    await safeCreateIndex(db.collection(COLLECTIONS.SIGNAL_HISTORY), { symbol: 1, createdAt: -1 });
    await safeCreateIndex(db.collection(COLLECTIONS.SIGNALS_STATE), { configId: 1 }, { unique: true });

    // --- کانفیگ‌ها ---
    await safeCreateIndex(db.collection(COLLECTIONS.STRATEGY_CONFIGS), { symbol: 1 });
    await safeCreateIndex(db.collection(COLLECTIONS.STRATEGY_CONFIGS), { enabled: 1 });
    await safeCreateIndex(db.collection(COLLECTIONS.MONITORED_SYMBOLS), { symbol: 1 }, { unique: true });

    // --- Jobs ---
    await safeCreateIndex(db.collection(COLLECTIONS.BACKTEST_JOBS), { status: 1, createdAt: 1 });
    await safeCreateIndex(db.collection(COLLECTIONS.BACKTEST_JOBS), { createdAt: -1 });
    await safeCreateIndex(db.collection(COLLECTIONS.BACKTEST_JOBS), { 'progress.chunks.status': 1 });

    // --- کش ----
    await safeCreateIndex(db.collection(COLLECTIONS.BACKTEST_TRADE_CACHE), { computedAt: 1 });
    await safeCreateIndex(db.collection(COLLECTIONS.BACKTEST_TRADE_CACHE), { 'signature.symbol': 1 });
    await safeCreateIndex(db.collection(COLLECTIONS.BACKTEST_RESULT_CACHE),
        { createdAt: 1 },
        { expireAfterSeconds: 7 * 86400 }
    );

    // --- آپشن ---
    await safeCreateIndex(db.collection(COLLECTIONS.OPTION_SNAPSHOTS), { symbol: 1, time: 1 });
    await safeCreateIndex(db.collection(COLLECTIONS.OPTION_SNAPSHOTS), { time: 1 });
    await safeCreateIndex(db.collection(COLLECTIONS.OPTION_DAILY), { symbol: 1, date: 1 }, { unique: true });
    await safeCreateIndex(db.collection(COLLECTIONS.OPTION_DAILY), { underlying: 1, date: 1 });
    await safeCreateIndex(db.collection(COLLECTIONS.OPTION_POSITIONS), { status: 1, configId: 1 });
    await safeCreateIndex(db.collection(COLLECTIONS.OPTION_HISTORY), { symbol: 1, time: 1 });
    await safeCreateIndex(db.collection(COLLECTIONS.OPTION_HISTORY), { underlying: 1, time: 1 });
    await safeCreateIndex(db.collection(COLLECTIONS.OPTION_HISTORY), { time: 1 });

    // --- Telegram ---
    await safeCreateIndex(db.collection(COLLECTIONS.TELEGRAM_OUTBOX), { sentAt: 1, createdAt: 1 });

    // --- TSETMC ---
    await safeCreateIndex(db.collection(COLLECTIONS.TSETMC_FETCH_LOG), { symbol: 1, date: 1 });
    await safeCreateIndex(db.collection(COLLECTIONS.TSETMC_FETCH_LOG), { createdAt: -1 });
    await safeCreateIndex(db.collection(COLLECTIONS.TSETMC_FETCH_LOG), { symbol: 1, date: 1, status: 1 });

    // --- لاگ‌ها ---
    try { await db.collection(COLLECTIONS.LOGS).dropIndex('at_1'); } catch (_) {}
    await safeCreateIndex(db.collection(COLLECTIONS.LOGS), { at: 1 });
    await safeCreateIndex(db.collection(COLLECTIONS.LOGS), { level: 1, at: -1 });
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