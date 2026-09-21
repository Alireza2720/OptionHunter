# -*- coding: utf-8 -*-
"""MongoDB connection + collection constants + env loader."""
import os
from pymongo import MongoClient, ASCENDING, DESCENDING

def load_env():
    for path in ['/home/deploy/apps/OptionHunter/.env', '../.env', '.env']:
        try:
            if os.path.exists(path):
                for line in open(path, encoding='utf-8'):
                    line = line.strip()
                    if not line or line.startswith('#') or '=' not in line:
                        continue
                    k, v = line.split('=', 1)
                    k, v = k.strip(), v.strip()
                    if len(v) >= 2 and v[0] == v[-1] and v[0] in ("'", '"'):
                        v = v[1:-1]
                    if k and k not in os.environ:
                        os.environ[k] = v
                return
        except Exception:
            pass

load_env()

MONGO_URI = os.getenv('MONGO_URI')
MONGO_DB = os.getenv('MONGO_DB', 'trading_bot')

_client = None
_db = None

def get_db():
    global _client, _db
    if _db is None:
        _client = MongoClient(MONGO_URI)
        _db = _client[MONGO_DB]
    return _db

# Collections
COL_CANDLES_BASE = 'candles_base'
COL_CANDLES_DAILY = 'candles_daily'
COL_CANDLES_TF = 'candles_tf'
COL_OPTION_HISTORY = 'option_history'
COL_OPTION_SNAPSHOTS = 'option_snapshots'
COL_STOCK_TICKS = 'stock_ticks'
COL_MONITORED = 'monitored_symbols'
COL_JOBS = 'backfill_jobs'
COL_RISK_FREE = 'risk_free_cache'
COL_LOG = 'collector_log'
COL_META = 'meta'

def ensure_indexes():
    db = get_db()
    db[COL_CANDLES_BASE].create_index([('symbol', ASCENDING), ('time', ASCENDING)])
    db[COL_CANDLES_DAILY].create_index([('symbol', ASCENDING), ('time', ASCENDING)])
    db[COL_CANDLES_TF].create_index([('symbol', ASCENDING), ('tf', ASCENDING), ('time', ASCENDING)])
    db[COL_OPTION_HISTORY].create_index([('symbol', ASCENDING), ('time', ASCENDING)])
    db[COL_OPTION_HISTORY].create_index([('underlying', ASCENDING), ('time', ASCENDING)])
    db[COL_OPTION_SNAPSHOTS].create_index([('underlying', ASCENDING), ('timestamp', DESCENDING)])
    db[COL_STOCK_TICKS].create_index([('symbol', ASCENDING), ('time', DESCENDING)])
    db[COL_MONITORED].create_index([('symbol', ASCENDING)], unique=True)
    db[COL_JOBS].create_index([('status', ASCENDING), ('created_at', DESCENDING)])
    db[COL_LOG].create_index([('at', DESCENDING)])

def log(kind, message, extra=None):
    try:
        from datetime import datetime, timezone
        doc = {'kind': kind, 'message': message, 'at': datetime.now(timezone.utc)}
        if extra:
            doc.update(extra)
        get_db()[COL_LOG].insert_one(doc)
    except Exception:
        pass