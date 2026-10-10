'use strict';
// ============================================================
// algotik.routes.js — proxy به Collector
// ============================================================

function register(app, deps) {
    const { algotik, getDB } = deps;

    // ---- Debug: active timers ---- 🆕
    app.get('/api/algotik/debug-timers', (req, res) => {
        const out = { activeIntervals: [], activeTimeouts: [] };
        try {
            const ids = process._getActiveHandles ? process._getActiveHandles() : [];
            out.handles = ids.length;
            out.handlesTypes = {};
            ids.forEach(h => {
                const n = h && h.constructor ? h.constructor.name : 'unknown';
                out.handlesTypes[n] = (out.handlesTypes[n] || 0) + 1;
            });
        } catch (_) {}
        // collect cron timers from any known module
        try {
            const cached = global.__oh_timers || [];
            out.activeIntervals = cached.filter(t => t.type === 'interval').slice(0, 50);
            out.activeTimeouts = cached.filter(t => t.type === 'timeout').slice(0, 50);
        } catch (_) {}
        out.memory = process.memoryUsage();
        out.uptimeSec = Math.round(process.uptime());
        res.json(out);
    });

    // ---- Health / Status ----
    app.get('/api/algotik/health', async (req, res) => {
        try { res.json({ online: await algotik.isOnline() }); }
        catch (e) { res.json({ online: false, error: e.message }); }
    });
    // 🆕 Cache 30s برای /status (چون فرانت هر 60s صداش می‌زنه)
    let _statusCache = null;
    let _statusAt = 0;
    const STATUS_TTL = 30000;

    app.get('/api/algotik/status', async (req, res, next) => {
        try {
            const fresh = req.query.fresh === '1';
            if (!fresh && _statusCache && (Date.now() - _statusAt) < STATUS_TTL) {
                return res.json(_statusCache);
            }
            _statusCache = await algotik.getStatus();
            _statusAt = Date.now();
            res.json(_statusCache);
        } catch (e) { next(e); }
    });

    // ---- Symbols ----
    app.get('/api/algotik/symbols', async (req, res, next) => {
        try { res.json(await algotik.listSymbols()); } catch (e) { next(e); }
    });
    app.post('/api/algotik/symbols', async (req, res, next) => {
        try {
            const { symbol, name } = req.body || {};
            if (!symbol) return res.status(400).json({ error: 'symbol required' });
            res.json(await algotik.addSymbol(symbol, name));
        } catch (e) { res.status(400).json({ error: e.message }); }
    });
    app.delete('/api/algotik/symbols/:symbol', async (req, res, next) => {
        try { res.json(await algotik.removeSymbol(req.params.symbol)); }
        catch (e) { res.status(400).json({ error: e.message }); }
    });

    // ---- Full Backfill ----
    app.post('/api/algotik/full-backfill', async (req, res, next) => {
        try { res.json(await algotik.startFullBackfill(req.body || {})); }
        catch (e) { res.status(400).json({ error: e.message }); }
    });

    // ---- Jobs ----
    app.get('/api/algotik/jobs', async (req, res, next) => {
        try { res.json(await algotik.listJobs(+(req.query.limit || 30))); }
        catch (e) { next(e); }
    });
    app.get('/api/algotik/jobs/:id', async (req, res, next) => {
        try { res.json(await algotik.getJob(req.params.id)); }
        catch (e) { next(e); }
    });
    app.get('/api/algotik/jobs/:id/raw', async (req, res, next) => {
        try {
            const fetch = require('node-fetch');
            const env = require('../../config/env').get();
            const url = (env.ALGOTIK_URL || 'http://127.0.0.1:5000') + '/jobs/' + encodeURIComponent(req.params.id) + '/raw';
            const r = await fetch(url, { timeout: 10000 });
            const d = await r.json();
            res.json(d);
        } catch (e) { next(e); }
    });
    app.post('/api/algotik/jobs/:id/cancel', async (req, res, next) => {
        try { res.json(await algotik.cancelJob(req.params.id)); }
        catch (e) { res.status(400).json({ error: e.message }); }
    });
    app.post('/api/algotik/jobs/:id/pause', async (req, res, next) => {
        try {
            const fetch = require('node-fetch');
            const env = require('../../config/env').get();
            const url = (env.ALGOTIK_URL || 'http://127.0.0.1:5000') + '/jobs/' + encodeURIComponent(req.params.id) + '/pause';
            const r = await fetch(url, { method: 'POST', timeout: 10000 });
            const d = await r.json();
            res.json(d);
        } catch (e) { next(e); }
    });
    app.post('/api/algotik/jobs/:id/resume', async (req, res, next) => {
        try {
            const fetch = require('node-fetch');
            const env = require('../../config/env').get();
            const url = (env.ALGOTIK_URL || 'http://127.0.0.1:5000') + '/jobs/' + encodeURIComponent(req.params.id) + '/resume';
            const r = await fetch(url, { method: 'POST', timeout: 10000 });
            const d = await r.json();
            res.json(d);
        } catch (e) { next(e); }
    });

    // ---- Coverage (heavy — cache 5 min) ----
    // 🆕 استفاده از SWR cache مشترک با monitored-symbols
    const covCacheKey = 'algotik_coverage';

    app.get('/api/algotik/coverage', async (req, res, next) => {
        try {
            const fresh = req.query.fresh === '1';
            const db = deps.getDB();

            // 🆕 R19: prefer Mongo cache directly (0.05s vs 90s collector)
            if (!fresh) {
                try {
                    const doc = await db.collection('meta').findOne({ _id: 'coverage_cache' });
                    if (doc && doc.result && doc.computedAt) {
                        const ageMs = Date.now() - new Date(doc.computedAt).getTime();
                        // 2h freshness
                        if (ageMs < 2 * 3600 * 1000) {
                            // enrich with local DB daily/option dates (fast, indexed)
                            const norm2 = (x) => String(x || '').replace(/\u200c|\u200e|\u200f|\s/g, '').replace(/ي/g, 'ی').replace(/ك/g, 'ک');
                            try {
                                const { COLLECTIONS } = require('../../config/constants');
                                const [dailyAgg, optionAgg] = await Promise.all([
                                    db.collection(COLLECTIONS.CANDLES_DAILY).aggregate([
                                        { $group: { _id: '$symbol', to: { $max: '$time' }, from: { $min: '$time' } } }
                                    ], { maxTimeMS: 5000 }).toArray(),
                                    db.collection(COLLECTIONS.OPTION_HISTORY).aggregate([
                                        { $match: { bid: { $gt: 0 }, ask: { $gt: 0 } } },
                                        { $group: { _id: '$underlying', to: { $max: '$time' }, from: { $min: '$time' } } }
                                    ], { maxTimeMS: 8000 }).toArray()
                                ]);
                                const dailyMap = {}, dailyFromMap = {}, optMap = {}, optFromMap = {};
                                for (const d of dailyAgg) { dailyMap[d._id] = d.to; dailyFromMap[d._id] = d.from; }
                                for (const d of optionAgg) { optMap[d._id] = d.to; optFromMap[d._id] = d.from; }
                                const enriched = {
                                    ...doc.result,
                                    symbols: (doc.result.symbols || []).map(s => ({
                                        ...s,
                                        stock_daily: {
                                            ...(s.stock_daily || {}),
                                            to: dailyMap[s.symbol] || null,
                                            from: dailyFromMap[s.symbol] || null
                                        },
                                        options: {
                                            ...(s.options || {}),
                                            from: optFromMap[s.symbol] || (s.options && s.options.from) || null,
                                            to: optMap[s.symbol] || (s.options && s.options.to) || null
                                        }
                                    })),
                                    _cached: true,
                                    _cacheAge: Math.round(ageMs / 1000)
                                };
                                return res.json(enriched);
                            } catch (_) {
                                // if enrichment fails, return raw cache
                                return res.json({ ...doc.result, _cached: true });
                            }
                        }
                    }
                } catch (_) {}
            }

            // Fallback: call collector (slow path)
            const marketHours = require('../../infra/market-hours');
            const ttl = marketHours.expensiveCacheTTL();
            const key = 'algotik_coverage_swr';

            if (fresh) deps.dataService.clearCache(key);

            const r = await deps.dataService.cachedSWR(key, ttl, () => algotik.getCoverage());
            return res.json(r);
        } catch (e) { next(e); }
    });

    app.get('/api/algotik/quality', async (req, res, next) => {
        try {
            const fresh = req.query.fresh === '1';
            const marketHours = require('../../infra/market-hours');
            const ttl = marketHours.expensiveCacheTTL();   // 30min market / 12h off
            const key = 'algotik_quality_v2';

            if (fresh) {
                deps.dataService.clearCache(key);
            }

            const r = await deps.dataService.cachedSWR(key, ttl, async () => {
                return await computeQualityV2();
            });
            return res.json(r);
        } catch (e) {
            next(e);
        }
    });

    async function computeQualityV2() {
        const db = getDB();
        const { COLLECTIONS } = require('../../config/constants');
        const monitored = await db.collection(COLLECTIONS.MONITORED_SYMBOLS)
            .find({ enabled: true }).toArray();

        if (!monitored.length) {
            return {
                symbols: [],
                summary: { total: 0, good: 0, warn: 0, bad: 0 },
                computedAt: new Date().toISOString(),
            };
        }

        const symbols = monitored.map(m => m.symbol);
        const since7 = new Date(Date.now() - 7 * 86400000);

        // 5 parallel aggregations — all with maxTimeMS for safety
        const aggOpts = { allowDiskUse: false, maxTimeMS: 20000 };
        const [baseAgg, dailyAgg, optAgg, optIvAgg, ticksAgg] = await Promise.all([
            db.collection(COLLECTIONS.CANDLES_BASE).aggregate([
                { $match: { symbol: { $in: symbols }, source: 'algotik_intraday' } },
                { $group: { _id: '$symbol', count: { $sum: 1 } } }
            ], aggOpts).toArray(),
            db.collection(COLLECTIONS.CANDLES_DAILY).aggregate([
                { $match: { symbol: { $in: symbols } } },
                { $group: { _id: '$symbol', count: { $sum: 1 } } }
            ], aggOpts).toArray(),
            db.collection(COLLECTIONS.OPTION_HISTORY).aggregate([
                { $match: { underlying: { $in: symbols } } },
                { $group: { _id: '$underlying', count: { $sum: 1 }, max_time: { $max: '$time' } } }
            ], aggOpts).toArray(),
            db.collection(COLLECTIONS.OPTION_HISTORY).aggregate([
                { $match: { underlying: { $in: symbols }, ivApi: { $gt: 0 } } },
                { $group: { _id: '$underlying', count: { $sum: 1 } } }
            ], aggOpts).toArray(),
            db.collection('stock_ticks').aggregate([
                { $match: { time: { $gte: since7 } } },
                { $group: { _id: '$symbol', count: { $sum: 1 } } }
            ], aggOpts).toArray()
        ]);

        const baseMap = {};
        const dailyMap = {};
        const optMap = {};
        const optIvMap = {};
        const ticksMap = {};
        for (const r of baseAgg) baseMap[r._id] = r.count;
        for (const r of dailyAgg) dailyMap[r._id] = r.count;
        for (const r of optAgg) optMap[r._id] = r;
        for (const r of optIvAgg) optIvMap[r._id] = r.count;
        for (const r of ticksAgg) ticksMap[r._id] = r.count;

        const OPT_CUTOFF_MS = new Date('2026-06-09T00:00:00Z').getTime();

        const out = [];
        let good = 0, warn = 0, bad = 0;
        for (const m of monitored) {
            const c1m = baseMap[m.symbol] || 0;
            const cDaily = dailyMap[m.symbol] || 0;
            const optRow = optMap[m.symbol] || { count: 0, max_time: null };
            const cOpt = optRow.count;
            const cIv = optIvMap[m.symbol] || 0;
            const cTicks = ticksMap[m.symbol] || 0;

            const optToMs = optRow.max_time ? new Date(optRow.max_time).getTime() : 0;
            const optHasRecent = optToMs >= OPT_CUTOFF_MS;
            const optIsStale = cOpt > 0 && !optHasRecent;

            const stockOk = c1m >= 5000 && cDaily >= 40;
            const optOk = cOpt >= 50 && cIv >= 20;
            const liveOk = cTicks >= 500;

            let quality, reason;
            if (!stockOk) {
                quality = 'bad';
                reason = 'کندل ناکافی (1m: ' + c1m.toLocaleString() + ')';
                bad++;
            } else if (optIsStale) {
                const lastStr = optRow.max_time ? new Date(optRow.max_time).toISOString().slice(0, 10) : '?';
                quality = 'bad';
                reason = 'آپشن قدیمی (آخرین: ' + lastStr + ')';
                bad++;
            } else if (stockOk && optOk) {
                quality = 'good';
                reason = 'آماده بک تست آپشن';
                good++;
            } else if (stockOk && cOpt > 0 && cOpt < 100) {
                quality = 'warn';
                reason = 'آپشن ناقص (' + cOpt + '/100)';
                warn++;
            } else if (stockOk && cOpt === 0) {
                quality = 'bad';
                reason = 'از 1405/03/19 آپشن ندارد';
                bad++;
            } else {
                quality = 'warn';
                reason = 'داده متوسط';
                warn++;
            }

            out.push({
                symbol: m.symbol,
                quality, reason,
                backtestReady: stockOk && optOk && optHasRecent,
                liveReady: liveOk,
                optHasRecent,
                optIsStale,
                candle_1m: c1m,
                candle_daily: cDaily,
                option_history: cOpt,
                option_with_iv: cIv,
                option_last_date: optRow.max_time ? new Date(optRow.max_time).toISOString().slice(0, 10) : null,
                stock_ticks_7d: cTicks
            });
        }

        return {
            symbols: out,
            summary: { total: out.length, good, warn, bad },
            computedAt: new Date().toISOString(),
            _v: 2
        };
    }

    // ---- Enrichment proxy ----
    app.post('/api/algotik/enrich-now', async (req, res, next) => {
        try {
            const body = req.body || {};
            const r = await algotik.enrichNow({
                symbol: body.symbol || null,
                buildModelFirst: body.buildModelFirst !== false,
            });
            res.json(r);
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    app.get('/api/algotik/enrich-status', async (req, res, next) => {
        try {
            const r = await algotik.enrichStatus();
            res.json(r);
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });
    // ---- Fix gaps for single symbol ----
    app.post('/api/algotik/fix-gaps/:symbol', async (req, res, next) => {
        try {
            const symbol = req.params.symbol;
            const days = +(req.query.days || 30);
            const db = getDB();
            const { COLLECTIONS } = require('../../config/constants');

            const today = new Date(); today.setUTCHours(0, 0, 0, 0);
            const since = new Date(today.getTime() - days * 86400000);

            const daily = await db.collection(COLLECTIONS.CANDLES_BASE).aggregate([
                { $match: { symbol, source: 'algotik_intraday',
                    time: { $gte: since, $lt: today } } },
                { $group: {
                    _id: { $dateToString: { format: '%Y-%m-%d', date: '$time', timezone: 'Asia/Tehran' } },
                    count: { $sum: 1 }
                }}
            ]).toArray();

            const daysMap = new Map(daily.map(d => [d._id, d.count]));
            const gaps = [];

            let cur = new Date(since);
            while (cur < today) {
                const wd = cur.getUTCDay();
                if ([6, 0, 1, 2, 3].includes(wd)) {
                    const s = cur.toISOString().slice(0, 10);
                    const cnt = daysMap.get(s) || 0;
                // 🆕 فقط gap واقعی (کمتر از 5 کندل = داده نداره)
                // TSE هر روز ~180 کندل داره، پس < 5 یعنی واقعاً خالی
                if (cnt < 5) gaps.push({ date: s, count: cnt });
                }
                cur = new Date(cur.getTime() + 86400000);
            }

            if (!gaps.length) {
                return res.json({ ok: true, message: 'شکافی یافت نشد', gapsFound: 0 });
            }

            // 🆕 حذف کاراکترهای نامرئی Bidi قبل از ارسال به collector
            const stripBidi = (s) => String(s || '')
                .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\u061c]/g, '');

            const toJalali = (iso) => {
                const d = new Date(iso + 'T00:00:00Z');
                const fmt = new Intl.DateTimeFormat('en-US-u-ca-persian', {
                    timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit'
                });
                const p = {};
                fmt.formatToParts(d).forEach(x => p[x.type] = x.value);
                // 🆕 dash format — algotik_tse فقط با dash کار می‌کنه
                return stripBidi(`${p.year}-${p.month}-${p.day}`);
            };

            // 🆕 یک backfill per-gap — جلوگیری از backfill بازه‌ی میانیشون
            const jobIds = [];
            for (const g of gaps) {
                try {
                    const r = await algotik.startFullBackfill({
                        symbols: [symbol],
                        dateFrom: toJalali(g.date),
                        dateTo: toJalali(g.date),
                        includeStockIntraday: true,
                        includeStockDaily: true,
                        includeOptionHistory: true,
                        includeOptionSnapshot: false,
                        includeOptionMigration: false,
                        includeAggregate: true
                    });
                    jobIds.push(r.jobId);
                } catch (e) {
                    jobIds.push({ error: e.message, date: g.date });
                }
            }

            res.json({
                ok: true,
                jobIds,
                symbol,
                gapsFound: gaps.length,
                gaps: gaps.map(g => g.date),
                sample: gaps.slice(0, 5)
            });
        } catch (e) { next(e); }
    });

    // ---- Fix gaps ----
    app.post('/api/algotik/fix-gaps', async (req, res, next) => {
        try {
            const days = +(req.query.days || 7);
            const { COLLECTIONS } = require('../../config/constants');
            const db = getDB();

            const monitored = await db.collection(COLLECTIONS.MONITORED_SYMBOLS)
                .find({ enabled: true }).toArray();

            const gaps = [];
            const today = new Date(); today.setUTCHours(0, 0, 0, 0);
            const since = new Date(today.getTime() - days * 86400000);

            for (const m of monitored) {
                const pipeline = [
                    { $match: { symbol: m.symbol, source: 'algotik_intraday',
                        time: { $gte: since, $lt: today } } },
                    { $group: {
                        _id: { $dateToString: { format: '%Y-%m-%d', date: '$time', timezone: 'Asia/Tehran' } },
                        count: { $sum: 1 }
                    }},
                    { $sort: { _id: 1 } }
                ];
                const daily = await db.collection(COLLECTIONS.CANDLES_BASE)
                    .aggregate(pipeline).toArray();

                const thin = daily.filter(d => d.count < 200);
                if (thin.length) {
                    gaps.push({
                        symbol: m.symbol,
                        thinDays: thin.map(d => ({ date: d._id, count: d.count })),
                        missingCount: thin.length
                    });
                }
            }

            res.json({
                checked: monitored.length,
                withGaps: gaps.length,
                days,
                gaps: gaps.slice(0, 50)
            });
        } catch (e) { next(e); }
    });
}

module.exports = { register };

