'use strict';
// ============================================================
// logger.js — سیستم لاگ
// ============================================================
// - نگه‌داری رکوردها در حافظه (Ring Buffer)
// - ذخیره warn/error در MongoDB
// - پاکسازی خودکار اسرار از لاگ‌ها
// - جایگزینی console.log/warn/error
// ============================================================

const { LIMITS, COLLECTIONS } = require('../config/constants');

const RING_SIZE = LIMITS.LOG_RING_SIZE;
const mem = [];
let dbAccessor = null;

// الگوهای پاکسازی اسرار
const SECRET_PATTERNS = [
    [/key=[^&\s"']+/gi, 'key=***'],
    [/\/bot[^/\s"']+/g, '/bot***'],
    [/mongodb(\+srv)?:\/\/[^\s"']+/gi, 'mongodb://***']
];

function sanitize(str) {
    return SECRET_PATTERNS.reduce((t, [re, rep]) => t.replace(re, rep), str);
}

function stringifyArgs(args) {
    return args.map(a => {
        if (a instanceof Error) return a.stack || a.message;
        if (typeof a === 'object' && a !== null) {
            try { return JSON.stringify(a); } catch { return String(a); }
        }
        return String(a);
    }).join(' ');
}

function push(level, msg) {
    const entry = {
        level,
        msg: sanitize(String(msg)).slice(0, 4000),
        at: new Date()
    };
    mem.push(entry);
    if (mem.length > RING_SIZE) mem.shift();

    if (dbAccessor && level !== 'info') {
        try {
            dbAccessor().collection(COLLECTIONS.LOGS).insertOne(entry).catch(() => {});
        } catch (_) { /* db هنوز وصل نیست */ }
    }
    return entry;
}

function recent(limit = 200, level) {
    const list = level ? mem.filter(x => x.level === level) : mem;
    return list.slice(-limit).reverse();
}

function init(getDBFn) {
    dbAccessor = getDBFn;
}

// جایگزینی console
const origLog = console.log;
const origWarn = console.warn;
const origErr = console.error;

function patchConsole() {
    console.log = (...a) => { origLog(...a); push('info', stringifyArgs(a)); };
    console.warn = (...a) => { origWarn(...a); push('warn', stringifyArgs(a)); };
    console.error = (...a) => { origErr(...a); push('error', stringifyArgs(a)); };

    process.on('unhandledRejection', r => push('error', 'unhandledRejection: ' + stringifyArgs([r])));
    process.on('uncaughtException', e => {
        push('error', 'uncaughtException: ' + stringifyArgs([e]));
        origErr(e);
    });
}

async function ensureIndexes(db) {
    try { await db.collection(COLLECTIONS.LOGS).dropIndex('at_1'); } catch (_) {}
    await db.collection(COLLECTIONS.LOGS).createIndex({ at: 1 });
    await db.collection(COLLECTIONS.LOGS).createIndex({ level: 1, at: -1 });
}

module.exports = {
    init, push, recent, patchConsole, ensureIndexes,
    info: (msg) => push('info', msg),
    warn: (msg) => push('warn', msg),
    error: (msg) => push('error', msg)
};