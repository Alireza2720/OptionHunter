'use strict';
// ============================================================
// regime.service.js — orchestrate + cache رژیم
// ============================================================

const { COLLECTIONS } = require('../config/constants');
const regimeCore = require('../core/regime');

let deps = { getDB: null, logger: null };
function init(d) { deps = { ...deps, ...d }; }

async function detectForSymbol(symbol) {
    const db = deps.getDB();
    const candles = await db.collection(COLLECTIONS.CANDLES_DAILY)
        .find({ symbol }).sort({ time: 1 }).toArray();

    if (!candles || candles.length < 50) {
        return { symbol, macro: 'unknown', vol: 'unknown', reason: `دیتای روزانه کم (${candles?.length || 0})` };
    }

    const normalized = candles.map(c => ({
        time: Math.floor(new Date(c.time).getTime() / 1000),
        open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0
    }));

    const macro = regimeCore.detectMacroRegime(normalized);
    const vol = regimeCore.detectVolatilityState(normalized);

    return {
        symbol,
        macro: macro.regime,
        macroReason: macro.reason,
        macroSlopePct: macro.slopePct ?? null,
        vol: vol.state,
        volRatio: vol.ratio ?? null,
        close: macro.close,
        ema200: macro.ema,
        computedAt: new Date()
    };
}

async function refreshAll() {
    const db = deps.getDB();
    const monitored = await db.collection(COLLECTIONS.MONITORED_SYMBOLS).find({}).toArray();
    const results = [];

    for (const m of monitored) {
        try {
            const r = await detectForSymbol(m.symbol);
            results.push(r);
            await db.collection(COLLECTIONS.META).updateOne(
                { _id: `regime_${m.symbol}` },
                { $set: r },
                { upsert: true }
            );
        } catch (e) {
            deps.logger && deps.logger.warn(`regime ${m.symbol}: ${e.message}`);
        }
    }

    deps.logger && deps.logger.info(`regime refresh: ${results.length} symbols`);
    return results;
}

async function getForSymbol(symbol) {
    return deps.getDB().collection(COLLECTIONS.META).findOne({ _id: `regime_${symbol}` });
}

async function getAllCached() {
    const docs = await deps.getDB().collection(COLLECTIONS.META)
        .find({ _id: { $regex: '^regime_' } }).toArray();
    return docs.map(d => ({ ...d, symbol: d._id.replace('regime_', '') }));
}

async function getRegimeMap() {
    const all = await getAllCached();
    const map = {};
    for (const r of all) {
        map[r.symbol] = { macro: r.macro, vol: r.vol };
    }
    return map;
}

module.exports = { init, detectForSymbol, refreshAll, getForSymbol, getAllCached, getRegimeMap };