'use strict';
// ============================================================
// backtest.routes.js — بک‌تست sync (fallback) + compare sync
// ============================================================
// این route ها برای حالت‌های خاص (تست سریع، اسکریپت‌های بیرونی)
// ============================================================

const { ObjectId } = require('mongodb');
const { COLLECTIONS } = require('../../config/constants');

function register(app, deps) {
    const { getDB, backtest, options, dataService, configService } = deps;

    // ---- Sync backtest (fallback برای سازگاری) ----
    app.get('/api/backtest-option/:configId', async (req, res, next) => {
        try {
            const cfg = await configService.getById(req.params.configId);
            if (!cfg) return res.status(404).json({ error: 'تنظیم یافت نشد' });

            const dateFrom = req.query.from ? parseInt(req.query.from) : null;
            const dateTo = req.query.to ? parseInt(req.query.to) : null;

            const result = await backtest.runBacktest(cfg, dateFrom, dateTo, {
                useRealOption: req.query.real === '1'
            });
            res.json(result);
        } catch (e) { next(e); }
    });

    // ---- Sync backtest-compare (fallback) ----
    app.post('/api/backtest-compare', async (req, res, next) => {
        try {
            const { symbols, strategies, useRealOption, dateFrom, dateTo } = req.body || {};
            if (!Array.isArray(symbols) || !symbols.length) {
                return res.status(400).json({ error: 'حداقل یک نماد' });
            }
            if (!Array.isArray(strategies) || !strategies.length) {
                return res.status(400).json({ error: 'حداقل یک استراتژی' });
            }

            const fromTs = dateFrom ? parseInt(dateFrom) : null;
            const toTs = dateTo ? parseInt(dateTo) : null;

            const allResults = [];
            const STRATEGIES = require('../../strategies').STRATEGIES;

            for (const symbol of symbols) {
                for (const s of strategies) {
                    const def = STRATEGIES[s.id];
                    if (!def) continue;

                    const cfg = {
                        symbol,
                        strategyId: s.id,
                        timeframe: s.timeframe || def.defaultTimeframe,
                        htfTimeframe: s.htfTimeframe || def.htfTimeframe || '1d',
                        candleType: s.candleType === 'simple' ? 'simple' : 'heikin',
                        params: {
                            ...def.defaultParams,
                            ...(deps.settings.getStrategyDefaults(s.id) || {}),
                            ...(s.params || {})
                        }
                    };

                    try {
                        const r = await backtest.runBacktest(cfg, fromTs, toTs, {
                            useRealOption: !!useRealOption
                        });
                        allResults.push({
                            symbol,
                            strategyId: s.id,
                            strategyName: def.name,
                            timeframe: cfg.timeframe,
                            htfTimeframe: cfg.htfTimeframe,
                            candleType: cfg.candleType,
                            stock: r.stockStats,
                            option: r.stats,
                            optionMode: r.mode
                        });
                    } catch (e) {
                        allResults.push({
                            symbol,
                            strategyId: s.id,
                            strategyName: def.name,
                            timeframe: cfg.timeframe,
                            htfTimeframe: cfg.htfTimeframe,
                            candleType: cfg.candleType,
                            error: e.message
                        });
                    }
                }
            }

            // aggregation
            const { aggregateCompare } = require('../../services/backtest.service');
            res.json({
                count: allResults.length,
                results: allResults,
                aggregate: aggregateCompare(allResults)
            });
        } catch (e) { next(e); }
    });
}

module.exports = { register };