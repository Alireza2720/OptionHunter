# -*- coding: utf-8 -*-
"""Stock data: intraday 1m OHLC + daily OHLCV."""
import algotik_tse as att
from datetime import datetime, timezone
from typing import Any
from pymongo import UpdateOne
from .db import get_db, COL_CANDLES_BASE, COL_CANDLES_DAILY


# ----------------------------------------------------------------
# Jalali → Gregorian (بدون وابستگی خارجی)
# ----------------------------------------------------------------
def _jalali_to_gregorian(jy, jm, jd):
    jy += 1595
    days = -355668 + (365 * jy) + (jy // 33) * 8 + ((jy % 33) + 3) // 4 + jd + \
           ((jm - 1) * 31 if jm < 7 else ((jm - 7) * 30) + 186)
    gy = 400 * (days // 146097)
    days %= 146097
    if days > 36524:
        days -= 1
        gy += 100 * (days // 36524)
        days %= 36524
        if days >= 365:
            days += 1
    gy += 4 * (days // 1461)
    days %= 1461
    if days > 365:
        gy += (days - 1) // 365
        days = (days - 1) % 365
    gd = days + 1
    leap = (gy % 4 == 0 and gy % 100 != 0) or (gy % 400 == 0)
    sal_a = [0, 31, 29 if leap else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    gm = 0
    while gm < 13 and gd > sal_a[gm]:
        gd -= sal_a[gm]
        gm += 1
    return gy, gm, gd


def _parse_index_date(idx):
    """تاریخ index (شمسی یا میلادی) رو به datetime میلادی UTC تبدیل کن."""
    # اگر string بود
    if isinstance(idx, str):
        s = idx.strip().split('T')[0].split(' ')[0]
        parts = s.split('-')
        if len(parts) == 3:
            y, m, d = int(parts[0]), int(parts[1]), int(parts[2])
            if y < 1700:  # Jalali
                gy, gm, gd = _jalali_to_gregorian(y, m, d)
                return datetime(gy, gm, gd, tzinfo=timezone.utc)
            return datetime(y, m, d, tzinfo=timezone.utc)
        return datetime.fromisoformat(s).replace(tzinfo=timezone.utc)

    # اگر datetime / Timestamp بود
    dt = idx.to_pydatetime() if hasattr(idx, 'to_pydatetime') else idx
    if not isinstance(dt, datetime):
        raise ValueError(f"unknown index type: {type(idx)}")

    # اگه سال < 1700 → یعنی یه جایی شمسی بوده
    if dt.year < 1700:
        gy, gm, gd = _jalali_to_gregorian(dt.year, dt.month, dt.day)
        return datetime(gy, gm, gd, dt.hour, dt.minute, dt.second, tzinfo=timezone.utc)

    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt

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
        # بهترین تلاش برای گرفتن تاریخ میلادی از algotik
        try:
            df = att.get_history(symbol, date_format='gregorian', **kwargs)
        except TypeError:
            # نسخه‌های قدیمی‌تر ممکنه این پارامتر رو نشناسن
            df = att.get_history(symbol, **kwargs)
    except Exception as e:
        return [], str(e)

    if df is None or len(df) == 0:
        return [], None

    records = []
    for idx, row in df.iterrows():
        try:
            ts = _parse_index_date(idx)   # ← فیکس اصلی
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