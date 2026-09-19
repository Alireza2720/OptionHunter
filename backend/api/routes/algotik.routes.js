'use strict';
// ============================================================
// algotik.routes.js — مدیریت دریافت داده از AlgoTik
// ============================================================

const { COLLECTIONS } = require('../../config/constants');

function register(app, deps) {
    const { getDB, algotik } = deps;

    // ---- Health ----
    app.get('/api/algotik/health', async (req, res) => {
        try {
            const online = await algotik.isOnline();
            res.json({ online });
        } catch (e) {
            res.json({ online: false, error: e.message });
        }
    });

    // ---- Status ----
    app.get('/api/algotik/status', async (req, res, next) => {
        try { res.json(await algotik.getStatus()); }
        catch (e) { next(e); }
    });

    // ---- Logs ----
    app.get('/api/algotik/logs', async (req, res, next) => {
        try {
            const limit = Math.min(+req.query.limit || 50, 500);
            res.json(await algotik.getLogs(limit));
        } catch (e) { next(e); }
    });

    // ---- Live market snapshot ----
    app.get('/api/algotik/live-market', async (req, res, next) => {
        try {
            const data = await algotik.getLiveMarket(req.query.force === '1');
            res.json({ count: data.length, data: data.slice(0, 100) });
        } catch (e) { next(e); }
    });

    // ---- Fetch stocks (backfill) ----
    app.post('/api/algotik/fetch-stocks', async (req, res, next) => {
        try {
            const { symbols, months, startDate, wait, skipExisting } = req.body || {};
            let list;
            if (symbols && symbols.length) list = symbols;
            else {
                const ms = await getDB().collection(COLLECTIONS.MONITORED_SYMBOLS)
                    .find({ collectEnabled: { $ne: false } }).toArray();
                list = ms.map(s => s.symbol);
            }
            if (!list.length) return res.status(400).json({ error: 'لیست نمادها خالی است' });

            const result = await algotik.fetchStocks(list, months || 24, {
                wait: !!wait, startDate,
                skipExisting: skipExisting !== false
            });
            res.json(result);
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    // ---- Fetch options snapshot ----
    app.post('/api/algotik/fetch-options', async (req, res, next) => {
        try {
            const { underlyings, skipExisting } = req.body || {};
            let list;
            if (underlyings && underlyings.length) list = underlyings;
            else {
                const ms = await getDB().collection(COLLECTIONS.MONITORED_SYMBOLS)
                    .find({ collectEnabled: { $ne: false } }).toArray();
                list = ms.map(s => s.symbol);
            }
            res.json(await algotik.fetchOptions(list, { skipExisting: skipExisting !== false }));
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    // ---- Options daily job ----
    app.post('/api/algotik/options-daily-job', async (req, res, next) => {
        try {
            const { underlyings, force } = req.body || {};
            let list;
            if (underlyings && underlyings.length) list = underlyings;
            else {
                const ms = await getDB().collection(COLLECTIONS.MONITORED_SYMBOLS)
                    .find({ collectEnabled: { $ne: false } }).toArray();
                list = ms.map(s => s.symbol);
            }
            res.json(await algotik.startOptionsDailyJob(list, !!force));
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    // ---- Fetch options daily (wrapper) ----
    app.post('/api/algotik/fetch-options-daily', async (req, res, next) => {
        try {
            const { underlyings } = req.body || {};
            let list;
            if (underlyings && underlyings.length) list = underlyings;
            else {
                const ms = await getDB().collection(COLLECTIONS.MONITORED_SYMBOLS)
                    .find({ collectEnabled: { $ne: false } }).toArray();
                list = ms.map(s => s.symbol);
            }
            res.json(await algotik.fetchOptionsDaily(list));
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    // ---- Backfill all ----
    app.post('/api/algotik/backfill-all', async (req, res, next) => {
        try {
            const { months, withOptions } = req.body || {};
            res.json(await algotik.backfillAll(months || 24, withOptions !== false));
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    // ---- Options history bulk ----
    app.post('/api/algotik/options-history', async (req, res, next) => {
        try {
            const { symbol, months } = req.body || {};
            if (!symbol) return res.status(400).json({ error: 'symbol الزامی' });
            res.json(await algotik.fetchOptionsHistoryBulk(symbol, months || 24));
        } catch (e) { res.status(400).json({ error: e.message }); }
    });

    // ---- Job status ----
    app.get('/api/algotik/job/:id', async (req, res, next) => {
        try { res.json(await algotik.getJobStatus(req.params.id)); }
        catch (e) { next(e); }
    });

    app.get('/api/algotik/jobs', async (req, res, next) => {
        try { res.json(await algotik.listJobs(+req.query.limit || 20)); }
        catch (e) { next(e); }
    });

    app.post('/api/algotik/job/:id/cancel', async (req, res, next) => {
        try { res.json(await algotik.cancelJob(req.params.id)); }
        catch (e) { res.status(400).json({ error: e.message }); }
    });

    // ---- Stats ----
    app.get('/api/algotik/stats', async (req, res, next) => {
        try {
            const db = getDB();
            const [stockCount, symbols, optSnap, optDaily] = await Promise.all([
                db.collection(COLLECTIONS.CANDLES_BASE).countDocuments({ source: 'algotik' }),
                db.collection(COLLECTIONS.CANDLES_BASE).distinct('symbol', { source: 'algotik' }),
                db.collection(COLLECTIONS.OPTION_SNAPSHOTS_ALGOTIK).countDocuments({}),
                db.collection(COLLECTIONS.OPTION_DAILY_ALGOTIK).countDocuments({})
            ]);

            const lastSnap = await db.collection(COLLECTIONS.OPTION_SNAPSHOTS_ALGOTIK)
                .find({}).sort({ timestamp: -1 }).limit(1).toArray();
            const lastDaily = await db.collection(COLLECTIONS.OPTION_DAILY_ALGOTIK)
                .find({}).sort({ date: -1 }).limit(1).toArray();

            res.json({
                stocks: { candles: stockCount, symbols: symbols.length },
                options: {
                    snapshots: optSnap,
                    dailyRecords: optDaily,
                    lastSnapshotAt: lastSnap[0]?.timestamp || null,
                    lastDailyDate: lastDaily[0]?.date || null
                }
            });
        } catch (e) { next(e); }
    });

    // ---- Per-symbol data coverage ----
    app.get('/api/algotik/coverage', async (req, res, next) => {
        try {
            const db = getDB();
            const monitored = await db.collection(COLLECTIONS.MONITORED_SYMBOLS)
                .find({}).toArray();

            const result = [];
            for (const m of monitored) {
                const candleCount = await db.collection(COLLECTIONS.CANDLES_BASE)
                    .countDocuments({ symbol: m.symbol });
                const dailyCount = await db.collection(COLLECTIONS.CANDLES_DAILY)
                    .countDocuments({ symbol: m.symbol });
                const optCount = await db.collection(COLLECTIONS.OPTION_HISTORY)
                    .countDocuments({ underlying: m.symbol });
                const optDailyCount = await db.collection(COLLECTIONS.OPTION_DAILY)
                    .countDocuments({ underlying: m.symbol });

                const lastCandle = await db.collection(COLLECTIONS.CANDLES_BASE)
                    .find({ symbol: m.symbol }).sort({ time: -1 }).limit(1).toArray();

                result.push({
                    symbol: m.symbol,
                    collectEnabled: m.collectEnabled !== false,
                    candles: candleCount,
                    daily: dailyCount,
                    optionSnapshots: optCount,
                    optionDaily: optDailyCount,
                    lastCandleAt: lastCandle[0]?.time || null
                });
            }

            result.sort((a, b) => a.symbol.localeCompare(b.symbol));
            res.json({ symbols: result, count: result.length });
        } catch (e) { next(e); }
    });
}

module.exports = { register };