'use strict';
// ============================================================
// enhancements.js — load ClientType + PutCall for Pro strategies
// ============================================================
// Called by backtest engine when strategy is Pro.
// Loads:
//   - clientTypeByDate: Map<dateStr, row>
//   - putCallSignal:    'bullish' | 'neutral' | 'bearish' | null
// ============================================================

async function loadEnhancements(db, symbol, fromTs, toTs) {
    const out = {
        clientTypeByDate: new Map(),
        putCallSignal: null,
        clientCount: 0,
    };
    if (!db || !symbol) return out;

    // Date range filter (Gregorian YYYY-MM-DD)
    const q = { underlying: symbol };
    if (fromTs || toTs) {
        q.date = {};
        if (fromTs) q.date.$gte = new Date(fromTs * 1000).toISOString().slice(0, 10);
        if (toTs) q.date.$lte = new Date(toTs * 1000).toISOString().slice(0, 10);
    }

    try {
        const rows = await db.collection('option_client_type')
            .find(q)
            .project({ date: 1, buy_I_Volume: 1, buy_N_Volume: 1,
                       sell_I_Volume: 1, sell_N_Volume: 1 })
            .toArray();
        for (const r of rows) {
            if (r.date) out.clientTypeByDate.set(r.date, r);
        }
        out.clientCount = rows.length;
    } catch (_) {}

    // PutCall (7d)
    try {
        const pcCore = require('./putcall-ratio');
        pcCore.init({ getDB: () => db });
        const pc = await pcCore.computePCRatio(symbol, { windowDays: 7 });
        if (pc && pc.signal) out.putCallSignal = pc.signal;
    } catch (_) {}

    return out;
}

module.exports = { loadEnhancements };
