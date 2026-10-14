'use strict';
// ============================================================
// auth.js — احراز هویت توکن ادمین
// ============================================================
// - فقط POST/PUT/DELETE بررسی می‌شن
// - هدر: x-admin-token
// - اگه ADMIN_TOKEN خالی بود، همه چی allowed
// ============================================================

function _resolve(getterOrValue) {
    if (typeof getterOrValue === 'function') return getterOrValue();
    return getterOrValue;
}

function makeAuth(adminTokenGetter) {
    return function authMiddleware(req, res, next) {
        if (!['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) return next();
        const token = _resolve(adminTokenGetter);
        if (!token) return next();

        const provided = req.headers['x-admin-token'];
        if (provided === token) return next();

        res.status(401).json({ error: 'توکن ادمین نامعتبر است' });
    };
}

function authCheckRoute(adminTokenGetter) {
    return (req, res) => {
        const token = _resolve(adminTokenGetter);
        const provided = req.headers['x-admin-token'];
        res.json({
            required: !!token,
            ok: !token || provided === token
        });
    };
}

module.exports = { makeAuth, authCheckRoute };