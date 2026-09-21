# -*- coding: utf-8 -*-
from datetime import datetime, timezone
from .db import get_db, COL_MONITORED


def list_symbols(only_enabled=False):
    db = get_db()
    if only_enabled:
        # هم‌راست با backend — هر دو فیلد رو چک کن
        q = {'$or': [{'enabled': True}, {'collectEnabled': True}]}
    else:
        q = {}
    return list(db[COL_MONITORED].find(q).sort('symbol', 1))


def get_enabled_names():
    return [s['symbol'] for s in list_symbols(only_enabled=True)]


def add_symbol(symbol, name=None):
    db = get_db()
    doc = {
        'symbol': symbol,
        'name': name or symbol,
        'enabled': True,
        'collectEnabled': True,
        'addedAt': datetime.now(timezone.utc),
    }
    db[COL_MONITORED].update_one(
        {'symbol': symbol},
        {'$setOnInsert': doc},
        upsert=True
    )
    return list_symbols()


def remove_symbol(symbol):
    db = get_db()
    r = db[COL_MONITORED].delete_one({'symbol': symbol})
    return r.deleted_count > 0


def set_enabled(symbol, enabled):
    db = get_db()
    r = db[COL_MONITORED].update_one(
        {'symbol': symbol},
        {'$set': {'enabled': bool(enabled),
                  'collectEnabled': bool(enabled)}}
    )
    return r.modified_count > 0