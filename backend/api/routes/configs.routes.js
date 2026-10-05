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
            // 🆕 اجازه‌ی آپدیت pairSymbol در bulk
            const cleanPatch = {};
            if (typeof patch.enabled === 'boolean') cleanPatch.enabled = patch.enabled;
            if (patch.role === 'leader' || patch.role === 'confirmer') cleanPatch.role = patch.role;
            if (patch.pairSymbol !== undefined) cleanPatch.pairSymbol = patch.pairSymbol ? String(patch.pairSymbol) : null;
            const r = await configService.bulkUpdate(ids, Object.keys(cleanPatch).length ? cleanPatch : patch);
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
    // 🆕 Cache for chart-data (کلید: configId + lastCandleTime)
    const _chartCache = new Map();
    const CHART_TTL = 3 * 60 * 1000;

    app.get('/api/chart-data/:configId', async (req, res, next) => {
        try {
            const cfg = await configService.getById(req.params.configId);
            if (!cfg) return res.status(404).json({ error: 'تنظیم یافت نشد' });

            // چک cache
            const cached = _chartCache.get(req.params.configId);
            if (cached && Date.now() - cached.at < CHART_TTL) {
                return res.json(cached.val);
            }

            const htfTf = cfg.htfTimeframe || '1d';
            const candles = await deps.dataService.getCandlesFull(cfg.symbol, cfg.timeframe);
            const htf = deps.dataService.closedOnly(
                await deps.dataService.getCandlesFull(cfg.symbol, htfTf),
                htfTf
            );

            // 🆕 اجرای استراتژی برای گرفتن سیگنال‌ها
            let signals = [];
            let trades = [];
            let htfTrend = null;
            try {
                const STRATEGIES = deps.strategies.STRATEGIES;
                const def = STRATEGIES[cfg.strategyId];
                if (def) {
                    const closedCandles = deps.dataService.closedOnly(candles, cfg.timeframe);
                    const ew = deps.settings.entryWindow();
                    const result = def.run(
                        closedCandles,
                        { ...cfg.params, candleType: cfg.candleType },
                        { htfCandles: htf, htfTimeframe: htfTf, entryWindow: ew }
                    );
                    const rawSignals = (result.signals || []).filter(s =>
                        s.signalType === 'BUY' || s.signalType === 'EXIT_LONG'
                    );
                    const candlesMap = new Map(candles.map(c => [c.time, c]));
                    signals = rawSignals.map(s => ({
                        time: s.time,
                        type: s.signalType,
                        reason: s.reason || null,
                        price: (candlesMap.get(s.time) || {}).close || null,
                        stop: (s.indicators && s.indicators.stop) || null,
                        atr: (s.indicators && s.indicators.atr) || null
                    }));
                    trades = (result.trades || []).map(t => ({
                        entryTime: t.entryDate,
                        entryPrice: t.entryPrice,
                        exitTime: t.exitDate || null,
                        exitPrice: t.exitPrice || null,
                        pnlPct: t.pnlPct != null ? t.pnlPct : null,
                        exitReason: t.exitReason || null,
                        stop: t.stop || null,
                        risk: t.risk || null
                    }));
                    htfTrend = result.htfTrend || null;
                }
            } catch (sigErr) {
                deps.logger && deps.logger.warn('chart signals: ' + sigErr.message);
            }

            const payload = {
                config: cfg,
                candles,
                signals,
                trades,
                htfTrend,
                closedCount: deps.dataService.closedOnly(candles, cfg.timeframe).length,
                htfCandles: htf,
                htfTimeframe: htfTf,
                entryWindow: deps.settings.entryWindow()
            };
            _chartCache.set(req.params.configId, { at: Date.now(), val: payload });
            // 🆕 پاکسازی: حذف منقضی‌ها + محدودیت سخت اندازه
            if (_chartCache.size > 50) {
                const cutoff = Date.now() - CHART_TTL;
                for (const [k, v] of _chartCache) {
                    if (v.at < cutoff) _chartCache.delete(k);
                }
                if (_chartCache.size > 40) {
                    const sorted = [..._chartCache.entries()].sort((a, b) => a[1].at - b[1].at);
                    const toRemove = _chartCache.size - 30;
                    for (let i = 0; i < toRemove; i++) _chartCache.delete(sorted[i][0]);
                }
            }
            res.json(payload);
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

    app.get('/api/signal-history/rejected', async (req, res, next) => {
        try {
            const limit = Math.min(+(req.query.limit || 100), 500);
            const list = await getDB().collection(COLLECTIONS.SIGNAL_HISTORY)
                .find({ rejected: true })
                .sort({ createdAt: -1 })
                .limit(limit)
                .toArray();
            res.json({ count: list.length, signals: list });
        } catch (e) { next(e); }
    });
}

module.exports = { register };