'use strict';
// ============================================================
// auth.routes.js — auth check
// ============================================================

const { authCheckRoute } = require('../middleware/auth');

function register(app, deps) {
    app.get('/api/auth/check', authCheckRoute(deps.adminToken));
}

module.exports = { register };