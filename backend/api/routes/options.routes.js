'use strict';
// ============================================================
// options.routes.js — chain، settings، positions، recommend
// ============================================================

const { ObjectId } = require('mongodb');
const { COLLECTIONS } = require('../../config/constants');

function register(app, deps) {
    const { getDB, options, optionsChain, configService, signalService } = deps;

    // ---- Settings ----
    app.get('/api/options/settings', async (req, res, next) => {
        try {
            const s = await options.getSettings();
            res.json({
                values: s,
                defaults: options.DEFAULT_SETTINGS,
                fees: { 
                    buy: options.getFeeBuy(), 
                    sell: options.getFeeSell() 
                },
                riskFree: options.getRiskFree()
            });
        } catch (e) { next(e); }
    });

    app.put('/api/options/settings', async (req, res, next) => {
        try {
            res.json(await options.saveSettings(req.body || {}));
        } catch (e) { next(e); }
    });

    // ---- Chain ----
    app.get('/api/options/chain/:underlying', async (req, res, next) => {
        try {
            const chain = await optionsChain.fetchChain(60000);
            const names = deps.getUnderlyingNames
                ? deps.getUnderlyingNames(req.params.underlying)
                : [options.norm(req.params.underlying)];

            const matched = chain.filter(c =>
                c.isCall && options.matchUnderlying(c.underlying, names)
            );

            if (req.query.raw === '1') {
                return res.json({
                    underlying: req.params.underlying,
                    matchedNames: names,
                    totalMatched: matched.length,
                    raw: matched
                });
            }

            const s = await options.getSettings();
            const hv = await options.hvFromDaily(req.params.underlying);

            const rows = matched.map(c => {
                const m = options.metrics(c, c.S, hv);
                return { ...c, ...m, reject: options.rejectReasons(c, m, s) };
            }).sort((a, b) => {
                const e = a.expiry.localeCompare(b.expiry);
                return e !== 0 ? e : a.strike - b.strike;
            });

            res.json({
                underlying: req.params.underlying,
                matchedNames: names,
                S: rows[0] ? rows[0].S : null,
                hv,
                chainAgeSec: optionsChain.chainAge(),
                rows
            });
        } catch (e) { next(e); }
    });

    // ---- Underlyings ----
    app.get('/api/options/underlyings', async (req, res, next) => {
        try {
            const chain = await optionsChain.fetchChain(60000);
            const map = new Map();
            chain.filter(c => c.isCall).forEach(c => {
                map.set(c.underlying, (map.get(c.underlying) || 0) + 1);
            });
            const list = Array.from(map.entries()).map(([underlying, contracts]) => ({
                underlying, contracts
            })).sort((a, b) => a.underlying.localeCompare(b.underlying));
            res.json({ count: list.length, underlyings: list });
        } catch (e) { next(e); }
    });

    // ---- Recommend ----
    app.get('/api/options/recommend/:configId', async (req, res, next) => {
        try {
            const cfg = await configService.getById(req.params.configId);
            if (!cfg) return res.status(404).json({ error: 'تنظیم یافت نشد' });

            const state = await getDB().collection(COLLECTIONS.SIGNALS_STATE)
                .findOne({ configId: req.params.configId });
            if (!state || !state.price) {
                return res.status(400).json({ error: 'هنوز وضعیتی محاسبه نشده' });
            }
            res.json(await options.recommendForState(cfg, state));
        } catch (e) { next(e); }
    });

    // ---- Positions ----
    app.get('/api/options/positions', async (req, res, next) => {
        try {
            const list = await getDB().collection(COLLECTIONS.OPTION_POSITIONS)
                .find({}).sort({ entryTime: -1 }).limit(300).toArray();
            res.json({
                positions: list,
                stats: options.positionStats(list)
            });
        } catch (e) { next(e); }
    });

    app.delete('/api/options/positions/:id', async (req, res, next) => {
        try {
            await getDB().collection(COLLECTIONS.OPTION_POSITIONS)
                .deleteOne({ _id: new ObjectId(req.params.id) });
            res.json({ success: true });
        } catch (e) { next(e); }
    });

    // ---- Storage ----
    app.get('/api/storage', async (req, res, next) => {
        try {
            const db = getDB();
            const st = await db.stats();
            res.json({
                dataMB: +(st.dataSize / 1048576).toFixed(1),
                storageMB: +((st.storageSize + st.indexSize) / 1048576).toFixed(1),
                collections: st.collections,
                objects: st.objects
            });
        } catch (e) { next(e); }
    });
}

module.exports = { register };