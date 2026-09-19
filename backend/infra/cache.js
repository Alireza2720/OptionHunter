'use strict';
// ============================================================
// cache.js — کش دو لایه
// ============================================================
// - L1: in-memory LRU با TTL
// - L2: Mongo-backed با TTL index (اختیاری)
// ============================================================
// استفاده:
//   const cache = require('./infra/cache').memory(100, 60000);
//   cache.set('key', value);
//   cache.get('key');
// ============================================================

const { COLLECTIONS } = require('../config/constants');

// ---------- In-Memory LRU + TTL ----------
function memory(maxSize = 500, defaultTtlMs = 60000) {
    const store = new Map();

    function isExpired(entry) {
        return entry.expiresAt && Date.now() > entry.expiresAt;
    }

    function evictOldest() {
        const firstKey = store.keys().next().value;
        if (firstKey) store.delete(firstKey);
    }

    return {
        get(key) {
            const entry = store.get(key);
            if (!entry) return null;
            if (isExpired(entry)) { store.delete(key); return null; }
            // refresh LRU position
            store.delete(key);
            store.set(key, entry);
            return entry.value;
        },

        set(key, value, ttlMs) {
            const ttl = ttlMs !== undefined ? ttlMs : defaultTtlMs;
            if (store.has(key)) store.delete(key);
            store.set(key, {
                value,
                expiresAt: ttl > 0 ? Date.now() + ttl : null
            });
            if (store.size > maxSize) evictOldest();
        },

        has(key) { return this.get(key) !== null; },

        del(key) { store.delete(key); },

        clear() { store.clear(); },

        size() { return store.size; },

        // پاکسازی entryهای منقضی
        cleanup() {
            const now = Date.now();
            for (const [k, v] of store) {
                if (v.expiresAt && now > v.expiresAt) store.delete(k);
            }
        }
    };
}

// ---------- Mongo-backed cache ----------
function mongo(getDBFn, collectionName = COLLECTIONS.BACKTEST_RESULT_CACHE, defaultTtlMs = 7 * 86400 * 1000) {
    return {
        async get(key) {
            const db = getDBFn();
            const doc = await db.collection(collectionName).findOne({ _id: key });
            if (!doc) return null;
            if (doc.expiresAt && Date.now() > new Date(doc.expiresAt).getTime()) {
                await db.collection(collectionName).deleteOne({ _id: key });
                return null;
            }
            return doc.value;
        },

        async set(key, value, ttlMs) {
            const db = getDBFn();
            const ttl = ttlMs !== undefined ? ttlMs : defaultTtlMs;
            await db.collection(collectionName).updateOne(
                { _id: key },
                {
                    $set: {
                        value,
                        createdAt: new Date(),
                        expiresAt: ttl > 0 ? new Date(Date.now() + ttl) : null
                    }
                },
                { upsert: true }
            );
        },

        async del(key) {
            const db = getDBFn();
            await db.collection(collectionName).deleteOne({ _id: key });
        },

        async clear() {
            const db = getDBFn();
            return db.collection(collectionName).deleteMany({});
        },

        async clearByPrefix(prefix) {
            const db = getDBFn();
            return db.collection(collectionName).deleteMany({
                _id: { $regex: '^' + prefix }
            });
        }
    };
}

// ---------- Memoize helper ----------
// کش کردن نتیجه یه async function برای مدت مشخص
function memoize(fn, ttlMs = 60000) {
    const cache = memory(200, ttlMs);
    return async function (...args) {
        const key = JSON.stringify(args);
        const cached = cache.get(key);
        if (cached !== null) return cached;
        const result = await fn.apply(this, args);
        cache.set(key, result);
        return result;
    };
}

module.exports = { memory, mongo, memoize };