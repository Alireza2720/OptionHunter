# -*- coding: utf-8 -*-
"""Live ticker — background thread."""
import threading, time
from datetime import datetime, timezone
import algotik_tse as att
from pymongo import InsertOne
from . import stocks, options
from .db import log, get_db

_thread = None
_running = False
_stats = {'ticks': 0, 'last_tick_at': None, 'last_error': None}

def _is_market_open():
    """Tehran weekday (Sat-Wed) + hour 9:00-12:30."""
    now = datetime.now(timezone.utc)
    local = now + __import__('datetime').timedelta(hours=3, minutes=30)
    wd = local.weekday()  # Mon=0, Sun=6
    # Sat=5, Sun=6, Mon=0, Tue=1, Wed=2
    if wd not in (5, 6, 0, 1, 2):
        return False
    mins = local.hour * 60 + local.minute
    return 9*60 <= mins <= 12*60 + 35

_last_snap = {}  # symbol -> {tvol, tno, at}


def _tick_loop(get_symbols, get_rf, interval_sec):
    global _running
    _running = True
    log('ticker_start', f'interval={interval_sec}s')
    while _running:
        if not _is_market_open():
            time.sleep(30)
            continue
        try:
            symbols = get_symbols()
            rf = get_rf()

            # Stock ticks → stock_ticks collection
            try:
                import json
                live = att.get_live_market()
                if live is not None and len(live) > 0:
                    records = json.loads(live.to_json(orient='records', date_format='iso'))
                    ts = datetime.now(timezone.utc)
                    now_ts = time.time()
                    docs = []
                    for r in records:
                        sym = r.get('Symbol')
                        if not sym or sym not in symbols:
                            continue
                        price = float(r.get('Last') or 0)
                        if price <= 0:
                            continue

                        # 🆕 محاسبه volume delta (جلوگیری از double-count)
                        tvol = float(r.get('Volume') or 0)
                        tno = float(r.get('TradeCount') or 0)
                        prev = _last_snap.get(sym)
                        # اگه آخرین snap بیش از 8 ساعت پیش بوده → روز عوض شده
                        stale = prev and (now_ts - prev.get('at', 0)) > 8 * 3600
                        if not prev or stale or tvol < prev.get('tvol', 0):
                            vol_delta = 0  # شروع روز جدید یا restart
                        elif tvol >= prev.get('tvol', 0):
                            vol_delta = tvol - prev.get('tvol', 0)
                        else:
                            vol_delta = 0
                        _last_snap[sym] = {'tvol': tvol, 'tno': tno, 'at': now_ts}

                        docs.append({
                            'symbol': sym,
                            'time': ts,
                            'price': price,
                            'close': float(r.get('Close') or 0),
                            'volume': tvol,
                            'volumeDelta': vol_delta,   # 🆕
                            'tradeCount': tno,
                            'individualPower': float(r.get('IndividualPower') or 0),
                            'bidPrice': float(r.get('BidPrice1') or 0),
                            'askPrice': float(r.get('AskPrice1') or 0),
                            'source': 'live_tick',
                        })
                    if docs:
                        get_db()['stock_ticks'].insert_many(docs, ordered=False)
            except Exception as e:
                log('tick_stock_err', str(e))

            # options: per symbol
            for sym in symbols:
                try:
                    df, err = options.fetch_market(sym)
                    if df is None or len(df) == 0:
                        continue
                    raw_records = df.to_dict('records')
                    options.write_snapshot_ticks(sym, raw_records)
                except Exception as e:
                    log('tick_option_err', str(e), {'symbol': sym})

            _stats['ticks'] += 1
            _stats['last_tick_at'] = datetime.now(timezone.utc)
        except Exception as e:
            _stats['last_error'] = str(e)
            log('tick_err', str(e))
        time.sleep(interval_sec)

def start_ticker(get_symbols, get_rf, interval_sec=10):
    global _thread, _running
    if _running:
        return False
    _running = True
    _thread = threading.Thread(
        target=_tick_loop,
        args=(get_symbols, get_rf, interval_sec),
        daemon=True,
    )
    _thread.start()
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