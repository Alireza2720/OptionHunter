'use strict';
// ============================================================
// system.routes.js — وضعیت سیستم، لاگ‌ها، usage، بکاپ
// ============================================================

const express = require('express');
const os = require('os');
const { execSync } = require('child_process');
const { COLLECTIONS, LIMITS } = require('../../config/constants');

function register(app, deps) {
    const {
        getDB, logger, signalService, algotik,
        backtestService, settings, adminToken
    } = deps;

    // ---- Ping ----
    app.get('/ping', (req, res) => res.json({ pong: true, time: new Date().toISOString() }));

    // ---- Root ----
    app.get('/', async (req, res) => {
        let pendingOutbox = 0;
        try { pendingOutbox = await deps.telegram.pendingCount(); } catch (_) {}

        const t = signalService.todayDateStr
            ? signalService.todayDateStr()
            : new Date().toISOString().slice(0, 10);
        const health = signalService.getHealth();

        // 🆕 محاسبه واقعی market open
        const nowUtc = new Date();
        const tehran = new Date(nowUtc.getTime() + 3.5 * 3600 * 1000);
        const wd = tehran.getUTCDay();
        const mins = tehran.getUTCHours() * 60 + tehran.getUTCMinutes();
        const isTradingDay = [6, 0, 1, 2, 3].includes(wd);
        const marketOpenNow = isTradingDay && mins >= 9 * 60 && mins <= 12 * 60 + 35;

        // 🆕 چک اتصال collector
        let collectorOnline = false;
        try { collectorOnline = await deps.algotik.isOnline(); } catch (_) {}

        const env = require('../../config/env').get();

        res.json({
            status: 'ok',
            version: deps.version || 'v10.0',
            startedAt: deps.startedAt,
            adminRequired: !!adminToken,
            telegramConfigured: !!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
            collectorOnline,                              // 🆕
            apiKeysConfigured: collectorOnline,           // 🆕 backward-compat
            marketOpenNow,                                // 🆕
            holidayToday: signalService.getHoliday() === t,
            health: { ...health },
            pendingOutbox
        });
    });

    // ---- System Stats ----
    app.get('/api/system/stats', async (req, res, next) => {
        try {
            const totalMem = os.totalmem();
            const freeMem = os.freemem();
            const usedMem = totalMem - freeMem;
            const loadAvg = os.loadavg();
            const cpuCount = os.cpus().length;
            const cpuPercent = Math.min(100, Math.round((loadAvg[0] / cpuCount) * 100));

            // Disk
            let diskTotal = 0, diskUsed = 0, diskFree = 0;
            try {
                const out = execSync("df -B1 / | tail -1 | awk '{print $2, $3, $4}'").toString().trim();
                [diskTotal, diskUsed, diskFree] = out.split(/\s+/).map(Number);
            } catch (_) {}

            // Processes
            const procs = [];
            try {
                const pm2Raw = execSync('pm2 jlist 2>/dev/null || echo "[]"').toString();
                const pm2List = JSON.parse(pm2Raw);
                for (const p of pm2List) {
                    procs.push({
                        name: p.name, type: 'node', pid: p.pid,
                        status: p.pm2_env?.status,
                        cpu: p.monit?.cpu || 0,
                        memoryMB: Math.round((p.monit?.memory || 0) / 1048576),
                        restarts: p.pm2_env?.restart_time || 0
                    });
                }
            } catch (_) {}

            try {
                const collOut = execSync("systemctl show collector -p MainPID,MemoryCurrent,CPUUsageNSec,ActiveState --no-pager 2>/dev/null || true").toString();
                const coll = {};
                collOut.split('\n').forEach(l => {
                    const i = l.indexOf('=');
                    if (i > 0) coll[l.slice(0, i)] = l.slice(i + 1);
                });
                if (coll.ActiveState === 'active') {
                    procs.push({
                        name: 'collector', type: 'python',
                        pid: +coll.MainPID || null, status: 'online',
                        memoryMB: coll.MemoryCurrent && coll.MemoryCurrent !== '[not set]'
                            ? Math.round(+coll.MemoryCurrent / 1048576) : null,
                        cpuMsTotal: coll.CPUUsageNSec && coll.CPUUsageNSec !== '[not set]'
                            ? Math.round(+coll.CPUUsageNSec / 1e6) : null
                    });
                }
            } catch (_) {}

            // DB stats
            let dbStats = {};
            try {
                const d = getDB();
                const s = await d.command({ dbStats: 1 });
                dbStats = {
                    sizeMB: Math.round(s.dataSize / 1048576),
                    storageMB: Math.round((s.storageSize + s.indexSize) / 1048576),
                    collections: s.collections,
                    objects: s.objects
                };
            } catch (_) {}

            res.json({
                ram: {
                    totalMB: Math.round(totalMem / 1048576),
                    usedMB: Math.round(usedMem / 1048576),
                    freeMB: Math.round(freeMem / 1048576),
                    usedPct: Math.round((usedMem / totalMem) * 100)
                },
                cpu: {
                    loadAvg: loadAvg.map(x => +x.toFixed(2)),
                    cores: cpuCount,
                    usedPct: cpuPercent
                },
                disk: {
                    totalGB: +(diskTotal / 1073741824).toFixed(1),
                    usedGB: +(diskUsed / 1073741824).toFixed(1),
                    freeGB: +(diskFree / 1073741824).toFixed(1),
                    usedPct: diskTotal ? Math.round((diskUsed / diskTotal) * 100) : 0
                },
                processes: procs,
                database: dbStats,
                uptime: Math.round(process.uptime()),
                serverStartedAt: deps.startedAt
            });
        } catch (e) { next(e); }
    });

    // ---- Aggregated Jobs ----
    app.get('/api/system/jobs', async (req, res, next) => {
        try {
            const backendJobs = await backtestService.listJobs(50, true);

            let collectorJobs = [];
            try {
                const r = await algotik.listJobs(20);
                collectorJobs = (r.jobs || []).filter(j =>
                    j.status === 'RUNNING' || j.status === 'QUEUED'
                );
            } catch (_) {}

            res.json({
                backend: backendJobs.map(j => ({
                    id: String(j._id), source: 'backend',
                    type: j.type, status: j.status,
                    progress: j.progress,
                    resourceStats: j.resourceStats,
                    createdAt: j.createdAt,
                    startedAt: j.startedAt,
                    cancelRequested: j.cancelRequested,
                    symbolCount: (j.payload && j.payload.symbols)
                        ? j.payload.symbols.length : 1
                })),
                collector: collectorJobs.map(j => ({
                    id: j.job_id, source: 'collector',
                    type: 'collector-job', status: j.status,
                    processed: j.processed, total: j.total,
                    records: j.records, errors: j.errors,
                    message: j.message,
                    underlyingCount: (j.underlyings || []).length,
                    createdAt: j.created_at, startedAt: j.started_at
                }))
            });
        } catch (e) { next(e); }
    });

    // ---- Logs ----
    app.get('/api/logs', async (req, res, next) => {
        try {
            if (adminToken && req.headers['x-admin-token'] !== adminToken) {
                return res.status(401).json({ error: 'توکن ادمین نامعتبر' });
            }
            const limit = Math.min(+req.query.limit || 200, 1000);

            if (req.query.source === 'db') {
                const logs = await getDB().collection(COLLECTIONS.LOGS)
                    .find({}).sort({ at: -1 }).limit(limit).toArray();
                return res.json({ logs });
            }
            res.json({ logs: logger.recent(limit, req.query.level || undefined) });
        } catch (e) { next(e); }
    });

    // ---- Telegram Test ----
    app.post('/api/telegram/test', async (req, res, next) => {
        try {
            await deps.telegram.notify('پیام تست');
            await deps.telegram.flush();
            res.json({ success: true });
        } catch (e) { next(e); }
    });

    // ---- Backup ----
    app.post('/api/backup/run', async (req, res, next) => {
        try {
            await deps.autoConfigJob.weeklyBackup();
            res.json({ success: true });
        } catch (e) { next(e); }
    });

    // ---- Holiday ----
    app.delete('/api/holiday', async (req, res, next) => {
        try {
            await signalService.clearHoliday();
            res.json({ success: true });
        } catch (e) { next(e); }
    });

    // ---- Trading Settings ----
    app.get('/api/trading-settings', (req, res) => {
        res.json({
            values: settings.get(),
            defaults: require('../../settings').DEFAULTS
        });
    });

    app.put('/api/trading-settings', async (req, res, next) => {
        try {
            await settings.save(req.body || {});
            await deps.reloadEntryWindow();
            if (deps.options && deps.options.reloadFromSettings) {
                deps.options.reloadFromSettings();
            }
            res.json({ success: true, values: settings.get() });
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    // ---- Strategy Defaults ----
    app.get('/api/strategy-defaults', (req, res) => {
        const overrides = settings.getAllStrategyDefaults();
        const all = {};
        const STRATEGIES = require('../../strategies').STRATEGIES;
        Object.values(STRATEGIES).forEach(s => {
            all[s.id] = { ...s.defaultParams, ...(overrides[s.id] || {}) };
        });
        res.json({ defaults: all, overrides });
    });

    app.put('/api/strategy-defaults', async (req, res, next) => {
        try {
            const { overrides } = req.body || {};
            if (!overrides || typeof overrides !== 'object') {
                return res.status(400).json({ error: 'ساختار نامعتبر' });
            }
            const STRATEGIES = require('../../strategies').STRATEGIES;
            const clean = {};
            for (const [sid, params] of Object.entries(overrides)) {
                if (!STRATEGIES[sid]) continue;
                clean[sid] = {};
                for (const [k, v] of Object.entries(params || {})) {
                    if (STRATEGIES[sid].defaultParams[k] !== undefined && Number.isFinite(+v)) {
                        clean[sid][k] = +v;
                    }
                }
            }
            await settings.saveStrategyDefaults(clean);
            res.json({ success: true, overrides: clean });
        } catch (e) { next(e); }
    });

    app.delete('/api/strategy-defaults/:strategyId?', async (req, res, next) => {
        try {
            await settings.resetStrategyDefaults(req.params.strategyId || null);
            res.json({ success: true });
        } catch (e) { next(e); }
    });

    // ---- Strategies Library ----
    app.get('/strategies.js', (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.sendFile(require('path').join(__dirname, '..', '..', 'strategies.js'));
    });

    app.get('/api/strategies', (req, res) => {
        const overrides = settings.getAllStrategyDefaults();
        const STRATEGIES = require('../../strategies').STRATEGIES;
        res.json(Object.values(STRATEGIES).map(s => ({
            id: s.id, name: s.name,
            defaultTimeframe: s.defaultTimeframe,
            htfTimeframe: s.htfTimeframe || '1d',
            defaultParams: { ...s.defaultParams, ...(overrides[s.id] || {}) },
            baseDefaults: s.defaultParams,
            overrides: overrides[s.id] || {},
            indicators: s.indicators
        })));
    });

    app.get('/api/timeframes', (req, res) => {
        const { TIMEFRAME_MINUTES } = require('../../config/constants');
        res.json(Object.keys(TIMEFRAME_MINUTES).filter(t => t !== '4h'));
    });
}

module.exports = { register };