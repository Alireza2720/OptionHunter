# -*- coding: utf-8 -*-
"""MongoDB connection + collection constants + env loader.

این ماژول با backend/mongo.js هم‌راسته:
- ایندکس‌های candles_* با unique=True ساخته می‌شن
- اگر ایندکسی از قبل با اسم یکسان ولی spec متفاوت وجود داشته باشه،
  به‌جای crash، skip می‌شه (idempotent)
"""
import os
from pymongo import MongoClient, ASCENDING, DESCENDING
from pymongo.errors import OperationFailure


def load_env():
    for path in ['/home/deploy/apps/OptionHunter/.env', '../.env', '.env',
                 '/opt/collector/.env']:
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
        _client = MongoClient(
            MONGO_URI,
            serverSelectionTimeoutMS=5000,
            maxPoolSize=10,
        )
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


# ----------------------------------------------------------------
# Idempotent index helper
# ----------------------------------------------------------------
_TOLERATED_INDEX_ERRORS = (
    'IndexKeySpecsConflict',
    'IndexOptionsConflict',
    'IndexAlreadyExists',
    'already exists',
)


def _ensure_index(collection, keys, *, unique=False, name=None):
    """ایندکس رو با تحمل خطا بساز.

    اگر ایندکسی با همین اسم ولی spec متفاوت وجود داشته باشه (کلاژن backend),
    به‌جای crash فقط skip می‌شه.
    """
    try:
        collection.create_index(keys, unique=unique, name=name)
        return True
    except OperationFailure as e:
        msg = str(e)
        if any(t in msg for t in _TOLERATED_INDEX_ERRORS):
            log('index_skip',
                f'index exists with different spec: keys={keys} unique={unique}')
            return False
        raise


# ----------------------------------------------------------------
# Index setup — هم‌راست با backend/mongo.js
# ----------------------------------------------------------------
def ensure_indexes():
    db = get_db()

    # ---- candles_base ----
    _ensure_index(db[COL_CANDLES_BASE], [('time', ASCENDING)])
    _ensure_index(db[COL_CANDLES_BASE],
                  [('symbol', ASCENDING), ('time', ASCENDING)],
                  unique=True)
    _ensure_index(db[COL_CANDLES_BASE], [('source', ASCENDING)])

    # ---- candles_daily ----
    _ensure_index(db[COL_CANDLES_DAILY],
                  [('symbol', ASCENDING), ('time', ASCENDING)],
                  unique=True)

    # ---- candles_tf ----
    _ensure_index(db[COL_CANDLES_TF],
                  [('symbol', ASCENDING), ('tf', ASCENDING), ('time', ASCENDING)],
                  unique=True)

    # ---- option_history ----
    _ensure_index(db[COL_OPTION_HISTORY],
                  [('symbol', ASCENDING), ('time', ASCENDING)])
    _ensure_index(db[COL_OPTION_HISTORY],
                  [('underlying', ASCENDING), ('time', ASCENDING)])
    _ensure_index(db[COL_OPTION_HISTORY], [('time', ASCENDING)])

    # ---- option_snapshots ----
    _ensure_index(db[COL_OPTION_SNAPSHOTS],
                  [('underlying', ASCENDING), ('timestamp', DESCENDING)])

    # ---- stock_ticks ----
    _ensure_index(db[COL_STOCK_TICKS],
                  [('symbol', ASCENDING), ('time', DESCENDING)])

    # ---- monitored_symbols ----
    _ensure_index(db[COL_MONITORED], [('symbol', ASCENDING)], unique=True)

    # ---- backfill_jobs ----
    _ensure_index(db[COL_JOBS],
                  [('status', ASCENDING), ('created_at', DESCENDING)])

    # ---- collector_log ----
    _ensure_index(db[COL_LOG], [('at', DESCENDING)])

    # ---- risk_free_cache ----
    _ensure_index(db[COL_RISK_FREE], [('date', DESCENDING)])


# ----------------------------------------------------------------
# Legacy cleanup (اختیاری)
# ----------------------------------------------------------------
def cleanup_legacy_indexes():
    """ایندکس‌های قدیمی که با backend ناسازگارن رو حذف کن."""
    db = get_db()
    conflicts = {
        COL_OPTION_HISTORY: [
            'symbol_1_time_-1',
            'underlying_1_time_-1',
            'time_-1',
        ],
    }
    for col_name, names in conflicts.items():
        col = db[col_name]
        existing = {i['name'] for i in col.list_indexes()}
        for name in names:
            if name in existing:
                try:
                    col.drop_index(name)
                    log('index_drop', f'{col_name} :: {name}')
                except Exception:
                    pass


# ----------------------------------------------------------------
# Logging helper
# ----------------------------------------------------------------
def log(kind, message, extra=None):
    try:
        from datetime import datetime, timezone
        doc = {'kind': kind, 'message': message,
               'at': datetime.now(timezone.utc)}
        if extra:
            doc.update(extra)
        get_db()[COL_LOG].insert_one(doc)
    except Exception:
        pass