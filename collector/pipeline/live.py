# -*- coding: utf-8 -*-
"""Live ticker — TSETMC MarketWatch based.

Preserves the same public interface as before:
    start_ticker(get_symbols, get_rf, interval_sec) -> bool
    stop_ticker() -> None
    get_stats() -> dict
    is_running() -> bool
"""
import threading
import time
import gc
from datetime import datetime, timezone, timedelta

from .db import log, get_db
from .tsetmc_client import get_client, TSETMCError


_running = False
_lock = threading.Lock()

_stats = {
    "ticks": 0,
    "last_tick_at": None,
    "last_error": None,
    "tick_errors": 0,
    "option_cycles": 0,
    "last_option_at": None,
    "last_stock_rows": 0,
    "last_option_rows": 0,
}

_last_snap = {}
_last_snap_date = None
OPTION_INTERVAL_SEC = 600  # R38: 10 min (was 5)


def _tehran_today():
    return (datetime.now(timezone.utc) + timedelta(hours=3, minutes=30)).strftime("%Y-%m-%d")


def _check_snap_date(today):
    global _last_snap, _last_snap_date
    if _last_snap_date != today:
        _last_snap = {}
        _last_snap_date = today


def _is_market_open():
    local = datetime.now(timezone.utc) + timedelta(hours=3, minutes=30)
    if local.weekday() not in (5, 6, 0, 1, 2):
        return False
    m = local.hour * 60 + local.minute
    return 9 * 60 <= m <= 12 * 60 + 35


def _fetch_stocks(symbols):
    try:
        client = get_client()
        mw = client.market_watch(paper_types=(1, 2, 3), with_best_limits=True)
    except TSETMCError as e:
        log("tick_stock_err", str(e)[:200])
        return 0

    if not mw:
        return 0

    ts = datetime.now(timezone.utc)
    now_ts = time.time()
    _check_snap_date(_tehran_today())

    def _num(v, d=0.0):
        try:
            f = float(v)
            return d if f != f else f
        except (TypeError, ValueError):
            return d

    symbols_set = set(symbols) if not isinstance(symbols, set) else symbols
    docs = []
    for r in mw:
        sym = r.get("lva") or r.get("lVal18AFC") or r.get("symbol")
        if not sym or sym not in symbols_set:
            continue

        price = _num(r.get("pDrCotVal") or r.get("last") or r.get("pcl"))
        if price <= 0:
            continue

        close = _num(r.get("pcl") or r.get("pClosing"))
        yday  = _num(r.get("py") or r.get("priceYesterday") or r.get("yesterday"))
        popen = _num(r.get("pOpening") or r.get("priceFirst"))

        # High/Low = قیمت معامله‌شده امروز (نه سقف/کف مجاز)
        high = _num(r.get("pmax"))
        low  = _num(r.get("pmin"))
        if high <= 0 and price > 0:
            high = price
        if low <= 0 and price > 0:
            low = price

        # Allowed limits از priceMax/priceMin (نه pmax/pmin)
        allowed_max = _num(r.get("priceMax"))
        allowed_min = _num(r.get("priceMin"))
        ref = close if close > 0 else price
        if ref > 0:
            if not (allowed_max > 0 and 0.85 * ref <= allowed_max <= 1.15 * ref):
                allowed_max = round(ref * 1.05)
            if not (allowed_min > 0 and 0.85 * ref <= allowed_min <= 1.15 * ref):
                allowed_min = round(ref * 0.95)
        else:
            allowed_max = 0
            allowed_min = 0

        tvol = _num(r.get("qTotTran5J") or r.get("Volume"))
        tno  = _num(r.get("zTotTran") or r.get("TradeCount"))

        prev = _last_snap.get(sym)
        stale = prev and (now_ts - prev.get("at", 0)) > 8 * 3600
        if prev and not stale and tvol >= prev.get("tvol", 0):
            vol_delta = max(0, tvol - prev.get("tvol", 0))
        else:
            vol_delta = 0
        _last_snap[sym] = {"tvol": tvol, "tno": tno, "at": now_ts}

        # Bid/Ask واقعی از bestLimits[0]
        bid_p, bid_v, ask_p, ask_v = 0.0, 0.0, 0.0, 0.0
        bl = r.get("bestLimits")
        if isinstance(bl, list) and bl:
            l0 = bl[0]
            bid_p = _num(l0.get("bd") or l0.get("bidPrice") or l0.get("bid"))
            bid_v = _num(l0.get("bq") or l0.get("bidVol") or l0.get("bidVolume"))
            ask_p = _num(l0.get("od") or l0.get("askPrice") or l0.get("ask"))
            ask_v = _num(l0.get("oq") or l0.get("askVol") or l0.get("askVolume"))
        if bid_p <= 0:
            bid_p = _num(r.get("pd1") or r.get("pMeDem"))
        if ask_p <= 0:
            ask_p = _num(r.get("po1") or r.get("pMeOf"))
        if bid_p > 0 and ask_p > 0 and bid_p > ask_p:
            bid_p, ask_p = ask_p, bid_p
            bid_v, ask_v = ask_v, bid_v

        docs.append({
            "symbol": sym,
            "time": ts,
            "price": price,
            "close": close,
            "open": popen,
            "high": high,
            "low": low,
            "maxAllowed": allowed_max,
            "minAllowed": allowed_min,
            "volume": tvol,
            "volumeDelta": vol_delta,
            "tradeCount": tno,
            "bidPrice": bid_p,
            "bidVol": bid_v,
            "askPrice": ask_p,
            "askVol": ask_v,
            "yesterday": yday,
            "source": "tsetmc_live_tick",
        })

    if docs:
        try:
            get_db()["stock_ticks"].insert_many(docs, ordered=False)
        except Exception as e:
            log("tick_stock_insert_err", str(e)[:200])

    return len(docs)


def _fetch_options(symbols):
    total = 0
    from . import options as opt_mod
    for sym in symbols:
        if not _running:
            break
        try:
            df, err = opt_mod.fetch_market(sym)
            if df is None or len(df) == 0:
                continue
            total += opt_mod.write_snapshot_ticks(sym, df.to_dict("records"))
        except Exception as e:
            log("tick_option_err", str(e)[:150], {"symbol": sym})
    return total


def _stock_loop(get_symbols, get_rf, interval_sec):
    log("stock_loop_start", "interval={}s".format(interval_sec))
    while _running:
        if not _is_market_open():
            time.sleep(30)
            continue
        try:
            symbols = get_symbols()
            t0 = time.time()
            rows = _fetch_stocks(symbols)
            ms = int((time.time() - t0) * 1000)
            _stats["ticks"] += 1
            _stats["last_tick_at"] = datetime.now(timezone.utc)
            _stats["last_stock_rows"] = rows
            log("tick_ok", "tick #{} | symbols={} rows={} | {}ms".format(
                _stats["ticks"], len(symbols), rows, ms))
            if _stats["ticks"] % 50 == 0:
                gc.collect()
        except Exception as e:
            _stats["last_error"] = str(e)[:200]
            _stats["tick_errors"] = _stats.get("tick_errors", 0) + 1
            log("tick_err", str(e)[:200])
        time.sleep(interval_sec)


def _option_loop(get_symbols):
    log("option_loop_start", "every {}s".format(OPTION_INTERVAL_SEC))
    for _ in range(30):
        if not _running:
            return
        time.sleep(1)

    while _running:
        try:
            if not _is_market_open():
                time.sleep(30)
                continue
            symbols = get_symbols()
            t0 = time.time()
            rows = _fetch_options(symbols)
            elapsed = int(time.time() - t0)
            _stats["option_cycles"] += 1
            _stats["last_option_at"] = datetime.now(timezone.utc)
            _stats["last_option_rows"] = rows
            log("option_ok", "cycle #{} rows={} | {}s".format(
                _stats["option_cycles"], rows, elapsed))
        except Exception as e:
            log("option_loop_err", str(e)[:200])

        for _ in range(OPTION_INTERVAL_SEC):
            if not _running:
                return
            time.sleep(1)


def start_ticker(get_symbols, get_rf, interval_sec=10):
    global _running
    with _lock:
        if _running:
            return False
        _running = True
    threading.Thread(
        target=_stock_loop,
        args=(get_symbols, get_rf, interval_sec),
        daemon=True,
    ).start()
    threading.Thread(
        target=_option_loop,
        args=(get_symbols,),
        daemon=True,
    ).start()
    return True


def stop_ticker():
    global _running
    _running = False


def get_stats():
    d = dict(_stats)
    d["running"] = _running
    return d


def is_running():
    return _running
