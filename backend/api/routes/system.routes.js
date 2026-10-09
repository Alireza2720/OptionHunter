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

    // 🆕 cache برای /api/system/stats — جلوگیری از execSync پیاپی
    let _statsCache = null;
    let _statsAt = 0;
    const STATS_TTL = 60000;   // ۲۰ ثانیه

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
            // 🆕 cache hit
            if (_statsCache && (Date.now() - _statsAt) < STATS_TTL) {
                return res.json(_statsCache);
            }
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
                let pm2List = [];
                try { pm2List = JSON.parse(pm2Raw); } catch (_) {}
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

            const payload = {
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
            };
            _statsCache = payload;
            _statsAt = Date.now();
            res.json(payload);
        } catch (e) { next(e); }
    });

    // ---- Aggregated Jobs ----
    app.get('/api/system/jobs', async (req, res, next) => {
        try {
            const backendJobs = await backtestService.listJobs(50, true);

            // 🆕 collector /jobs آرایه برمی‌گردونه نه {jobs:[...]}
            let raw = [];
            try {
                const r = await algotik.listJobs(20);
                raw = Array.isArray(r) ? r : (r && r.jobs ? r.jobs : []);
            } catch (_) {}

            const activeCollector = raw.filter(j =>
                j.status === 'RUNNING' || j.status === 'QUEUED'
            );

            // 🆕 map به schema قابل نمایش
            const collectorMapped = activeCollector.map(j => {
                const phases = j.phases || {};
                const entries = Object.entries(phases);
                const curPhase = j.phase || '-';
                const cur = phases[curPhase] || {};
                const donePhases = entries.filter(([, v]) =>
                    v && v.current >= v.total
                ).length;

                return {
                    id: String(j._id),
                    source: 'collector',
                    type: 'full-backfill',
                    status: j.status,
                    progress: {
                        current: cur.current || 0,
                        total: cur.total || 0,
                        message: `${curPhase} (${donePhases}/${entries.length}) ${cur.current_symbol ? '— ' + cur.current_symbol : ''}`,
                        chunks: entries.map(([name, p]) => ({
                            label: name,
                            status: p && p.current >= p.total ? 'DONE' : 'RUNNING',
                            tradesCount: p && p.stats ? Object.keys(p.stats).length : 0
                        }))
                    },
                    createdAt: j.created_at,
                    startedAt: j.started_at
                };
            });

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
                collector: collectorMapped
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
        const DEFAULTS = require('../../settings').DEFAULTS;
        res.json({
            values: settings.get(),
            defaults: DEFAULTS,
            optionQualityLevels: ['A+','A','B','C','D'],
            currentQualityLevel: (settings.getOptionQualityLevel
                ? settings.getOptionQualityLevel()
                : (DEFAULTS.OPTION_QUALITY_LEVEL || 'B'))
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
    // R13: per-strategy minTargetPct
    app.get('/api/strategy-min-targets', (req, res) => {
        try {
            const map = settings.getStrategyMinTargetMap ? settings.getStrategyMinTargetMap() : {};
            res.json({ map });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });
    app.put('/api/strategy-min-targets', async (req, res, next) => {
        try {
            const { map } = req.body || {};
            if (!map || typeof map !== 'object') return res.status(400).json({ error: 'map لازم است' });
            const saved = await settings.saveStrategyMinTargets(map);
            res.json({ success: true, map: saved });
        } catch (e) { next(e); }
    });

    app.get('/api/strategy-size-mult', (req, res) => {
        try {
            const map = settings.getStrategySizeMultMap ? settings.getStrategySizeMultMap() : {};
            res.json({ map });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });
    app.put('/api/strategy-size-mult', async (req, res, next) => {
        try {
            const { map } = req.body || {};
            if (!map || typeof map !== 'object') return res.status(400).json({ error: 'map لازم است' });
            const saved = await settings.saveStrategySizeMult(map);
            res.json({ success: true, map: saved });
        } catch (e) { next(e); }
    });

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
        res.json(Object.values(STRATEGIES).filter(s => !s.deprecated).map(s => ({
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

    // 🆕 گزارش ماهانه
    app.get('/api/reports/monthly/latest', async (req, res, next) => {
        try {
            const db = getDB();
            const doc = await db.collection(COLLECTIONS.META)
                .findOne({ _id: 'monthly_report_latest' });
            if (!doc) return res.json({ empty: true });
            delete doc._id;
            res.json(doc);
        } catch (e) { next(e); }
    });

    app.post('/api/reports/monthly/generate', async (req, res, next) => {
        try {
            const { monthlyReportJob } = deps;
            if (!monthlyReportJob) return res.status(500).json({ error: 'not wired' });
            const r = await monthlyReportJob.run();
            res.json({ ok: !r.error, report: r });
        } catch (e) { next(e); }
    });
}

module.exports = { register };