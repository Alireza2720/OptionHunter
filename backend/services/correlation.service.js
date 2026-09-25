'use strict';
// ============================================================
// correlation.service.js — سرویس محاسبه ماتریس همبستگی
// ============================================================

const { COLLECTIONS } = require('../config/constants');
const { computeMatrixFromSeries, findClusters } = require('../core/correlation');

let deps = { getDB: null, logger: null };
function init(d) { deps = { ...deps, ...d }; }

async function computeAndStore(days = 30) {
    const db = deps.getDB();
    const monitored = await db.collection(COLLECTIONS.MONITORED_SYMBOLS).find({}).toArray();
    const symbols = monitored.map(m => m.symbol);

    const cutoff = new Date(Date.now() - days * 86400 * 1000);
    const seriesBySymbol = {};

    for (const sym of symbols) {
        const candles = await db.collection(COLLECTIONS.CANDLES_DAILY)
            .find({ symbol: sym, time: { $gte: cutoff } })
            .sort({ time: 1 })
            .toArray();
        const map = new Map();
        for (const c of candles) {
            const key = new Date(c.time).toISOString().slice(0, 10);
            if (c.close > 0) map.set(key, c.close);
        }
        if (map.size >= 10) seriesBySymbol[sym] = map;
    }

    const matrix = computeMatrixFromSeries(seriesBySymbol, 10);
    const clusters = findClusters(matrix, 0.7);

    await db.collection(COLLECTIONS.META).updateOne(
        { _id: 'correlation_matrix' },
        { $set: {
            matrix,
            symbols: Object.keys(seriesBySymbol),
            clusters,
            computedAt: new Date(),
            days,
            sampleCount: Object.keys(seriesBySymbol).length
        }},
        { upsert: true }
    );

    deps.logger && deps.logger.info(
        `correlation matrix: ${Object.keys(seriesBySymbol).length} symbols, ${clusters.length} clusters`
    );

    return {
        symbols: Object.keys(seriesBySymbol).length,
        clusters: clusters.length,
        clusterList: clusters,
        computedAt: new Date()
    };
}

async function getCached() {
    const db = deps.getDB();
    const doc = await db.collection(COLLECTIONS.META).findOne({ _id: 'correlation_matrix' });
    return doc || null;
}

module.exports = { init, computeAndStore, getCached };