'use strict';
// ============================================================
// auth.routes.js — auth check
// ============================================================

const { authCheckRoute } = require('../middleware/auth');

function register(app, deps) {
    app.get('/api/auth/check', authCheckRoute(deps.adminToken));

    // GET current admin token state (does not leak the value)
    app.get('/api/admin/token/state', (req, res) => {
        try {
            const mod = deps.adminToken;
            const isSet = !!(mod && typeof mod.isSet === 'function' && mod.isSet());
            res.json({ required: isSet });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // PUT new admin token
    // - If no token set: free (bootstrapping)
    // - If token set: requires valid x-admin-token
    app.put('/api/admin/token', async (req, res, next) => {
        try {
            const mod = deps.adminToken;
            if (!mod || typeof mod.set !== 'function') {
                return res.status(500).json({ error: 'admin-token module not wired' });
            }
            const current = typeof mod.get === 'function' ? mod.get() : '';
            const provided = req.headers['x-admin-token'] || '';
            if (current && provided !== current) {
                return res.status(401).json({ error: 'توکن فعلی نامعتبر است' });
            }
            const body = req.body || {};
            const newToken = String(body.token == null ? '' : body.token).trim();
            if (newToken.length > 0 && newToken.length < 6) {
                return res.status(400).json({ error: 'توکن جدید باید حداقل ۶ کاراکتر باشد' });
            }
            const ok = await mod.set(newToken);
            if (!ok) return res.status(500).json({ error: 'ذخیره‌سازی ناموفق' });
            const newState = newToken.length > 0 ? 'set' : 'cleared';
            return res.json({ ok: true, state: newState });
        } catch (e) { next(e); }
    });
}

module.exports = { register };