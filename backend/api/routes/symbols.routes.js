'use strict';
// ============================================================
// symbols.routes.js — monitored_symbols + search + quotes
// ============================================================

const { ObjectId } = require('mongodb');
const { COLLECTIONS, TIMEFRAME_MINUTES } = require('../../config/constants');

function register(app, deps) {
    const { getDB, signalService, dataService } = deps;

    // ---- Search ----
    app.get('/api/symbols/search', async (req, res, next) => {
        try {
            const q = (req.query.q || '').trim();
            if (!q) return res.json([]);

            // جستجو در symbols_cache (اگه داریم)
            const doc = await getDB().collection(COLLECTIONS.META).findOne({ _id: 'symbols_cache' });
            const cache = (doc && doc.symbols) || [];
            const results = cache
                .filter(s => s.symbol.includes(q) || (s.name && s.name.includes(q)))
                .slice(0, 20);
            res.json(results);
        } catch (e) { next(e); }
    });

    // ---- Chart search ----
    app.get('/api/chart/search', async (req, res, next) => {
        try {
            const q = (req.query.q || '').trim();
            if (!q) return res.json({ results: [] });

            const doc = await getDB().collection(COLLECTIONS.META).findOne({ _id: 'symbols_cache' });
            const cache = (doc && doc.symbols) || [];
            const results = [];
            for (const s of cache) {
                if (s.symbol.includes(q) || (s.name && s.name.includes(q))) {
                    results.push({ symbol: s.symbol, name: s.name, source: 'local' });
                    if (results.length >= 15) break;
                }
            }
            res.json({ results });
        } catch (e) { next(e); }
    });

    // ---- Monitored symbols list ----
    app.get('/api/monitored-symbols', async (req, res, next) => {
        try {
            const db = getDB();
            const [symbols, counts, dcounts] = await Promise.all([
                db.collection(COLLECTIONS.MONITORED_SYMBOLS).find({}).sort({ addedAt: 1 }).toArray(),
                db.collection(COLLECTIONS.CANDLES_BASE).aggregate([
                    { $group: { _id: '$symbol', c: { $sum: 1 } } }
                ]).toArray(),
                db.collection(COLLECTIONS.CANDLES_DAILY).aggregate([
                    { $group: { _id: '$symbol', c: { $sum: 1 } } }
                ]).toArray()
            ]);
            const cm = new Map(counts.map(c => [c._id, c.c]));
            const dm = new Map(dcounts.map(c => [c._id, c.c]));

            res.json(symbols.map(s => ({
                ...s,
                candleCount: cm.get(s.symbol) || 0,
                dailyCount: dm.get(s.symbol) || 0
            })));
        } catch (e) { next(e); }
    });

    // ---- Add ----
    app.post('/api/monitored-symbols', async (req, res, next) => {
        try {
            const { symbol } = req.body;
            if (!symbol) return res.status(400).json({ error: 'symbol الزامی است' });

            const db = getDB();
            const exists = await db.collection(COLLECTIONS.MONITORED_SYMBOLS).findOne({ symbol });
            if (exists) return res.status(400).json({ error: 'این نماد قبلا اضافه شده است' });
        const doc = {
            symbol,
            addedAt: new Date(),
            collectEnabled: true,
            enabled: true
        };
        const r = await db.collection(COLLECTIONS.MONITORED_SYMBOLS).insertOne(doc);
            res.json({ _id: r.insertedId, ...doc });
        } catch (e) { next(e); }
    });

    // ---- Update ----
    app.put('/api/monitored-symbols/:id', async (req, res, next) => {
        try {
            const upd = {};
            if (typeof req.body.collectEnabled === 'boolean') {
                upd.collectEnabled = req.body.collectEnabled;
                upd.enabled = req.body.collectEnabled;
            }
            if (req.body.notes !== undefined) upd.notes = String(req.body.notes || '');
            if (!Object.keys(upd).length) return res.status(400).json({ error: 'فیلدی مشخص نشد' });

            await getDB().collection(COLLECTIONS.MONITORED_SYMBOLS).updateOne(
                { _id: new ObjectId(req.params.id) },
                { $set: upd }
            );
            res.json({ success: true });
        } catch (e) { next(e); }
    });

    // ---- Bulk collect toggle ----
    app.post('/api/monitored-symbols/bulk-collect', async (req, res, next) => {
        try {
            const { ids, collectEnabled } = req.body || {};
            if (!Array.isArray(ids) || !ids.length) {
                return res.status(400).json({ error: 'لیست خالی' });
            }
            if (typeof collectEnabled !== 'boolean') {
                return res.status(400).json({ error: 'collectEnabled باید boolean باشد' });
            }
            const objectIds = ids.map(id => new ObjectId(id));
            const r = await getDB().collection(COLLECTIONS.MONITORED_SYMBOLS).updateMany(
                { _id: { $in: objectIds } },
                { $set: { collectEnabled, enabled: collectEnabled } }
            );
            res.json({ success: true, updated: r.modifiedCount });
        } catch (e) { next(e); }
    });

    // ---- Delete ----
    app.delete('/api/monitored-symbols/:id', async (req, res, next) => {
        try {
            const db = getDB();
            const doc = await db.collection(COLLECTIONS.MONITORED_SYMBOLS).findOne({
                _id: new ObjectId(req.params.id)
            });
            if (!doc) return res.status(404).json({ error: 'یافت نشد' });

            const n = await db.collection(COLLECTIONS.STRATEGY_CONFIGS)
                .countDocuments({ symbol: doc.symbol });
            if (n) return res.status(400).json({ error: `این نماد در ${n} تنظیم استفاده شده است.` });

            await db.collection(COLLECTIONS.MONITORED_SYMBOLS).deleteOne({ _id: doc._id });
            res.json({ success: true });
        } catch (e) { next(e); }
    });

    // ---- Quotes ----
    app.get('/api/quotes', (req, res) => {
        const quotes = signalService.getLastQuotes();
        const out = {};
        for (const [sym, q] of quotes) out[sym] = { price: q.price, queue: q.queue, at: q.at };
        res.json(out);
    });

    // ---- Chart ----
    app.get('/api/chart/:symbol/:timeframe', async (req, res, next) => {
        try {
            const { ALL_CHART_TIMEFRAMES } = require('../../config/constants');
            const { symbol, timeframe } = req.params;
            if (!ALL_CHART_TIMEFRAMES[timeframe]) {
                return res.status(400).json({ error: 'تایم فریم نامعتبر' });
            }

            const candles = await dataService.getChartCandles(symbol, timeframe);
            res.json({
                symbol, timeframe, candles,
                count: candles.length,
                source: candles.length >= 50 ? 'local' : 'limited'
            });
        } catch (e) { next(e); }
    });

    // ---- Candles ----
    app.get('/api/candles/:symbol/:timeframe', async (req, res, next) => {
        try {
            const { symbol, timeframe } = req.params;
            const { TIMEFRAME_MINUTES } = require('../../config/constants');
            if (!TIMEFRAME_MINUTES[timeframe]) {
                return res.status(400).json({ error: 'تایم فریم نامعتبر' });
            }
            const candles = await dataService.getCandles(symbol, timeframe);
            res.json(candles);
        } catch (e) { next(e); }
    });

    // ---- Data Coverage ----
    app.get('/api/data-coverage', async (req, res, next) => {
        try {
            const db = getDB();
            const monitored = await db.collection(COLLECTIONS.MONITORED_SYMBOLS).find({}).toArray();
            const STRATEGIES = require('../../strategies').STRATEGIES;
            const { getRequiredCandles } = require('../../strategies');

            const strategies = Object.values(STRATEGIES).map(s => ({
                id: s.id, name: s.name,
                defaultTimeframe: s.defaultTimeframe,
                defaultParams: s.defaultParams
            }));

            const coverage = await dataService.getDataCoverage(
                monitored.map(m => m.symbol),
                strategies,
                getRequiredCandles
            );
            res.json({ symbols: coverage, generatedAt: new Date() });
        } catch (e) { next(e); }
    });
}

module.exports = { register };