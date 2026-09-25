'use strict';
// ============================================================
// api/index.js — bootstrap API layer
// ============================================================
// - ساخت Express app
// - میدل‌ورها
// - ثبت همه route ها
// - error handling
// ============================================================

const express = require('express');
const cors = require('cors');
const path = require('path');
const { LIMITS } = require('../config/constants');

const authMw = require('./middleware/auth');
const errorMw = require('./middleware/error');
const timeoutMw = require('./middleware/timeout');

// Route modules
const authRoutes = require('./routes/auth.routes');
const systemRoutes = require('./routes/system.routes');
const symbolsRoutes = require('./routes/symbols.routes');
const configsRoutes = require('./routes/configs.routes');
const jobsRoutes = require('./routes/jobs.routes');
const optionsRoutes = require('./routes/options.routes');
const algotikRoutes = require('./routes/algotik.routes');
const analysisRoutes = require('./routes/analysis.routes');
const portfolioRoutes = require('./routes/portfolio.routes');
const wfRoutes = require('./routes/wf.routes');

function createApp(deps) {
    const app = express();
    app.disable('x-powered-by');

    // ---- Core middlewares ----
    app.use(cors());
    app.use(express.json({ limit: LIMITS.MAX_JSON_BODY }));

    // ---- Long timeout for heavy routes ----
    app.use(timeoutMw.longTimeoutMiddleware);

    // ---- Auth ----
    app.use(authMw.makeAuth(deps.adminToken));

    // ---- Error middleware init ----
    errorMw.init(deps.logger);

    // ---- Static (strategies.js is served by system route) ----

    // ---- Register routes ----
    authRoutes.register(app, deps);
    systemRoutes.register(app, deps);
    symbolsRoutes.register(app, deps);
    configsRoutes.register(app, deps);
    jobsRoutes.register(app, deps);
    optionsRoutes.register(app, deps);
    algotikRoutes.register(app, deps);
    analysisRoutes.register(app, deps);
    portfolioRoutes.register(app, deps);
    wfRoutes.register(app, deps);

    // ---- 404 + error ----
    app.use(errorMw.notFoundHandler);
    app.use(errorMw.errorHandler);

    return app;
}

module.exports = { createApp };