# -*- coding: utf-8 -*-
"""Stock data — TSETMC raw HTTP client.

Replaces algotik-tse for stock data.
Keeps the same interface as the old stocks.py:
    fetch_intraday_1m(symbol, from_date, to_date) -> (records, err)
    fetch_daily(symbol, from_date, to_date, limit) -> (records, err)
    write_base(records) -> count
    write_daily(records) -> count

Source tags are configurable via env vars to allow gradual migration:
    CANDLE_INTRADAY_SOURCE  default: 'tsetmc_intraday'
    CANDLE_DAILY_SOURCE     default: 'tsetmc_ohlcv'
"""
import os
import re
import unicodedata
from datetime import datetime, timezone, timedelta

from pymongo import UpdateOne

from .db import get_db, COL_CANDLES_BASE, COL_CANDLES_DAILY
from .tsetmc_client import get_client, TSETMCError
from .tsetmc_parser import (
    normalize_fa,
    _jalali_to_gregorian,
    aggregate_snapshots_to_1m,
)


# ─── Source tags (env-configurable) ───
SOURCE_INTRADAY = os.getenv("CANDLE_INTRADAY_SOURCE", "tsetmc_intraday")
SOURCE_DAILY = os.getenv("CANDLE_DAILY_SOURCE", "tsetmc_ohlcv")


# ─── insCode resolution ───
_insCode_cache = {}


def resolve_insCode(symbol, logger=None):
    """Resolve stock ticker to TSETMC insCode.

    Order:
        1. In-memory cache
        2. monitored_symbols.insCode (DB)
        3. meta.symbols_cache (DB, only entries with insCode)
        4. TSETMC search (persist to BOTH monitored_symbols + meta.symbols_cache)

    Returns insCode string or None.
    """
    if not symbol:
        return None

    sym_norm = normalize_fa(symbol)

    # 1) in-memory
    if sym_norm in _insCode_cache:
        return _insCode_cache[sym_norm]

    db = None
    try:
        db = get_db()
    except Exception:
        pass

    # 2) monitored_symbols (fastest)
    if db is not None:
        try:
            doc = db["monitored_symbols"].find_one({"symbol": symbol})
            if doc and doc.get("insCode"):
                code = str(doc["insCode"])
                _insCode_cache[sym_norm] = code
                return code
        except Exception:
            pass

    # 3) meta.symbols_cache (only entries with insCode)
    if db is not None:
        try:
            meta = db["meta"].find_one({"_id": "symbols_cache"})
            if meta and meta.get("symbols"):
                for s in meta["symbols"]:
                    if not isinstance(s, dict):
                        continue
                    if not s.get("insCode"):
                        continue
                    if normalize_fa(s.get("symbol", "")) == sym_norm:
                        code = str(s["insCode"])
                        _insCode_cache[sym_norm] = code
                        return code
        except Exception:
            pass

    # 4) TSETMC search
    try:
        client = get_client()
        results = client.search(sym_norm)
        for r in results:
            if normalize_fa(r.get("lVal18AFC", "")) == sym_norm:
                code = r.get("insCode")
                if not code:
                    continue
                code = str(code)
                _insCode_cache[sym_norm] = code

                # Persist to monitored_symbols (primary)
                if db is not None:
                    try:
                        db["monitored_symbols"].updateOne(
                            {"symbol": symbol},
                            {"$set": {"insCode": code}},
                        )
                    except Exception:
                        pass

                    # Also to meta cache (secondary)
                    try:
                        db["meta"].updateOne(
                            {"_id": "symbols_cache"},
                            {"$addToSet": {"symbols": {
                                "symbol": symbol,
                                "insCode": code,
                            }}},
                            upsert=True,
                        )
                    except Exception:
                        pass
                return code
    except TSETMCError as e:
        if logger:
            logger.warn("resolve_insCode({}): {}".format(symbol, str(e)[:150]))
    except Exception as e:
        if logger:
            logger.warn("resolve_insCode({}): unexpected {}".format(symbol, str(e)[:150]))

    return None


# ─── Date helpers ───
def _date_str_to_parts(date_str):
    """Parse 'YYYY-MM-DD' or 'YYYYMMDD' or Jalali into (y, m, d)."""
    if not date_str:
        return None

    s = str(date_str).strip()
    # Remove invisible Unicode (Cf category)
    s = "".join(c for c in s if unicodedata.category(c) != "Cf")
    s = s.replace("/", "-").replace(".", "-").replace(" ", "-")
    s = re.sub(r"-+", "-", s).strip("-")

    parts = s.split("-")
    if len(parts) == 3:
        try:
            return int(parts[0]), int(parts[1]), int(parts[2])
        except ValueError:
            pass

    digits = re.sub(r"[^\d]", "", s)
    if len(digits) >= 8:
        return int(digits[:4]), int(digits[4:6]), int(digits[6:8])

    return None


def _to_gregorian_yyyymmdd(date_str):
    """Convert Jalali or Gregorian date string -> 'YYYYMMDD' (Gregorian)."""
    parts = _date_str_to_parts(date_str)
    if not parts:
        return None
    y, m, d = parts
    if y < 1700:  # Jalali
        try:
            gy, gm, gd = _jalali_to_gregorian(y, m, d)
            return "{:04d}{:02d}{:02d}".format(gy, gm, gd)
        except Exception:
            return None
    return "{:04d}{:02d}{:02d}".format(y, m, d)


# ─── Intraday 1m (TSETMC) ───
def fetch_intraday_1m(symbol, from_date, to_date):
    """Fetch 1m OHLCV candles from TSETMC for [from_date, to_date].

    Args:
        symbol: ticker (Persian) or insCode
        from_date, to_date: date strings (Jalali or Gregorian)

    Returns:
        (records, error_msg)
    """
    ins_code = resolve_insCode(symbol)
    if not ins_code:
        return [], "insCode not found for " + str(symbol)

    d_from = _to_gregorian_yyyymmdd(from_date)
    d_to = _to_gregorian_yyyymmdd(to_date)
    if not (d_from and d_to):
        return [], "invalid date range: {} .. {}".format(from_date, to_date)

    try:
        y1, m1, dd1 = int(d_from[:4]), int(d_from[4:6]), int(d_from[6:8])
        y2, m2, dd2 = int(d_to[:4]), int(d_to[4:6]), int(d_to[6:8])
        cur = datetime(y1, m1, dd1)
        end = datetime(y2, m2, dd2)
    except Exception as e:
        return [], "date parse: " + str(e)

    if cur > end:
        return [], "from > to"

    client = get_client()
    all_candles = []
    now = datetime.now(timezone.utc)

    while cur <= end:
        # TSE trading days: Sat(5), Sun(6), Mon(0), Tue(1), Wed(2)
        # Closed: Thu(3), Fri(4)
        if cur.weekday() not in (3, 4):
            date_yyyymmdd = cur.strftime("%Y%m%d")
            try:
                snaps = client.ohlcv_intraday(ins_code, date_yyyymmdd)
                if snaps:
                    candles = aggregate_snapshots_to_1m(snaps, date_yyyymmdd)
                    for c in candles:
                        c["symbol"] = symbol
                        c["insCode"] = ins_code
                        c["source"] = SOURCE_INTRADAY
                        c["updatedAt"] = now
                    all_candles.extend(candles)
            except TSETMCError:
                # Skip this day, do not abort the whole range
                pass
        cur += timedelta(days=1)

    return all_candles, None


# ─── Daily OHLCV (TSETMC) ───
def fetch_daily(symbol, from_date=None, to_date=None, limit=0):
    """Fetch daily OHLCV from TSETMC (A=1, includes non-traded days).

    Returns:
        (records, error_msg)
    """
    ins_code = resolve_insCode(symbol)
    if not ins_code:
        return [], "insCode not found for " + str(symbol)

    try:
        client = get_client()
        raw = client.ohlcv_full(ins_code)
    except TSETMCError as e:
        return [], str(e)

    now = datetime.now(timezone.utc)
    records = []

    for r in raw:
        date_str = str(r.get("date", "")).strip()
        if len(date_str) != 8:
            continue

        try:
            y, m, d = int(date_str[:4]), int(date_str[4:6]), int(date_str[6:8])
            ts = datetime(y, m, d, 9, 0, 0, tzinfo=timezone.utc)
        except Exception:
            continue

        o = r.get("open", 0) or 0
        h = r.get("high", 0) or 0
        l = r.get("low", 0) or 0
        c = r.get("close", 0) or 0

        # Require meaningful OHLC
        if not (o > 0 and h > 0 and l > 0 and c > 0):
            continue

        records.append({
            "symbol": symbol,
            "insCode": ins_code,
            "time": ts,
            "open": float(o),
            "high": float(h),
            "low": float(l),
            "close": float(c),
            "yesterday": float(r.get("yesterday", 0) or 0),
            "volume": float(r.get("volume", 0) or 0),
            "value": float(r.get("value", 0) or 0),
            "trades": int(r.get("trades", 0) or 0),
            "source": SOURCE_DAILY,
            "updatedAt": now,
        })

    # Date filter (Gregorian)
    if from_date:
        fg = _to_gregorian_yyyymmdd(from_date)
        if fg:
            try:
                f_ts = datetime(
                    int(fg[:4]), int(fg[4:6]), int(fg[6:8]),
                    tzinfo=timezone.utc
                )
                records = [x for x in records if x["time"] >= f_ts]
            except Exception:
                pass

    if to_date:
        tg = _to_gregorian_yyyymmdd(to_date)
        if tg:
            try:
                t_ts = datetime(
                    int(tg[:4]), int(tg[4:6]), int(tg[6:8]),
                    23, 59, 59, tzinfo=timezone.utc
                )
                records = [x for x in records if x["time"] <= t_ts]
            except Exception:
                pass

    if limit and limit > 0:
        records = records[-limit:]

    return records, None


# ─── DB write helpers ───
def _bulk_write(col_name, records):
    """Upsert records into MongoDB collection keyed by (symbol, time)."""
    if not records:
        return 0

    db = get_db()
    ops = []
    for r in records:
        ops.append(UpdateOne(
            {"symbol": r["symbol"], "time": r["time"]},
            {"$set": r},
            upsert=True,
        ))

    if not ops:
        return 0

    res = db[col_name].bulk_write(ops, ordered=False)
    return (res.upserted_count or 0) + (res.modified_count or 0)


def write_base(records):
    """Write intraday candles to candles_base."""
    return _bulk_write(COL_CANDLES_BASE, records)


def write_daily(records):
    """Write daily candles to candles_daily."""
    return _bulk_write(COL_CANDLES_DAILY, records)

