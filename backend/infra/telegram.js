'use strict';
// ============================================================
// telegram.js — ارسال اعلان به تلگرام/بله
// ============================================================
// الگو: Outbox
// - notify(text) → پیام در Mongo insert می‌شود و برمی‌گردد
// - flush() → پیام‌های در صف را ارسال می‌کند (با retry)
// - این الگو تضمین می‌کند اگر تلگرام down بود، پیام از دست نرود
// ============================================================

const fetch = require('node-fetch');
const { COLLECTIONS } = require('../config/constants');

let dbAccessor = null;
function init(getDBFn) { dbAccessor = getDBFn; }

let flushing = false;

// ---------- Send primitives ----------
async function sendText(text) {
    const env = require('../config/env').get();
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
        throw new Error('تلگرام تنظیم نشده است');
    }
    const url = `${env.TELEGRAM_API_BASE}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
    const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
        timeout: 15000
    });
    const d = await r.json();
    if (!d.ok) throw new Error(d.description || 'خطای تلگرام');
}

async function sendDocument(filename, jsonObj, caption) {
    const env = require('../config/env').get();
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
        throw new Error('تلگرام تنظیم نشده است');
    }
    const blob = new Blob([JSON.stringify(jsonObj, null, 2)], { type: 'application/json' });
    const form = new FormData();
    form.append('chat_id', env.TELEGRAM_CHAT_ID);
    form.append('caption', caption || filename);
    form.append('document', blob, filename);
    const url = `${env.TELEGRAM_API_BASE}/bot${env.TELEGRAM_BOT_TOKEN}/sendDocument`;
    const r = await globalThis.fetch(url, { method: 'POST', body: form });
    const d = await r.json();
    if (!d.ok) throw new Error(d.description || 'خطای ارسال سند');
}

// ---------- Outbox ----------
async function notify(text) {
    if (!dbAccessor) throw new Error('telegram.init() صدا زده نشده');
    const db = dbAccessor();
    await db.collection(COLLECTIONS.TELEGRAM_OUTBOX).insertOne({
        text,
        createdAt: new Date(),
        attempts: 0,
        sentAt: null
    });
    // fire-and-forget
    flush().catch(() => {});
}

async function flush() {
    if (flushing) return;
    flushing = true;
    try {
        const db = dbAccessor();
        const col = db.collection(COLLECTIONS.TELEGRAM_OUTBOX);
        const pending = await col.find({
            sentAt: null,
            attempts: { $lt: 120 }
        })
            .sort({ createdAt: 1 })
            .limit(10)
            .toArray();

        for (const p of pending) {
            try {
                await sendText(p.text);
                await col.updateOne({ _id: p._id }, { $set: { sentAt: new Date() } });
            } catch (e) {
                await col.updateOne(
                    { _id: p._id },
                    { $inc: { attempts: 1 }, $set: { lastError: e.message } }
                );
                // احتمالاً مشکل شبکه است؛ از این batch خارج می‌شویم
                break;
            }
        }
    } finally {
        flushing = false;
    }
}

async function pendingCount() {
    const db = dbAccessor();
    return db.collection(COLLECTIONS.TELEGRAM_OUTBOX).countDocuments({
        sentAt: null,
        attempts: { $lt: 120 },
        createdAt: { $lt: new Date(Date.now() - 120000) }
    });
}

async function clearOld(daysOld = 7) {
    const db = dbAccessor();
    const cutoff = new Date(Date.now() - daysOld * 86400 * 1000);
    return db.collection(COLLECTIONS.TELEGRAM_OUTBOX).deleteMany({
        sentAt: { $ne: null },
        sentAt: { $lt: cutoff }
    });
}

module.exports = {
    init, notify, flush,
    sendText, sendDocument, pendingCount, clearOld
};