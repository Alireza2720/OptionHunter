'use strict';
// ============================================================
// env.js — خواندن و اعتبارسنجی متغیرهای محیطی
// ============================================================
// - خودش .env رو لود می‌کنه (بدون نیاز به dotenv یا PM2)
// - متغیرهای اجباری رو اعتبارسنجی می‌کنه
// ============================================================

const fs = require('fs');
const path = require('path');

// ------------------------------------------------------------
// .env loader — بدون وابستگی به dotenv
// ------------------------------------------------------------
let envFileLoaded = false;

function loadEnvFile() {
    if (envFileLoaded) return;
    envFileLoaded = true;

    // .env رو در چند مسیر ممکن چک می‌کنیم
    const candidates = [
        path.join(__dirname, '..', '.env'),            // backend/.env
        path.join(__dirname, '..', '..', '.env'),      // OptionHunter/.env
        path.join(process.cwd(), '.env')               // cwd/.env
    ];

    for (const p of candidates) {
        try {
            if (!fs.existsSync(p)) continue;
            const content = fs.readFileSync(p, 'utf-8');
            for (const rawLine of content.split('\n')) {
                const line = rawLine.trim();
                if (!line || line.startsWith('#')) continue;
                const eq = line.indexOf('=');
                if (eq <= 0) continue;
                const key = line.slice(0, eq).trim();
                let val = line.slice(eq + 1).trim();
                // حذف کوتیشن‌های ابتدا/انتها
                if (val.length >= 2 &&
                    ((val.startsWith('"') && val.endsWith('"')) ||
                     (val.startsWith("'") && val.endsWith("'")))) {
                    val = val.slice(1, -1);
                }
                // فقط اگه قبلاً تنظیم نشده
                if (process.env[key] === undefined || process.env[key] === '') {
                    process.env[key] = val;
                }
            }
            // اولین فایل معتبر کافیه
            break;
        } catch (_) { /* ignore */ }
    }
}

// ------------------------------------------------------------
// Config container
// ------------------------------------------------------------
let loaded = false;

const config = {
    // MongoDB
    MONGO_URI: '',

    // AlgoTik Collector
    ALGOTIK_URL: 'http://127.0.0.1:5000',

    // Server
    PORT: 3000,
    HOST: '127.0.0.1',
    NODE_ENV: 'production',

    // Admin
    ADMIN_TOKEN: '',

    // Telegram / Bale
    TELEGRAM_BOT_TOKEN: '',
    TELEGRAM_CHAT_ID: '',
    TELEGRAM_API_BASE: 'https://api.telegram.org',

    // Options API (Optionschool24)
    OPTIONS_API_URL: 'https://s3.optionschool24.com/last?type=3',

    // ورود به بازار
    ENTRY_START: '09:30',
    ENTRY_END: '12:00',

    // کارمزد
    OPTION_FEE_BUY: 0.0012,
    OPTION_FEE_SELL: 0.0012,
    RISK_FREE_RATE: 0.23
};

// ------------------------------------------------------------
// Readers
// ------------------------------------------------------------
function readNumber(name, fallback) {
    const v = process.env[name];
    if (v === undefined || v === '') return fallback;
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : fallback;
}

function readString(name, fallback) {
    const v = process.env[name];
    return (v === undefined || v === '') ? fallback : String(v);
}

function readTime(name, fallback) {
    const v = readString(name, fallback);
    return /^\d{1,2}:\d{2}$/.test(v) ? v : fallback;
}

// ------------------------------------------------------------
// Load
// ------------------------------------------------------------
function load() {
    if (loaded) return config;
    loaded = true;

    // اول .env رو لود کن
    loadEnvFile();

    config.MONGO_URI = readString('MONGO_URI', '');
    config.ALGOTIK_URL = readString('ALGOTIK_URL', config.ALGOTIK_URL);

    config.PORT = readNumber('PORT', config.PORT);
    config.HOST = readString('HOST', config.HOST);
    config.NODE_ENV = readString('NODE_ENV', config.NODE_ENV);

    config.ADMIN_TOKEN = readString('ADMIN_TOKEN', '');

    config.TELEGRAM_BOT_TOKEN = readString('TELEGRAM_BOT_TOKEN', '');
    config.TELEGRAM_CHAT_ID = readString('TELEGRAM_CHAT_ID', '');
    config.TELEGRAM_API_BASE = readString('TELEGRAM_API_BASE', config.TELEGRAM_API_BASE);

    config.OPTIONS_API_URL = readString('OPTIONS_API_URL', config.OPTIONS_API_URL);

    config.ENTRY_START = readTime('ENTRY_START', config.ENTRY_START);
    config.ENTRY_END = readTime('ENTRY_END', config.ENTRY_END);

    config.OPTION_FEE_BUY = readNumber('OPTION_FEE_BUY', config.OPTION_FEE_BUY);
    config.OPTION_FEE_SELL = readNumber('OPTION_FEE_SELL', config.OPTION_FEE_SELL);
    config.RISK_FREE_RATE = readNumber('RISK_FREE_RATE', config.RISK_FREE_RATE);

    return config;
}

// ------------------------------------------------------------
// Validate
// ------------------------------------------------------------
function validate() {
    const errors = [];
    if (!config.MONGO_URI) errors.push('MONGO_URI الزامی است');
    if (!config.ALGOTIK_URL) errors.push('ALGOTIK_URL الزامی است');
    if (errors.length) {
        throw new Error('خطا در تنظیمات محیطی:\n  - ' + errors.join('\n  - '));
    }
    return true;
}

function isDev() { return config.NODE_ENV !== 'production'; }
function isProd() { return config.NODE_ENV === 'production'; }

module.exports = { load, validate, isDev, isProd, get: () => config };