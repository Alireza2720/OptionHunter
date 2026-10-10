# -*- coding: utf-8 -*-
"""Coverage / gaps report — نسخه بهینه با aggregation + cache."""
import time
from datetime import datetime as _dt, timezone as _tz, timedelta as _td
from .db import get_db, COL_CANDLES_BASE, COL_CANDLES_DAILY, COL_CANDLES_TF, COL_OPTION_HISTORY, COL_MONITORED

# 🆕 cache داخلی
_cov_cache = {'result': None, 'at': 0, 'symbols_key': None}
# 🆕 R17: 30min TTL (was 10min) — full aggregations are expensive.
# Frontend gets stale data instantly + background refresh.
_COV_TTL = 1800
_COV_STALE_OK = 6 * 3600   # 6h — return stale on error/timeout


def coverage_report(symbols=None):
    """Public wrapper — returns stale cache on error/timeout."""
    try:
        return _coverage_report_inner(symbols)
    except Exception as _e:
        import time as _t
        if _cov_cache['result'] is not None and (_t.time() - _cov_cache['at']) < _COV_STALE_OK:
            try:
                from .db import log
                log('coverage_error_stale', str(_e)[:200])
            except Exception:
                pass
            return _cov_cache['result']
        raise


def _coverage_report_inner(symbols=None):
    db = get_db()
    if not symbols:
        symbols = [s['symbol'] for s in db[COL_MONITORED].find({})]

    # 🆕 cache key = symbols hash
    key = tuple(sorted(symbols))
    now = time.time()
    if (_cov_cache['result'] is not None
            and _cov_cache['symbols_key'] == key
            and (now - _cov_cache['at']) < _COV_TTL):
        return _cov_cache['result']
    if not symbols:
        symbols = [s['symbol'] for s in db[COL_MONITORED].find({})]

    # 🆕 ۴ aggregation به جای ۱۸۲ کوئری
    # 1) candles_base
    # 🆕 R17: add 2-year time filter to speed up (5.7M → ~2M records)
    _since = _dt.now(_tz.utc) - _td(days=730)
    base_agg = list(db[COL_CANDLES_BASE].aggregate([
        {'$match': {
            'source': {'$in': ['tsetmc_intraday', 'algotik_intraday']},
            'time': {'$gte': _since}
        }},
        {'$group': {
            '_id': '$symbol',
            'count': {'$sum': 1},
            'from': {'$min': '$time'},
            'to': {'$max': '$time'},
        }}
    ], maxTimeMS=15000))
    base_map = {d['_id']: d for d in base_agg}

    # 2) candles_daily
    daily_agg = list(db[COL_CANDLES_DAILY].aggregate([
        {'$group': {'_id': '$symbol', 'count': {'$sum': 1}}}
    ]))
    daily_map = {d['_id']: d['count'] for d in daily_agg}

    # 3) candles_tf (به تفکیک tf)
    tf_agg = list(db[COL_CANDLES_TF].aggregate([
        {'$group': {
            '_id': {'symbol': '$symbol', 'tf': '$tf'},
            'count': {'$sum': 1}
        }}
    ]))
    tf_map = {}
    for d in tf_agg:
        sym = d['_id']['symbol']
        tf = d['_id']['tf']
        if sym not in tf_map:
            tf_map[sym] = {}
        tf_map[sym][tf] = d['count']

    # 4) option_history
    opt_agg = list(db[COL_OPTION_HISTORY].aggregate([
        {'$group': {
            '_id': '$underlying',
            'count': {'$sum': 1},
            'with_iv': {'$sum': {'$cond': [{'$gt': ['$ivApi', 0]}, 1, 0]}},
            'from': {'$min': '$time'},
            'to': {'$max': '$time'},
        }}
    ]))
    opt_map = {d['_id']: d for d in opt_agg}

    # 5) stock_ticks (فقط برای نشان دادن — می‌تونه کند باشه)
    ticks_agg = list(db['stock_ticks'].aggregate([
        {'$group': {'_id': '$symbol', 'count': {'$sum': 1}}}
    ]))
    ticks_map = {d['_id']: d['count'] for d in ticks_agg}

    out = []
    for sym in symbols:
        b = base_map.get(sym, {})
        o = opt_map.get(sym, {})
        tf_stats = tf_map.get(sym, {})
        out.append({
            'symbol': sym,
            'stock_base': {
                'count': b.get('count', 0),
                'from': b.get('from'),
                'to': b.get('to'),
            },
            'stock_ticks': {'count': ticks_map.get(sym, 0)},
            'stock_daily': {'count': daily_map.get(sym, 0)},
            'candles_tf': {
                '15m': tf_stats.get('15m', 0),
                '30m': tf_stats.get('30m', 0),
                '1h': tf_stats.get('1h', 0),
            },
            'options': {
                'count': o.get('count', 0),
                'with_iv': o.get('with_iv', 0),
                'from': o.get('from'),
                'to': o.get('to'),
            },
        })
    _cov_cache['result'] = out
    _cov_cache['at'] = now
    _cov_cache['symbols_key'] = key
    return out