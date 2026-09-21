# -*- coding: utf-8 -*-
"""Coverage / gaps report."""
from .db import get_db, COL_CANDLES_BASE, COL_CANDLES_DAILY, COL_CANDLES_TF, COL_OPTION_HISTORY, COL_MONITORED

def coverage_report(symbols=None):
    db = get_db()
    if not symbols:
        symbols = [s['symbol'] for s in db[COL_MONITORED].find({})]

    out = []
    for sym in symbols:
        base_count = db[COL_CANDLES_BASE].count_documents(
            {'symbol': sym, 'source': 'algotik_intraday'})
        b_min_doc = next(iter(db[COL_CANDLES_BASE].find(
            {'symbol': sym, 'source': 'algotik_intraday'}).sort('time', 1).limit(1)), None)
        b_max_doc = next(iter(db[COL_CANDLES_BASE].find(
            {'symbol': sym, 'source': 'algotik_intraday'}).sort('time', -1).limit(1)), None)

        daily_count = db[COL_CANDLES_DAILY].count_documents({'symbol': sym})

        tf_stats = {}
        for tf in ['15m', '30m', '1h']:
            tf_stats[tf] = db[COL_CANDLES_TF].count_documents({'symbol': sym, 'tf': tf})

        opt_count = db[COL_OPTION_HISTORY].count_documents({'underlying': sym})
        opt_with_iv = db[COL_OPTION_HISTORY].count_documents(
            {'underlying': sym, 'ivApi': {'$gt': 0}})
        o_min_doc = next(iter(db[COL_OPTION_HISTORY].find(
            {'underlying': sym}).sort('time', 1).limit(1)), None)
        o_max_doc = next(iter(db[COL_OPTION_HISTORY].find(
            {'underlying': sym}).sort('time', -1).limit(1)), None)
        stock_ticks = db['stock_ticks'].count_documents({'symbol': sym})
        out.append({
            'symbol': sym,
            'stock_base': {
                'count': base_count,
                'from': b_min_doc['time'] if b_min_doc else None,
                'to': b_max_doc['time'] if b_max_doc else None,
            },
            'stock_ticks': {'count': stock_ticks},
            'stock_daily': {'count': daily_count},
            'candles_tf': tf_stats,
            'options': {
                'count': opt_count,
                'with_iv': opt_with_iv,
                'from': o_min_doc['time'] if o_min_doc else None,
                'to': o_max_doc['time'] if o_max_doc else None,
            },
        })
    return out