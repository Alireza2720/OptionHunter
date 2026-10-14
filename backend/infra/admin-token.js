'use strict';
// ============================================================
// admin-token.js - runtime admin token with DB persistence
// ============================================================
// Source of truth: meta.admin_token in DB.
// Falls back to env.ADMIN_TOKEN on first boot only.

let _value = '';
let _getDB = null;

async function init(getDBFn, envFallback) {
    _getDB = getDBFn;
    try {
        const db = _getDB();
        const doc = await db.collection('meta').findOne({ _id: 'admin_token' });
        if (doc && typeof doc.value === 'string') {
            _value = doc.value;
            return _value;
        }
        if (envFallback) {
            _value = String(envFallback);
            await db.collection('meta').updateOne(
                { _id: 'admin_token' },
                { $set: { value: _value, updatedAt: new Date(), bootstrappedFrom: 'env' } },
                { upsert: true }
            );
        }
    } catch (e) {
        if (envFallback) _value = String(envFallback);
    }
    return _value;
}

function get() { return _value; }

async function set(newValue) {
    const v = String(newValue == null ? '' : newValue);
    _value = v;
    if (!_getDB) return false;
    try {
        const db = _getDB();
        await db.collection('meta').updateOne(
            { _id: 'admin_token' },
            { $set: { value: v, updatedAt: new Date() } },
            { upsert: true }
        );
        return true;
    } catch (e) {
        return false;
    }
}

function isSet() { return !!_value; }

module.exports = { init, get, set, isSet };
