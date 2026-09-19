'use strict';
// ============================================================
// auth.js — احراز هویت توکن ادمین
// ============================================================
// - فقط POST/PUT/DELETE بررسی می‌شن
// - هدر: x-admin-token
// - اگه ADMIN_TOKEN خالی بود، همه چی allowed
// ============================================================

function makeAuth(adminToken) {
    return function authMiddleware(req, res, next) {
        // فقط متدهای تغییردهنده
        if (!['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) return next();
        if (!adminToken) return next();

        const provided = req.headers['x-admin-token'];
        if (provided === adminToken) return next();

        res.status(401).json({ error: 'توکن ادمین نامعتبر است' });
    };
}

// endpoint چک وضعیت (بدون نیاز به auth)
function authCheckRoute(adminToken) {
    return (req, res) => {
        const provided = req.headers['x-admin-token'];
        res.json({
            required: !!adminToken,
            ok: !adminToken || provided === adminToken
        });
    };
}

module.exports = { makeAuth, authCheckRoute };