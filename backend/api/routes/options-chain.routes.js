'use strict';
// ============================================================
// options-chain.routes.js — Enriched option chain proxy
// ============================================================
// Exposes the enriched option chain (from infra/options-chain.js)
// as a single GET endpoint for OptionStrategist.
//
// Routes:
//   GET /api/options-chain             -> full chain (array)
//   GET /api/options-chain?meta=1      -> { count, data, meta }
//   GET /api/options-chain?fresh=1     -> force cache bypass
//   GET /api/options-chain?model=heston -> pricing model override
//   GET /api/options-chain/status      -> cache metadata
// ============================================================

const { CACHE_TTL } = require('../../config/constants');

function register(app, deps) {
    const { optionsChain, logger } = deps;

    if (!optionsChain) {
        console.warn('options-chain.routes: optionsChain not provided — skipping');
        return;
    }

    // ----------------------------------------------------------
    // GET /api/options-chain
    // ----------------------------------------------------------
    app.get('/api/options-chain', async (req, res, next) => {
        try {
            const fresh = req.query.fresh === '1';
            const withMeta = req.query.meta === '1';
            const model = String(req.query.model || '').toLowerCase();

            if ((model === 'heston' || model === 'bsm')
                && typeof optionsChain.setPricingModel === 'function') {
                optionsChain.setPricingModel(model);
            }

            if (fresh && typeof optionsChain.clearCache === 'function') {
                optionsChain.clearCache();
            }

            const maxAgeMs = fresh ? 0 : (CACHE_TTL.OPTION_CHAIN || 60000);

            const t0 = Date.now();
            const list = await optionsChain.fetchChain(maxAgeMs);
            const ms = Date.now() - t0;

            if (!Array.isArray(list)) {
                throw new Error('options-chain returned non-array');
            }

            const clean = list.filter(c => c && c.symbol && c.strike > 0);

            if (withMeta) {
                return res.json({
                    count: clean.length,
                    data: clean,
                    meta: {
                        count: clean.length,
                        fetchMs: ms,
                        fresh: fresh,
                        pricingModel: (model === 'heston') ? 'heston' : 'bsm',
                        at: new Date().toISOString(),
                        source: 'OptionHunter/api/options-chain',
                        chainAge: (typeof optionsChain.chainAge === 'function')
                            ? optionsChain.chainAge()
                            : null,
                    }
                });
            }

            res.json(clean);
        } catch (e) {
            if (logger) logger.warn('[options-chain] ' + e.message);
            next(e);
        }
    });

    // ----------------------------------------------------------
    // GET /api/options-chain/status
    // ----------------------------------------------------------
    app.get('/api/options-chain/status', (req, res) => {
        try {
            const meta = (typeof optionsChain.getMeta === 'function')
                ? optionsChain.getMeta()
                : null;
            const age = (typeof optionsChain.chainAge === 'function')
                ? optionsChain.chainAge()
                : null;
            res.json({ ready: !!meta, ageSec: age, meta: meta });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    if (logger) logger.info('[options-chain] routes registered');
}

module.exports = { register };