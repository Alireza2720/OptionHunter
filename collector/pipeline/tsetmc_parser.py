# -*- coding: utf-8 -*-
"""TSETMC parsers + helpers.

Pure functions, no HTTP. Used by tsetmc_client and pipeline modules.
"""
import re
import unicodedata
from collections import defaultdict
from datetime import datetime, timezone, timedelta


# ─── Persian/Arabic normalization ───
_FA_REPLACEMENTS = {
    "\u064a": "\u06cc",   # Arabic Yeh  → Persian Yeh
    "\u0643": "\u06a9",   # Arabic Kaf  → Persian Kaf
    "\u0649": "\u06cc",   # Alef Maksura → Yeh
    "\u06c0": "\u0647",   # Heh with Yeh → Heh
}


def normalize_fa(text):
    """Normalize Persian/Arabic text for safe comparison."""
    if not text:
        return ""
    text = unicodedata.normalize("NFKC", str(text))
    for old, new in _FA_REPLACEMENTS.items():
        text = text.replace(old, new)
    return re.sub(r"\s+", " ", text).strip()


# ─── Jalali → Gregorian ───
def _jalali_to_gregorian(jy, jm, jd):
    """Convert Jalali date to Gregorian (no external deps)."""
    jy += 1595
    days = (-355668 + 365 * jy + (jy // 33) * 8
            + ((jy % 33) + 3) // 4 + jd
            + ((jm - 1) * 31 if jm < 7 else (jm - 7) * 30 + 186))
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
    months = [0, 31, 29 if leap else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    gm = 0
    while gm < 13 and gd > months[gm]:
        gd -= months[gm]
        gm += 1
    return gy, gm, gd


# ─── Parse lVal30 (option long name) ───
def parse_lval30(lval30):
    """Parse TSETMC option long name.

    Examples:
        'اختيارخ اهرم-11000-1401/06/30'  → call, اهرم, strike=11000, expiry=1401-06-30
        'اختيارخ فملي-400-14031104'       → call, فملي, strike=400,   expiry=1403-11-04
        'اختيارخ خودرو-2400-1403/07/04'   → put

    Returns dict or None.
    """
    if not lval30:
        return None
    s = normalize_fa(lval30)

    try:
        head, strike_s, exp_s = s.rsplit("-", 2)
    except ValueError:
        return None

    parts = head.split()
    if not parts:
        return None

    word = parts[0]
    if word.endswith("\u062e"):        # Persian kheh → "اختيارخ" = call
        opt_type = "call"
    elif word.endswith("\u0641"):      # Persian feh → "اختيارف" = put
        opt_type = "put"
    else:
        return None

    underlying = parts[-1] if len(parts) > 1 else ""

    try:
        strike = int(re.sub(r"[^\d]", "", strike_s))
    except ValueError:
        return None

    jy = jm = jd = None
    exp_clean = exp_s.strip()

    if "/" in exp_clean:
        p = exp_clean.split("/")
        if len(p) == 3:
            try:
                jy, jm, jd = int(p[0]), int(p[1]), int(p[2])
            except ValueError:
                pass
    else:
        digits = re.sub(r"[^\d]", "", exp_clean)
        if len(digits) >= 8:
            try:
                jy, jm, jd = int(digits[:4]), int(digits[4:6]), int(digits[6:8])
            except ValueError:
                pass

    greg = None
    if jy and jm and jd:
        try:
            gy, gm, gd = _jalali_to_gregorian(jy, jm, jd)
            greg = "{:04d}-{:02d}-{:02d}".format(gy, gm, gd)
        except Exception:
            greg = None

    return {
        "type": opt_type,
        "underlying": underlying,
        "strike": strike,
        "expiry_jalali": (jy, jm, jd) if jy else None,
        "expiry_gregorian": greg,
    }


# ─── Time helpers ───
def heven_to_time_str(heven):
    """TSETMC hEven (e.g. 122959) → '12:29:59'."""
    try:
        s = str(int(heven)).zfill(6)
        h, m, sec = int(s[0:2]), int(s[2:4]), int(s[4:6])
        return "{:02d}:{:02d}:{:02d}".format(h, m, sec)
    except Exception:
        return None


def heven_to_seconds(heven):
    """TSETMC hEven → seconds since midnight."""
    try:
        s = str(int(heven)).zfill(6)
        return int(s[0:2]) * 3600 + int(s[2:4]) * 60 + int(s[4:6])
    except Exception:
        return None


def yyyymmdd_to_datetime(date_str, hour=9, minute=0):
    """'20240901' → datetime(2024, 9, 1, 9, 0, tz=UTC)."""
    try:
        s = str(int(date_str))
        y, m, d = int(s[:4]), int(s[4:6]), int(s[6:8])
        return datetime(y, m, d, hour, minute, tzinfo=timezone.utc)
    except Exception:
        return None


def ts_to_iso(ts):
    """unix ts or datetime → 'YYYY-MM-DD'."""
    if isinstance(ts, datetime):
        return ts.strftime("%Y-%m-%d")
    try:
        return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d")
    except Exception:
        return None


# ─── Snapshot → 1m candle aggregation ───
# Tehran session starts at 09:00 local = 05:30 UTC
_SESSION_START_UTC_H = 5
_SESSION_START_UTC_M = 30


def aggregate_snapshots_to_1m(snapshots, date_yyyymmdd):
    """Convert raw TSETMC snapshots to 1-minute OHLCV candles.

    Each snapshot represents a state at time hEven (Tehran, HHMMSS).
    Snapshots are cumulative (qTotTran5J, zTotTran are running totals).

    For dense stocks: ~1000+ snapshots/day → fills nearly every minute.
    For sparse options: only a few snapshots → returns few candles.

    Args:
        snapshots: list of dicts from TSETMC with keys
                   {hEven, pDrCotVal, qTotTran5J, zTotTran}
        date_yyyymmdd: '20240901' (used to build UTC timestamps)

    Returns: list of candle dicts with keys
             {time, open, high, low, close, volume, trades}
    """
    if not snapshots:
        return []

    # Parse date components
    try:
        s = str(int(date_yyyymmdd))
        y, m, d = int(s[:4]), int(s[4:6]), int(s[6:8])
    except Exception:
        return []

    # Bucket snapshots by minute-of-day
    buckets = defaultdict(list)

    for snap in snapshots:
        heven = snap.get("hEven")
        price = snap.get("pDrCotVal")
        cum_vol = snap.get("qTotTran5J") or 0
        cum_trades = snap.get("zTotTran") or 0

        if heven is None or price is None:
            continue

        try:
            p = float(price)
            if p <= 0:
                continue
            secs = heven_to_seconds(heven)
            if secs is None:
                continue
        except (ValueError, TypeError):
            continue

        minute_of_day = secs // 60
        buckets[minute_of_day].append({
            "sec": secs,
            "price": p,
            "cum_vol": float(cum_vol),
            "cum_trades": float(cum_trades),
        })

    if not buckets:
        return []

    # Build candles
    candles = []
    prev_cum_vol = 0.0
    prev_cum_trades = 0.0

    for minute in sorted(buckets.keys()):
        rows = sorted(buckets[minute], key=lambda r: r["sec"])
        if not rows:
            continue

        o = rows[0]["price"]
        c = rows[-1]["price"]
        prices = [r["price"] for r in rows]
        h = max(prices)
        l = min(prices)

        last_cum_vol = rows[-1]["cum_vol"]
        last_cum_trades = rows[-1]["cum_trades"]

        # Volume delta (handle first bucket and resets)
        if prev_cum_vol == 0:
            vol = last_cum_vol
        elif last_cum_vol >= prev_cum_vol:
            vol = last_cum_vol - prev_cum_vol
        else:
            vol = last_cum_vol  # counter reset

        if prev_cum_trades == 0:
            trades = int(last_cum_trades)
        elif last_cum_trades >= prev_cum_trades:
            trades = int(last_cum_trades - prev_cum_trades)
        else:
            trades = int(last_cum_trades)

        prev_cum_vol = last_cum_vol
        prev_cum_trades = last_cum_trades

        # Timestamp: session start (05:30 UTC) + minute_of_day offset
        # Note: minute_of_day is Tehran-local minutes since 00:00.
        # Tehran 09:00 = minute 540. So UTC = (minute_of_day - 540) minutes
        # after 05:30 UTC.
        offset_minutes = minute_of_day - 540
        ts = (datetime(y, m, d, _SESSION_START_UTC_H, _SESSION_START_UTC_M,
                       tzinfo=timezone.utc)
              + timedelta(minutes=offset_minutes))

        candles.append({
            "time": ts,
            "open": o,
            "high": h,
            "low": l,
            "close": c,
            "volume": int(vol),
            "trades": trades,
        })

    return candles
