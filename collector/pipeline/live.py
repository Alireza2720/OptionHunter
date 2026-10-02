# -*- coding: utf-8 -*-
"""Live ticker — دو thread جدا:
   ۱) stock tick (سریع، هر ۱۰ ثانیه)
   ۲) option snapshot (کند، هر ۵ دقیقه)
"""
import threading, time, gc
from datetime import datetime, timezone, timedelta
import algotik_tse as att
from . import stocks, options
from .db import log, get_db

_stock_thread = None
_opt_thread = None
_running = False

_stats = {
    'ticks': 0,
    'last_tick_at': None,
    'last_error': None,
    'tick_errors': 0,
    'option_cycles': 0,
    'last_option_at': None,
    'last_stock_rows': 0,
    'last_option_rows': 0,
}

_last_snap = {}
_last_snap_date = None   # 🆕 تاریخ تهران برای reset خودکار

OPTION_INTERVAL_SEC = 300   # ۵ دقیقه


def _check_snap_date(tehran_today):
    """🆕 هر روز صبح snap رو reset کن."""
    global _last_snap, _last_snap_date
    if _last_snap_date != tehran_today:
        _last_snap = {}
        _last_snap_date = tehran_today


def _is_market_open():
    now = datetime.now(timezone.utc)
    local = now + timedelta(hours=3, minutes=30)
    wd = local.weekday()
    if wd not in (5, 6, 0, 1, 2):
        return False
    mins = local.hour * 60 + local.minute
    return 9 * 60 <= mins <= 12 * 60 + 35


def _fetch_stocks(symbols):
    try:
        live = att.get_live_market()
    except Exception as e:
        log('tick_stock_err', str(e)[:200])
        return 0

    if live is None or len(live) == 0:
        return 0

    try:
        import json
        records = json.loads(live.to_json(orient='records', date_format='iso'))
    except Exception as e:
        log('tick_stock_parse_err', str(e)[:200])
        return 0

    ts = datetime.now(timezone.utc)
    now_ts = time.time()
    docs = []

    # 🆕 reset روزانه
    from datetime import datetime as _dt
    tehran_today = (_dt.now(timezone.utc) + timedelta(hours=3, minutes=30)).strftime('%Y-%m-%d')
    _check_snap_date(tehran_today)

    for r in records:
        sym = r.get('Symbol')
        if not sym or sym not in symbols:
            continue
        price = float(r.get('Last') or 0)
        if price <= 0:
            continue

        tvol = float(r.get('Volume') or 0)
        tno = float(r.get('TradeCount') or 0)
        prev = _last_snap.get(sym)
        stale = prev and (now_ts - prev.get('at', 0)) > 8 * 3600
        if not prev or stale or tvol < prev.get('tvol', 0):
            vol_delta = 0
        else:
            vol_delta = max(0, tvol - prev.get('tvol', 0))
        _last_snap[sym] = {'tvol': tvol, 'tno': tno, 'at': now_ts}

        docs.append({
            'symbol': sym,
            'time': ts,
            'price': price,
            'close': float(r.get('Close') or 0),
            'volume': tvol,
            'volumeDelta': vol_delta,
            'tradeCount': tno,
            'individualPower': float(r.get('IndividualPower') or 0),
            'bidPrice': float(r.get('BidPrice1') or 0),
            'askPrice': float(r.get('AskPrice1') or 0),
            'source': 'live_tick',
        })

    if docs:
        try:
            get_db()['stock_ticks'].insert_many(docs, ordered=False)
        except Exception as e:
            log('tick_stock_insert_err', str(e)[:200])

    return len(docs)


def _fetch_options(symbols):
    total = 0
    for sym in symbols:
        if not _running:
            break
        try:
            df, err = options.fetch_market(sym)
            if df is None or len(df) == 0:
                continue
            raw = df.to_dict('records')
            n = options.write_snapshot_ticks(sym, raw)
            total += n
        except Exception as e:
            log('tick_option_err', str(e)[:150], {'symbol': sym})
    return total


def _stock_loop(get_symbols, get_rf, interval_sec):
    """thread ۱ — stock tick سریع"""
    log('stock_loop_start', f'interval={interval_sec}s')

    while _running:
        if not _is_market_open():
            time.sleep(30)
            continue

        try:
            symbols = get_symbols()
            t0 = time.time()
            rows = _fetch_stocks(symbols)
            stock_ms = int((time.time() - t0) * 1000)

            _stats['ticks'] += 1
            _stats['last_tick_at'] = datetime.now(timezone.utc)
            _stats['last_stock_rows'] = rows

            log('tick_ok',
                f'tick #{_stats["ticks"]} | symbols={len(symbols)} '
                f'rows={rows} | {stock_ms}ms')

            if _stats['ticks'] % 50 == 0:
                gc.collect()

        except Exception as e:
            _stats['last_error'] = str(e)[:200]
            _stats['tick_errors'] = _stats.get('tick_errors', 0) + 1
            log('tick_err', str(e)[:200])

        time.sleep(interval_sec)


def _option_loop(get_symbols):
    """thread ۲ — option snapshot جداگانه (کند)"""
    log('option_loop_start', f'every {OPTION_INTERVAL_SEC}s')

    # صبر ۳۰ ثانیه اول تا stock loop گرم بشه
    for _ in range(30):
        if not _running: return
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

            _stats['option_cycles'] += 1
            _stats['last_option_at'] = datetime.now(timezone.utc)
            _stats['last_option_rows'] = rows

            log('option_ok',
                f'cycle #{_stats["option_cycles"]} rows={rows} | {elapsed}s')
        except Exception as e:
            log('option_loop_err', str(e)[:200])

        # انتظار ۵ دقیقه با چک running
        for _ in range(OPTION_INTERVAL_SEC):
            if not _running: return
            time.sleep(1)


_ticker_lock = threading.Lock()

def start_ticker(get_symbols, get_rf, interval_sec=10):
    global _stock_thread, _opt_thread, _running
    # 🆕 lock برای جلوگیری از race condition
    with _ticker_lock:
        if _running:
            return False
        _running = True

    _stock_thread = threading.Thread(
        target=_stock_loop,
        args=(get_symbols, get_rf, interval_sec),
        daemon=True,
    )
    _stock_thread.start()

    _opt_thread = threading.Thread(
        target=_option_loop,
        args=(get_symbols,),
        daemon=True,
    )
    _opt_thread.start()

    return True


def stop_ticker():
    global _running
    _running = False


def get_stats():
    d = dict(_stats)
    d['running'] = _running
    return d


def is_running():
    return _running