'use strict';
// ============================================================
// config.service.js — مدیریت strategy_configs
// ============================================================
// - CRUD + bulk operations
// - Validations
// - Auto-disable / rolling performance
// ============================================================

const { ObjectId } = require('mongodb');
const { COLLECTIONS, TIMEFRAME_MINUTES, TRADING_DAYS_PER_YEAR } = require('../config/constants');

let deps = {
    getDB: null,
    strategies: null,
    settings: null,
    backtest: null,
    logger: null
};

function init(d) { deps = { ...deps, ...d }; }

// ============================================================
// Read
// ============================================================
async function list() {
    return deps.getDB().collection(COLLECTIONS.STRATEGY_CONFIGS)
        .find({}).sort({ createdAt: 1 }).toArray();
}

async function getById(id) {
    return deps.getDB().collection(COLLECTIONS.STRATEGY_CONFIGS)
        .findOne({ _id: new ObjectId(id) });
}

async function listEnabled() {
    return deps.getDB().collection(COLLECTIONS.STRATEGY_CONFIGS)
        .find({ enabled: true }).toArray();
}

async function countEnabled() {
    return deps.getDB().collection(COLLECTIONS.STRATEGY_CONFIGS)
        .countDocuments({ enabled: true });
}

async function countAll() {
    return deps.getDB().collection(COLLECTIONS.STRATEGY_CONFIGS)
        .countDocuments({});
}

// ============================================================
// Write
// ============================================================
async function create(input) {
    const STRATEGIES = deps.strategies.STRATEGIES;
    const { symbol, strategyId, timeframe, htfTimeframe, candleType, params, enabled, role } = input;

    if (!symbol || !STRATEGIES[strategyId]) {
        throw Object.assign(new Error('نماد یا استراتژی نامعتبر'), { status: 400 });
    }
    if (!TIMEFRAME_MINUTES[timeframe]) {
        throw Object.assign(new Error('تایم فریم نامعتبر'), { status: 400 });
    }
    const htf = htfTimeframe || STRATEGIES[strategyId].htfTimeframe || '1d';
    if (!TIMEFRAME_MINUTES[htf] || TIMEFRAME_MINUTES[htf] <= TIMEFRAME_MINUTES[timeframe]) {
        throw Object.assign(new Error('تایم فریم بالا باید بزرگتر باشد'), { status: 400 });
    }

    const db = deps.getDB();
    const monitored = await db.collection(COLLECTIONS.MONITORED_SYMBOLS).findOne({ symbol });
    if (!monitored) {
        throw Object.assign(new Error('ابتدا نماد را اضافه کنید.'), { status: 400 });
    }

    const overrides = deps.settings.getStrategyDefaults(strategyId);
    const defaultParams = {
        ...STRATEGIES[strategyId].defaultParams,
        ...overrides,
        ...(params || {})
    };

    const doc = {
        symbol,
        strategyId,
        timeframe,
        htfTimeframe: htf,
        candleType: candleType === 'simple' ? 'simple' : 'heikin',
        params: defaultParams,
        enabled: enabled !== false,
        role: role === 'confirmer' ? 'confirmer' : 'leader',
        createdAt: new Date()
    };

    const r = await db.collection(COLLECTIONS.STRATEGY_CONFIGS).insertOne(doc);
    return { _id: r.insertedId, ...doc };
}

async function update(id, upd) {
    const clean = {};
    if (upd.params !== undefined) clean.params = upd.params;
    if (upd.enabled !== undefined) clean.enabled = upd.enabled;
    if (upd.role === 'leader' || upd.role === 'confirmer') clean.role = upd.role;

    if (!Object.keys(clean).length) {
        throw Object.assign(new Error('فیلدی مشخص نشد'), { status: 400 });
    }

    await deps.getDB().collection(COLLECTIONS.STRATEGY_CONFIGS)
        .updateOne({ _id: new ObjectId(id) }, { $set: clean });

    if (clean.params) {
        await deps.backtest.invalidateCacheForConfig(id).catch(() => {});
    }

    return { success: true };
}

async function remove(id) {
    const db = deps.getDB();
    await db.collection(COLLECTIONS.STRATEGY_CONFIGS).deleteOne({ _id: new ObjectId(id) });
    await db.collection(COLLECTIONS.SIGNALS_STATE).deleteOne({ configId: String(id) });
    await deps.backtest.invalidateCacheForConfig(id).catch(() => {});
    return { success: true };
}

async function bulkUpdate(ids, patch) {
    if (!Array.isArray(ids) || !ids.length) {
        throw Object.assign(new Error('لیست خالی است'), { status: 400 });
    }
    const upd = {};
    if (typeof patch.enabled === 'boolean') upd.enabled = patch.enabled;
    if (patch.role === 'leader' || patch.role === 'confirmer') upd.role = patch.role;
    if (!Object.keys(upd).length) {
        throw Object.assign(new Error('فیلدی مشخص نشد'), { status: 400 });
    }

    const objectIds = ids.map(id => new ObjectId(id));
    const r = await deps.getDB().collection(COLLECTIONS.STRATEGY_CONFIGS)
        .updateMany({ _id: { $in: objectIds } }, { $set: upd });
    return { success: true, updated: r.modifiedCount };
}

async function bulkDelete(ids) {
    if (!Array.isArray(ids) || !ids.length) {
        throw Object.assign(new Error('لیست خالی است'), { status: 400 });
    }
    const db = deps.getDB();
    const objectIds = ids.map(id => new ObjectId(id));
    const del = await db.collection(COLLECTIONS.STRATEGY_CONFIGS)
        .deleteMany({ _id: { $in: objectIds } });
    await db.collection(COLLECTIONS.SIGNALS_STATE)
        .deleteMany({ configId: { $in: ids } });
    return { success: true, deleted: del.deletedCount };
}

// ============================================================
// Cleanup orphans
// ============================================================
async function cleanOrphans() {
    const db = deps.getDB();
    const validIds = Object.keys(deps.strategies.STRATEGIES);
    const orphans = await db.collection(COLLECTIONS.STRATEGY_CONFIGS)
        .find({ strategyId: { $nin: validIds } }).toArray();

    if (!orphans.length) return 0;

    const orphanIds = orphans.map(o => o._id);
    await db.collection(COLLECTIONS.STRATEGY_CONFIGS).deleteMany({ _id: { $in: orphanIds } });
    await db.collection(COLLECTIONS.SIGNALS_STATE).deleteMany({
        configId: { $in: orphanIds.map(id => String(id)) }
    });
    return orphans.length;
}

// ============================================================
// Rolling performance — auto-disable بد
// ============================================================
async function rollingPerformance(daysBack = 30) {
    const db = deps.getDB();
    const since = new Date(Date.now() - daysBack * 86400 * 1000);
    const configs = await db.collection(COLLECTIONS.STRATEGY_CONFIGS).find({}).toArray();

    const results = [];

    for (const cfg of configs) {
        const positions = await db.collection(COLLECTIONS.OPTION_POSITIONS).find({
            configId: String(cfg._id),
            status: 'closed',
            exitTime: { $gte: since }
        }).toArray();

        if (positions.length < 3) {
            results.push({ configId: cfg._id, sample: positions.length, status: 'insufficient' });
            continue;
        }

        const wins = positions.filter(p => p.pnlPct > 0);
        const losses = positions.filter(p => p.pnlPct <= 0);
        const sum = arr => arr.reduce((s, x) => s + x.pnlPct, 0);
        const gp = sum(wins);
        const gl = -sum(losses);
        const pf = gl > 0 ? gp / gl : (gp > 0 ? 99 : 0);

        const action =
            pf < 0.8 && positions.length >= 5 ? 'disable' :
            pf > 1.5 && positions.length >= 10 ? 'promote' :
            'keep';

        results.push({
            configId: cfg._id,
            symbol: cfg.symbol,
            strategyId: cfg.strategyId,
            sample: positions.length,
            winRate: wins.length / positions.length * 100,
            profitFactor: pf,
            action,
            status: 'computed'
        });
    }

    return results;
}

module.exports = {
    init,
    list, getById, listEnabled, countEnabled, countAll,
    create, update, remove,
    bulkUpdate, bulkDelete,
    cleanOrphans, rollingPerformance
};