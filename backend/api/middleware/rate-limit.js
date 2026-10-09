'use strict';
// ============================================================
// rate-limit.js — simple in-memory rate limiter
// ============================================================

const buckets = new Map();

function makeLimiter({ windowMs, max, keyFn }) {
    return (req, res, next) => {
        const _ip = req.ip || req.connection.remoteAddress || '';
        if (_ip === '127.0.0.1' || _ip === '::1' || _ip === '::ffff:127.0.0.1') return next();
        const key = keyFn ? keyFn(req) : (req.ip || req.connection.remoteAddress || 'unknown');
        const now = Date.now();
        let b = buckets.get(key);
        if (!b || now > b.resetAt) {
            b = { count: 0, resetAt: now + windowMs };
            buckets.set(key, b);
        }
        b.count++;
        const remaining = Math.max(0, max - b.count);
        res.setHeader('X-RateLimit-Limit', String(max));
        res.setHeader('X-RateLimit-Remaining', String(remaining));
        res.setHeader('X-RateLimit-Reset', String(Math.floor(b.resetAt / 1000)));
        if (b.count > max) {
            return res.status(429).json({
                error: 'تعداد درخواست‌ها از حد مجاز گذشت. لطفاً بعداً تلاش کنید.',
                retryAfter: Math.ceil((b.resetAt - now) / 1000)
            });
        }
        next();
    };
}

// Heavy jobs: /api/backtest/run, /api/jobs/*, /api/pipeline/*
const heavyLimiter = makeLimiter({
    windowMs: 60 * 1000,
    max: 10
});

// Write ops: POST/PUT/DELETE
const writeLimiter = makeLimiter({
    windowMs: 60 * 1000,
    max: 30
});

// Read ops: GET (generous)
const readLimiter = makeLimiter({
    windowMs: 60 * 1000,
    max: 300
});

// periodic cleanup
setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) if (now > b.resetAt) buckets.delete(k);
}, 5 * 60 * 1000).unref();

module.exports = { heavyLimiter, writeLimiter, readLimiter, makeLimiter };
