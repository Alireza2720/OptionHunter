# -*- coding: utf-8 -*-
"""Re-aggregate TF candles from candles_base (only algotik_intraday source)."""
from datetime import datetime, timezone, timedelta
from pymongo import UpdateOne
from .db import get_db, COL_CANDLES_BASE, COL_CANDLES_TF

TF_MINUTES = {'15m': 15, '30m': 30, '1h': 60}

def _tehran_parts(dt):
    """Return (year, month, day, hour, minute) in Tehran time."""
    # Tehran = UTC+3:30
    from datetime import timedelta
    t = dt + timedelta(hours=3, minutes=30)
    return t.year, t.month, t.day, t.hour, t.minute

def aggregate_symbol(symbol, tf, candles):
    """Aggregate sorted 1m candles → tf candles."""
    tf_min = TF_MINUTES[tf]
    buckets = {}
    for c in candles:
        y, mo, d, h, mi = _tehran_parts(c['time'])
        bucket_min = (h * 60 + mi) // tf_min * tf_min
        key = (y, mo, d, bucket_min)
        if key not in buckets:
            buckets[key] = {
                'open': c['open'], 'high': c['high'],
                'low': c['low'], 'close': c['close'],
                'volume': c.get('volume', 0) or 0,
                'barCount': 1,
                'time': None,
            }
        else:
            b = buckets[key]
            b['high'] = max(b['high'], c['high'])
            b['low'] = min(b['low'], c['low'])
            b['close'] = c['close']
            b['volume'] += c.get('volume', 0) or 0
            b['barCount'] += 1

    out = []
    for (y, mo, d, bmin), b in buckets.items():
        bh, bmi = bmin // 60, bmin % 60
        local = datetime(y, mo, d, bh, bmi, 0)
        utc = local - timedelta(hours=3, minutes=30)
        b['time'] = utc.replace(tzinfo=timezone.utc)
        b['symbol'] = symbol
        b['tf'] = tf
        b['source'] = 'reaggregated'
        b['updatedAt'] = datetime.now(timezone.utc)
        out.append(b)
    return out

def rebuild_symbol(symbol):
    """Rebuild all TF for a symbol from its base candles."""
    db = get_db()
    base = list(db[COL_CANDLES_BASE].find(
        {'symbol': symbol, 'source': 'algotik_intraday'}
    ).sort('time', 1))

    if not base:
        return {'symbol': symbol, 'written': 0, 'base_count': 0}

    # delete old TF for this symbol
    db[COL_CANDLES_TF].delete_many({'symbol': symbol})

    total = 0
    for tf in TF_MINUTES:
        agg = aggregate_symbol(symbol, tf, base)
        if not agg:
            continue
        ops = [UpdateOne(
            {'symbol': symbol, 'tf': tf, 'time': b['time']},
            {'$set': b}, upsert=True
        ) for b in agg]
        db[COL_CANDLES_TF].bulk_write(ops, ordered=False)
        total += len(agg)

    return {'symbol': symbol, 'written': total, 'base_count': len(base)}