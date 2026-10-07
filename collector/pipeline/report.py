# -*- coding: utf-8 -*-
"""Coverage / gaps report — نسخه بهینه با aggregation + cache."""
import time
from .db import get_db, COL_CANDLES_BASE, COL_CANDLES_DAILY, COL_CANDLES_TF, COL_OPTION_HISTORY, COL_MONITORED

# 🆕 cache داخلی
_cov_cache = {'result': None, 'at': 0, 'symbols_key': None}
# 10min TTL (was 3min) — frontend polls every 60s, so this reduces
# full aggregations from ~20/hour to ~6/hour on the 1-core server.
_COV_TTL = 600


def coverage_report(symbols=None):
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
    base_agg = list(db[COL_CANDLES_BASE].aggregate([
        {'$match': {'source': {'$in': ['tsetmc_intraday', 'algotik_intraday']}}},
        {'$group': {
            '_id': '$symbol',
            'count': {'$sum': 1},
            'from': {'$min': '$time'},
            'to': {'$max': '$time'},
        }}
    ]))
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