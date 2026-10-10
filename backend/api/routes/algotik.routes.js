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
            const marketHours = require('../../infra/market-hours');
            const ttl = marketHours.expensiveCacheTTL();

            if (fresh) {
                // درخواست دستی → cache رو نادیده بگیر
                deps.dataService.clearCache(covCacheKey);
            }

            const r = await deps.dataService.cachedSWR(covCacheKey, ttl,
                () => algotik.getCoverage());
            const norm2 = (x) => String(x || '').replace(/\u200c|\u200e|\u200f|\s/g, '').replace(/ي/g, 'ی').replace(/ك/g, 'ک');
            // R22b: enrich coverage with daily to-date from DB
            try {
                const db = deps.getDB();
                const { COLLECTIONS } = require('../../config/constants');
                const dailyAgg = await db.collection(COLLECTIONS.CANDLES_DAILY).aggregate([
                    { $group: { _id: '$symbol', to: { $max: '$time' }, from: { $min: '$time' } } }
                ]).toArray();
            const optionAgg = await db.collection(COLLECTIONS.OPTION_HISTORY).aggregate([
                { $match: { bid: { $gt: 0 }, ask: { $gt: 0 } } },
                { $group: { _id: '$underlying', to: { $max: '$time' }, from: { $min: '$time' } } }
            ]).toArray();
            const optionFromMap = {};
            const optionToMap = {};
            for (const d of optionAgg) { optionFromMap[d._id] = d.from; optionToMap[d._id] = d.to; }
                const dailyMap = {};
                const dailyFromMap = {};
            for (const d of dailyAgg) { dailyMap[d._id] = d.to; dailyFromMap[d._id] = d.from; }
                const enriched = {
                    ...r,
                    symbols: (r.symbols || []).map(s => ({
                        ...s,
                        stock_daily: {
                            ...(s.stock_daily || {}),
                            to: dailyMap[s.symbol] || null,
                        from: dailyFromMap[s.symbol] || null
                        },
                        options: {
                            ...(s.options || {}),
                            from: optionFromMap[s.symbol] || (s.options && s.options.from) || null,
                            to: optionToMap[s.symbol] || (s.options && s.options.to) || null
                        }
                    }))
                };
                return res.json(enriched);
            } catch (_) {
                return res.json(r);
            }
        } catch (e) { next(e); }
    });

    // ---- Audit ----
    app.get('/api/algotik/audit', async (req, res, next) => {
        try {
            const days = +(req.query.days || 730);
            const r = await algotik.auditAll(days);
            res.json(r);
        } catch (e) { next(e); }
    });
    app.get('/api/algotik/audit/:symbol', async (req, res, next) => {
        try {
            const days = +(req.query.days || 730);
            const r = await algotik.auditOne(req.params.symbol, days);
            res.json(r);
        } catch (e) { next(e); }
    });

    app.get('/api/algotik/data-range', async (req, res, next) => {
        try { res.json(await algotik.getDataRange()); }
        catch (e) { next(e); }
    });
    app.get('/api/algotik/explain/:symbol', async (req, res, next) => {
        try {
            const fetch = require('node-fetch');
            const env = require('../../config/env').get();
            const url = (env.ALGOTIK_URL || 'http://127.0.0.1:5000') + '/explain/' + encodeURIComponent(req.params.symbol);
            const r = await fetch(url, { timeout: 15000 });
            const d = await r.json();
            res.json(d);
        } catch (e) { next(e); }
    });

    app.get('/api/algotik/data-range/:symbol', async (req, res, next) => {
        try {
            res.json(await algotik.getSymbolDataRange(req.params.symbol));
        } catch (e) { next(e); }
    });

    // Stock candle data range from local DB (backend)
    app.get('/api/algotik/data-range-stock', async (req, res, next) => {
        try {
            const db = getDB();
            const { COLLECTIONS } = require('../../config/constants');
            const earliest = await db.collection(COLLECTIONS.CANDLES_DAILY)
                .find({}).sort({ time: 1 }).limit(1).toArray();
            const latest = await db.collection(COLLECTIONS.CANDLES_DAILY)
                .find({}).sort({ time: -1 }).limit(1).toArray();
            if (!earliest.length || !latest.length) {
                return res.json({ from: null, to: null, days: 0 });
            }
            const from = new Date(earliest[0].time).toISOString().slice(0, 10);
            const to = new Date(latest[0].time).toISOString().slice(0, 10);
            const days = Math.floor((new Date(to) - new Date(from)) / 86400000);
            res.json({ from, to, days });
        } catch (e) { next(e); }
    });

    // ---- Risk-free ----
    app.get('/api/algotik/risk-free', async (req, res, next) => {
        try { res.json(await algotik.getRiskFree()); } catch (e) { next(e); }
    });

    // ---- Ticker ----
    app.post('/api/algotik/ticker', async (req, res, next) => {
        try {
            const { action, intervalSec } = req.body || {};
            res.json(await algotik.controlTicker(action || 'start', intervalSec || 10));
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    // ---- Data freshness ----
    app.get('/api/algotik/freshness', async (req, res, next) => {
        try {
            const { COLLECTIONS } = require('../../config/constants');
            const db = getDB();
            const monitored = await db.collection(COLLECTIONS.MONITORED_SYMBOLS)
                .find({ enabled: true }).toArray();

            const today = new Date();
            today.setUTCHours(0, 0, 0, 0);

            const results = [];
            for (const m of monitored) {
                const last = await db.collection(COLLECTIONS.CANDLES_DAILY)
                    .find({ symbol: m.symbol }).sort({ time: -1 }).limit(1).toArray();
                const lastTime = last[0] ? new Date(last[0].time) : null;
                const gap = lastTime ? Math.floor((today - lastTime) / 86400000) : null;
                results.push({
                    symbol: m.symbol,
                    lastDaily: lastTime ? lastTime.toISOString().slice(0, 10) : null,
                    gapDays: gap,
                    stale: gap !== null && gap > 3
                });
            }

            const stale = results.filter(r => r.stale);
            res.json({
                today: today.toISOString().slice(0, 10),
                total: results.length,
                staleCount: stale.length,
                staleSymbols: stale.map(r => r.symbol),
                symbols: results
            });
        } catch (e) { next(e); }
    });

    // ---- Ticker log ----
    app.get('/api/algotik/ticker-log', async (req, res, next) => {
        try {
            const limit = Math.min(+(req.query.limit || 10), 100);
            const { COLLECTIONS } = require('../../config/constants');
            const db = getDB();
            const docs = await db.collection(COLLECTIONS.LOGS)
                .find({ msg: { $regex: '^tick \\|' } })
                .sort({ at: -1 }).limit(limit).toArray();
            const logs = docs.map(d => {
                const m = String(d.msg || '').match(/tick \| (\d+) symbols \| ticks=(\d+) \| volDelta=(\d+)/);
                return {
                    at: d.at,
                    symbols: m ? +m[1] : 0,
                    ticksOk: m ? +m[2] : 0,
                    volumeDelta: m ? +m[3] : 0
                };
            });
            res.json({ logs });
        } catch (e) { next(e); }
    });

    // ---- Data Quality ----
    app.get('/api/algotik/quality', async (req, res, next) => {
        try {
            const fresh = req.query.fresh === '1';
            const marketHours = require('../../infra/market-hours');
            const ttl = marketHours.expensiveCacheTTL();
            const key = 'algotik_quality';

            if (fresh) {
                deps.dataService.clearCache(key);
            }

            const r = await deps.dataService.cachedSWR(key, ttl, async () => {
                // کد قدیمی رو داخل این تابع پیچیده بشه
                return await computeQuality();
            });
            return res.json(r);
        } catch (e) { next(e); }
    });

    // 🆕 جدا کردن محاسبه‌ی quality
    async function computeQuality() {
        const db = getDB();
        const { COLLECTIONS } = require('../../config/constants');
        const monitored = await db.collection(COLLECTIONS.MONITORED_SYMBOLS)
            .find({ enabled: true }).toArray();

        const cov = await algotik.getCoverage();
        const covMap = {};
        for (const c of (cov.symbols || [])) covMap[c.symbol] = c;

        const since7 = new Date(Date.now() - 7 * 86400000);
        const ticksAgg = await db.collection('stock_ticks').aggregate([
            { $match: { time: { $gte: since7 } } },
            { $group: { _id: '$symbol', count: { $sum: 1 } } }
        ]).toArray();
        const ticksMap = {};
        for (const t of ticksAgg) ticksMap[t._id] = t.count;

        const symbols = [];
        let good = 0, warn = 0, bad = 0;
        for (const m of monitored) {
            const c = covMap[m.symbol] || {};
            const c1m = (c.stock_base && c.stock_base.count) || 0;
            const cDaily = (c.stock_daily && c.stock_daily.count) || 0;
            const cOpt = (c.options && c.options.count) || 0;
            const cIv = (c.options && c.options.with_iv) || 0;
            const cTicks = ticksMap[m.symbol] || 0;

            // 🆕 آستانه‌های واقع‌گرایانه‌تر برای نمادهای کم‌معامله
            const stockOk = c1m >= 5000 && cDaily >= 40;
            const optOk = cOpt >= 50 && cIv >= 20;
            const liveOk = cTicks >= 500;

                        const OPT_CUTOFF_MS = OPTION_DATA_CUTOFF.getTime();
            const optToMs = c.options && c.options.to ? new Date(c.options.to).getTime() : 0;
            const optHasRecent = optToMs >= OPT_CUTOFF_MS;
            const optIsStale = cOpt > 0 && !optHasRecent;

            let quality, reason;
            if (!stockOk) {
                quality = 'bad'; reason = `کندل ناکافی (1m: ${c1m.toLocaleString()})`; bad++;
            } else if (optIsStale) {
                quality = 'bad';
                reason = `آپشن قدیمی (آخرین: ${c.options.to.slice(0,10)}) — نیاز به backfill`;
                bad++;
            } else if (stockOk && optOk) {
                quality = 'good'; reason = 'آماده بک‌تست آپشن'; good++;
            } else if (stockOk && cOpt > 0 && cOpt < 100) {
                quality = 'warn'; reason = `آپشن ناقص (${cOpt}/100)`; warn++;
            } else if (stockOk && cOpt === 0) {
                quality = 'bad';
                reason = `از 1405/03/19 به بعد آپشن ندارد — نماد اصلاً آپشن نداره`;
                bad++;
            } else {
                quality = 'warn'; reason = 'داده متوسط'; warn++;
            }

            symbols.push({
                symbol: m.symbol, quality, reason,
                backtestReady: stockOk && optOk && optHasRecent,
                liveReady: liveOk,
                optHasRecent,
                optIsStale,
                candle_1m: c1m, candle_daily: cDaily,
                option_history: cOpt, option_with_iv: cIv,
                option_last_date: c.options && c.options.to ? c.options.to.slice(0,10) : null,
                stock_ticks_7d: cTicks
            });
        }

        return {
            symbols,
            summary: { total: symbols.length, good, warn, bad },
            computedAt: new Date().toISOString()
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

