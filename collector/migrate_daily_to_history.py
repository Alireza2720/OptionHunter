#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Migration v3: option_daily_algotik → option_history
- محاسبه IV/Greeks با algotik-tse
- تخمین bid/ask از close (mark as estimated)
"""
import os, sys, argparse
from datetime import datetime, timezone, timedelta

sys.path.insert(0, '/opt/collector')
import algotik_tse as att
from pymongo import MongoClient, UpdateOne, ASCENDING


def _load_dotenv():
    for path in ['/home/deploy/apps/OptionHunter/.env', '../.env', '.env']:
        try:
            if os.path.exists(path):
                for line in open(path, encoding='utf-8'):
                    line = line.strip()
                    if not line or line.startswith('#') or '=' not in line:
                        continue
                    k, v = line.split('=', 1)
                    k, v = k.strip(), v.strip()
                    if len(v) >= 2 and v[0] == v[-1] and v[0] in ("'", '"'):
                        v = v[1:-1]
                    if k and k not in os.environ:
                        os.environ[k] = v
                return
        except Exception:
            pass


_load_dotenv()

MONGO_URI = os.getenv('MONGO_URI', 'mongodb://127.0.0.1:27017')
MONGO_DB = os.getenv('MONGO_DB', 'trading_bot')

SRC = 'option_daily_algotik'
DST = 'option_history'
RF = 0.42


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument('--dry-run', action='store_true')
    p.add_argument('--limit', type=int, default=0)
    p.add_argument('--purge', action='store_true', help='delete old migrated_daily docs')
    return p.parse_args()


def _clean(v):
    if v is None:
        return None
    try:
        if v != v:  # NaN
            return None
    except Exception:
        pass
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def date_to_utc_eod(date_str):
    """'2026-09-16' → EOD time (Tehran 12:30 = UTC 09:00 same day)"""
    try:
        y, m, d = map(int, date_str.split('-'))
        return datetime(y, m, d, 9, 0, 0, tzinfo=timezone.utc)
    except Exception:
        return None


def main():
    args = parse_args()
    client = MongoClient(MONGO_URI)
    db = client[MONGO_DB]

    print(f'[info] src={SRC} dst={DST} dry-run={args.dry_run}')

    # index
    if not args.dry_run:
        try:
            db[DST].create_index([('symbol', ASCENDING), ('time', ASCENDING)])
        except Exception as e:
            print(f'[warn] index: {e}')

    if args.purge and not args.dry_run:
        r = db[DST].delete_many({'source': 'migrated_daily'})
        print(f'[purge] deleted {r.deleted_count}')

    # پیش‌بارگذاری candles_daily
    print('[info] loading candles_daily...')
    candle_cache = {}
    for c in db['candles_daily'].find({}):
        sym = c.get('symbol')
        t = c.get('time')
        if not sym or not t:
            continue
        date_str = t.strftime('%Y-%m-%d')
        candle_cache.setdefault(sym, {})[date_str] = c.get('close')
    print(f'[info] loaded {len(candle_cache)} symbols from candles_daily')

    cursor = db[SRC].find({})
    if args.limit:
        cursor = cursor.limit(args.limit)

    total = written = errors = skipped = 0
    ops = []

    for doc in cursor:
        total += 1
        underlying = doc.get('underlying')
        date_str = doc.get('date')
        strike = doc.get('strike')
        end_date = doc.get('end_date')
        option_type = (doc.get('option_type') or 'call').lower()
        close_px = doc.get('close') or doc.get('last')

        if not all([underlying, date_str, strike, end_date, close_px]):
            skipped += 1
            continue

        # 🆕 فیلتر placeholder: close=1 یعنی معامله نشده
        if close_px <= 1:
            skipped += 1
            continue

        # 🆕 فیلتر حجم صفر
        if not (doc.get('volume') or 0) > 0:
            skipped += 1
            continue

        # S از candles_daily
        S = candle_cache.get(underlying, {}).get(date_str)
        if not S or S <= 0:
            skipped += 1
            continue

        # daysLeft
        try:
            y1, m1, d1 = map(int, date_str.split('-'))
            y2, m2, d2 = map(int, end_date.split('-'))
            days_left = (datetime(y2, m2, d2) - datetime(y1, m1, d1)).days
        except Exception:
            skipped += 1
            continue

        if days_left <= 0:
            skipped += 1
            continue

        T = days_left / 365.0

        # IV
        try:
            iv_res = att.implied_volatility(close_px, S, strike, T, RF, option_type)
            iv = iv_res.get('ImpliedVolatility') if isinstance(iv_res, dict) else None
            if iv and (iv < 0.05 or iv > 5.0):
                iv = None
        except Exception:
            iv = None

        # Greeks
        delta = gamma = theta = vega = None
        if iv:
            try:
                g = att.black_scholes_greeks(S, strike, T, RF, iv, option_type)
                if isinstance(g, dict):
                    delta = g.get('Delta')
                    gamma = g.get('Gamma')
                    theta = g.get('ThetaPerDay')
                    vega = g.get('Vega')
            except Exception:
                pass

        # تخمین bid/ask (mark as estimated)
        bid_est = close_px * 0.98
        ask_est = close_px * 1.02

        time_val = date_to_utc_eod(date_str)
        if not time_val:
            skipped += 1
            continue

        rec = {
            'symbol': doc.get('symbol'),
            'underlying': underlying,
            'time': time_val,
            'strike': _clean(strike),
            'expiry': end_date,
            'daysLeft': days_left,
            'size': int(_clean(doc.get('contract_size')) or 1000),
            'isCall': option_type == 'call',
            'S': _clean(S),
            'bid': _clean(bid_est),
            'ask': _clean(ask_est),
            'last': _clean(doc.get('last')),
            'close': _clean(close_px),
            'oi': None,
            'volume': _clean(doc.get('volume')),
            'trades': _clean(doc.get('trade_count')),
            'ivApi': _clean(iv),
            'deltaApi': _clean(delta),
            'gammaApi': _clean(gamma),
            'thetaApi': _clean(theta),
            'vegaApi': _clean(vega),
            'riskFreeRate': RF,
            'bidEstimated': True,
            'askEstimated': True,
            'source': 'migrated_daily',
            'migratedAt': datetime.now(timezone.utc),
        }

        ops.append(UpdateOne(
            {'symbol': rec['symbol'], 'time': time_val},
            {'$set': rec},
            upsert=True,
        ))

        if len(ops) >= 500:
            if not args.dry_run:
                try:
                    res = db[DST].bulk_write(ops, ordered=False)
                    written += res.upserted_count + res.modified_count
                except Exception as e:
                    print(f'[error] bulk: {e}')
                    errors += 1
            ops = []
            if total % 5000 == 0:
                print(f'[progress] total={total} written={written} skipped={skipped}')

    if ops and not args.dry_run:
        try:
            res = db[DST].bulk_write(ops, ordered=False)
            written += res.upserted_count + res.modified_count
        except Exception as e:
            print(f'[error] final: {e}')

    print()
    print('=' * 60)
    print(f'total processed:  {total}')
    print(f'written:          {written}')
    print(f'skipped:          {skipped}')
    print(f'errors:           {errors}')
    print('=' * 60)
    print('Mode:', 'DRY-RUN' if args.dry_run else 'COMMIT')


if __name__ == '__main__':
    main()