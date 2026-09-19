'use strict';
// ============================================================
// error.js — مدیریت خطاها و 404
// ============================================================
// - 404 handler
// - error handler با logging
// - ارورهای با status کد از خودشان استفاده می‌کنند
// ============================================================

let logger = null;
function init(l) { logger = l; }

function notFoundHandler(req, res) {
    if (logger) logger.warn(`404 ${req.method} ${req.originalUrl}`);
    res.status(404).json({ error: 'مسیر یافت نشد' });
}

function errorHandler(err, req, res, next) {
    const status = err.status || err.statusCode || 500;

    if (status >= 500) {
        if (logger) logger.error(`[${req.method} ${req.originalUrl}] ${err.message}\n${err.stack || ''}`);
    } else if (logger) {
        logger.warn(`[${req.method} ${req.originalUrl}] ${status} - ${err.message}`);
    }

    // پیام خروجی
    const msg = status >= 500 && process.env.NODE_ENV === 'production'
        ? 'خطای داخلی سرور'
        : (err.message || 'خطای ناشناخته');

    res.status(status).json({ error: msg });
}

module.exports = { init, notFoundHandler, errorHandler };