'use strict';
// ============================================================
// clienttype.js — helper for option_client_type collection
// ============================================================
// Provides:
//   - getClientTypeAt(underlying, dateStr) → row or null
//   - computeLegalBuyRatio(row) → float 0..1 or null
//   - flowScore(row) → -0.15 .. +0.15 (soft signal bonus)
// ============================================================

let deps = { getDB: null };
function init(d) { deps = { ...deps, ...d }; }

async function getClientTypeAt(underlying, dateStr) {
    if (!deps.getDB || !underlying || !dateStr) return null;
    try {
        const db = deps.getDB();
        return await db.collection('option_client_type').findOne({
            underlying,
            date: dateStr
        });
    } catch (_) {
        return null;
    }
}

function computeLegalBuyRatio(row) {
    if (!row) return null;
    const buyI = Number(row.buy_I_Volume) || 0;
    const buyN = Number(row.buy_N_Volume) || 0;
    const total = buyI + buyN;
    if (total <= 0) return null;
    return buyI / total;
}

function flowScore(row) {
    const r = computeLegalBuyRatio(row);
    if (r == null) return 0;
    if (r > 0.75) return +0.15;
    if (r > 0.65) return +0.10;
    if (r < 0.30) return -0.15;
    if (r < 0.40) return -0.08;
    return 0;
}

module.exports = { init, getClientTypeAt, computeLegalBuyRatio, flowScore };
