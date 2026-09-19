'use strict';
// ============================================================
// configs.routes.js — strategy_configs CRUD + bulk
// ============================================================

const { COLLECTIONS } = require('../../config/constants');

function register(app, deps) {
    const { getDB, configService } = deps;

    // ---- List ----
    app.get('/api/strategy-configs', async (req, res, next) => {
        try {
            res.json(await configService.list());
        } catch (e) { next(e); }
    });

    // ---- Create ----
    app.post('/api/strategy-configs', async (req, res, next) => {
        try {
            const doc = await configService.create(req.body);
            res.json(doc);
        } catch (e) {
            if (e.status) return res.status(e.status).json({ error: e.message });
            next(e);
        }
    });

    // ---- Update ----
    app.put('/api/strategy-configs/:id', async (req, res, next) => {
        try {
            const r = await configService.update(req.params.id, req.body || {});
            res.json(r);
        } catch (e) {
            if (e.status) return res.status(e.status).json({ error: e.message });
            next(e);
        }
    });

    // ---- Delete ----
    app.delete('/api/strategy-configs/:id', async (req, res, next) => {
        try {
            const r = await configService.remove(req.params.id);
            res.json(r);
        } catch (e) { next(e); }
    });

    // ---- Bulk update ----
    app.post('/api/strategy-configs/bulk-update', async (req, res, next) => {
        try {
            const { ids, ...patch } = req.body || {};
            const r = await configService.bulkUpdate(ids, patch);
            res.json(r);
        } catch (e) {
            if (e.status) return res.status(e.status).json({ error: e.message });
            next(e);
        }
    });

    // ---- Bulk delete ----
    app.post('/api/strategy-configs/bulk-delete', async (req, res, next) => {
        try {
            const { ids } = req.body || {};
            const r = await configService.bulkDelete(ids);
            res.json(r);
        } catch (e) {
            if (e.status) return res.status(e.status).json({ error: e.message });
            next(e);
        }
    });

    // ---- Status (signals_state) ----
    app.get('/api/status', async (req, res, next) => {
        try {
            const states = await getDB().collection(COLLECTIONS.SIGNALS_STATE).find({}).toArray();
            res.json(states);
        } catch (e) { next(e); }
    });

    // ---- Signal history ----
    app.get('/api/signal-history', async (req, res, next) => {
        try {
            const list = await getDB().collection(COLLECTIONS.SIGNAL_HISTORY)
                .find({}).sort({ createdAt: -1 }).limit(300).toArray();
            res.json(list);
        } catch (e) { next(e); }
    });

    app.delete('/api/signal-history', async (req, res, next) => {
        try {
            await getDB().collection(COLLECTIONS.SIGNAL_HISTORY).deleteMany({});
            res.json({ success: true });
        } catch (e) { next(e); }
    });

    // ---- Chart data for config ----
    app.get('/api/chart-data/:configId', async (req, res, next) => {
        try {
            const cfg = await configService.getById(req.params.configId);
            if (!cfg) return res.status(404).json({ error: 'تنظیم یافت نشد' });

            const htfTf = cfg.htfTimeframe || '1d';
            const candles = await deps.dataService.getCandlesFull(cfg.symbol, cfg.timeframe);
            const htf = deps.dataService.closedOnly(
                await deps.dataService.getCandlesFull(cfg.symbol, htfTf),
                htfTf
            );

            res.json({
                config: cfg,
                candles,
                closedCount: deps.dataService.closedOnly(candles, cfg.timeframe).length,
                htfCandles: htf,
                htfTimeframe: htfTf,
                entryWindow: deps.settings.entryWindow()
            });
        } catch (e) { next(e); }
    });

    // ---- Portfolio ----
    app.get('/api/portfolio', async (req, res, next) => {
        try {
            const s = deps.settings.get();
            const open = await getDB().collection(COLLECTIONS.OPTION_POSITIONS)
                .find({ status: 'open' }).toArray();

            const bySymbol = {};
            let totalExposure = 0;
            for (const p of open) {
                const value = (p.entryAsk || 0) * (p.positionSize || 1) * (p.size || 1000);
                bySymbol[p.underlying] = (bySymbol[p.underlying] || 0) + value;
                totalExposure += value;
            }

            const capital = s.TOTAL_CAPITAL || 0;
            res.json({
                totalCapital: capital,
                riskPerTrade: capital * (s.RISK_PER_TRADE_PCT / 100),
                maxSymbolExposure: capital * (s.MAX_SYMBOL_EXPOSURE_PCT / 100),
                maxTotalExposure: capital * (s.MAX_TOTAL_EXPOSURE_PCT / 100),
                minCashReserve: capital * (s.MIN_CASH_RESERVE_PCT / 100),
                totalExposure,
                availableCash: capital - totalExposure,
                exposurePct: capital > 0 ? (totalExposure / capital * 100) : 0,
                openCount: open.length,
                bySymbol
            });
        } catch (e) { next(e); }
    });

    // ---- Evaluate Now ----
    app.post('/api/evaluate-now', async (req, res, next) => {
        try {
            await deps.signalService.tick();
            res.json({
                success: true,
                lastTickAt: deps.signalService.getHealth().lastTickAt,
                lastError: deps.signalService.getHealth().lastError,
                consecutiveFailures: deps.signalService.getHealth().consecutiveFailures
            });
        } catch (e) { next(e); }
    });
}

module.exports = { register };