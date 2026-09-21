# -*- coding: utf-8 -*-
"""Stock data: intraday 1m OHLC + daily OHLCV."""
import algotik_tse as att
from datetime import datetime, timezone
from typing import Any
from pymongo import UpdateOne
from .db import get_db, COL_CANDLES_BASE, COL_CANDLES_DAILY

def fetch_intraday_1m(symbol, from_date, to_date):
    """Fetch 1m OHLC (both jalali and gregorian strings accepted)."""
    try:
        df = att.get_intraday(symbol, interval='1min', start=from_date, end=to_date, progress=False)
    except Exception as e:
        return [], str(e)

    if df is None or len(df) == 0:
        return [], None

    records = []
    for idx, row in df.iterrows():
        try:
            ts = idx.to_pydatetime() if hasattr(idx, 'to_pydatetime') else idx
            if ts.tzinfo is None:
                ts = ts.replace(tzinfo=timezone.utc)
            o, h, l, c = float(row['Open']), float(row['High']), float(row['Low']), float(row['Close'])
            if not (o > 0 and h > 0 and l > 0 and c > 0):
                continue
            records.append({
                'symbol': symbol, 'time': ts,
                'open': o, 'high': h, 'low': l, 'close': c,
                'volume': float(row.get('Volume', 0)),
                'trades': int(row.get('TradeCount', 0)) if 'TradeCount' in row else 0,
                'source': 'algotik_intraday',
                'updatedAt': datetime.now(timezone.utc),
            })
        except Exception:
            continue
    return records, None

def fetch_daily(symbol, from_date=None, to_date=None, limit=0):
    """Fetch daily OHLCV."""
    try:
        # Keep the mixed-type keyword arguments from being inferred as
        # ``dict[str, bool]`` by static type checkers.
        kwargs: dict[str, Any] = {'progress': False}
        if from_date: kwargs['start'] = from_date
        if to_date: kwargs['end'] = to_date
        if limit: kwargs['limit'] = limit
        df = att.get_history(symbol, **kwargs)
    except Exception as e:
        return [], str(e)

    if df is None or len(df) == 0:
        return [], None

    records = []
    for idx, row in df.iterrows():
        try:
            ts = idx.to_pydatetime() if hasattr(idx, 'to_pydatetime') else idx
            if isinstance(ts, str):
                ts = datetime.fromisoformat(ts)
            if ts.tzinfo is None:
                ts = ts.replace(tzinfo=timezone.utc)
            o, h, l, c = float(row['Open']), float(row['High']), float(row['Low']), float(row['Close'])
            if not (o > 0 and h > 0 and l > 0 and c > 0):
                continue
            rec = {
                'symbol': symbol, 'time': ts,
                'open': o, 'high': h, 'low': l, 'close': c,
                'volume': float(row.get('Volume', 0)),
                'source': 'algotik_daily',
                'updatedAt': datetime.now(timezone.utc),
            }
            if 'Final' in row and row['Final']: rec['final'] = float(row['Final'])
            if 'No.' in row and row['No.']: rec['trades'] = int(row['No.'])
            if 'Value' in row and row['Value']: rec['value'] = float(row['Value'])
            records.append(rec)
        except Exception:
            continue
    return records, None

def _bulk_write(col_name, records):
    if not records:
        return 0
    db = get_db()
    ops = [UpdateOne(
        {'symbol': r['symbol'], 'time': r['time']},
        {'$set': r}, upsert=True
    ) for r in records]
    res = db[col_name].bulk_write(ops, ordered=False)
    return res.upserted_count + res.modified_count

def write_base(records):
    return _bulk_write(COL_CANDLES_BASE, records)

def write_daily(records):
    return _bulk_write(COL_CANDLES_DAILY, records)