'use strict';
// ============================================================
// putcall-ratio.js — Put/Call OI ratio for regime signal
// ============================================================

let deps = { getDB: null };
function init(d) { deps = { ...deps, ...d }; }

async function computePCRatio(underlying, opts = {}) {
    const windowDays = opts.windowDays || 7;
    const minRows = opts.minRows || 10;
    if (!deps.getDB) return null;
    const db = deps.getDB();
    const since = new Date(Date.now() - windowDays * 86400 * 1000);
    try {
        const agg = await db.collection('option_history').aggregate([
            { $match: { underlying, time: { $gte: since }, oi: { $gt: 0 } } },
            { $group: {
                _id: { $cond: ['$isCall', 'call', 'put'] },
                totalOI: { $sum: '$oi' },
                count: { $sum: 1 }
            }}
        ]).toArray();
        let callOI = 0, putOI = 0, callN = 0, putN = 0;
        for (const r of agg) {
            if (r._id === 'call') { callOI = r.totalOI; callN = r.count; }
            else if (r._id === 'put') { putOI = r.totalOI; putN = r.count; }
        }
        if (callN + putN < minRows) return null;
        const ratio = callOI > 0 ? putOI / callOI : null;
        return {
            callOI, putOI, callN, putN,
            ratio: ratio != null ? Math.round(ratio * 1000) / 1000 : null,
            signal: ratio == null ? 'unknown'
                  : ratio > 1.5 ? 'bearish'
                  : ratio < 0.7 ? 'bullish'
                  : 'neutral',
            windowDays
        };
    } catch (_) {
        return null;
    }
}

module.exports = { init, computePCRatio };
