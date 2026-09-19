'use strict';
// ============================================================
// timeout.js — افزایش timeout برای route های سنگین
// ============================================================

const { LIMITS } = require('../../config/constants');

// مسیرهایی که نیاز به timeout طولانی دارن (بک‌تست، backfill، ...)
const LONG_PATHS = [
    '/api/jobs',
    '/api/backtest',
    '/api/auto-configure',
    '/api/algotik'
];

function longTimeoutMiddleware(req, res, next) {
    for (const p of LONG_PATHS) {
        if (req.path.startsWith(p)) {
            req.setTimeout(LIMITS.HTTP_TIMEOUT);
            res.setTimeout(LIMITS.HTTP_TIMEOUT);
            break;
        }
    }
    next();
}

module.exports = { longTimeoutMiddleware };