# -*- coding: utf-8 -*-
"""Data completeness audit — verifies coverage per symbol per data type."""
from datetime import datetime, timezone, timedelta
from .db import (
    get_db, COL_CANDLES_BASE, COL_CANDLES_DAILY, COL_CANDLES_TF,
    COL_OPTION_HISTORY, COL_MONITORED,
)

TEHRAN_OFFSET = timedelta(hours=3, minutes=30)


def _business_days(from_dt, to_dt):
    """Count Sat-Wed days between two datetime (UTC)."""
    d = from_dt.date()
    end = to_dt.date()
    n = 0
    while d <= end:
        if d.weekday() in (5, 6, 0, 1, 2):  # Sat, Sun, Mon, Tue, Wed
            n += 1
        d += timedelta(days=1)
    return n


def _months_between(from_dt, to_dt):
    """Count months between two dates."""
    return (to_dt.year - from_dt.year) * 12 + (to_dt.month - from_dt.month) + 1


def audit_symbol(symbol, from_date=None, to_date=None):
    """Audit one symbol. Returns detailed coverage report."""
    db = get_db()
    result = {
        'symbol': symbol,
        'overall': 'ok',
        'issues': [],
    }

    if from_date is None:
        from_date = datetime.now(timezone.utc) - timedelta(days=730)
    if to_date is None:
        to_date = datetime.now(timezone.utc)

    expected_days = _business_days(from_date, to_date)
    expected_months = _months_between(from_date, to_date)

    result['period'] = {
        'from': from_date.isoformat()[:10],
        'to': to_date.isoformat()[:10],
        'expected_days': expected_days,
        'expected_months': expected_months,
    }

    # ---- 1. Stock 1m OHLC ----
    base_docs = list(db[COL_CANDLES_BASE].find(
        {'symbol': symbol, 'source': 'algotik_intraday', 'time': {'$gte': from_date, '$lte': to_date}},
        {'time': 1, 'open': 1, 'high': 1, 'low': 1, 'close': 1},
    ))
    base_days = set()
    base_months = set()
    flat_count = 0
    for d in base_docs:
        t = d['time']
        base_days.add((t.year, t.month, t.day))
        base_months.add((t.year, t.month))
        if d['high'] == d['low'] == d['open'] == d['close']:
            flat_count += 1

    base_cov = (len(base_days) / expected_days * 100) if expected_days > 0 else 0
    base_month_cov = (len(base_months) / expected_months * 100) if expected_months > 0 else 0
    flat_pct = (flat_count / len(base_docs) * 100) if base_docs else 0

    result['stock_1m'] = {
        'total_candles': len(base_docs),
        'days': len(base_days),
        'day_coverage_pct': round(base_cov, 1),
        'months': len(base_months),
        'month_coverage_pct': round(base_month_cov, 1),
        'flat_count': flat_count,
        'flat_pct': round(flat_pct, 1),
    }
    if base_month_cov < 90:
        result['issues'].append('stock_1m month coverage {:.0f}% < 90%'.format(base_month_cov))

    # ---- 2. Stock Daily ----
    daily_docs = list(db[COL_CANDLES_DAILY].find(
        {'symbol': symbol, 'time': {'$gte': from_date, '$lte': to_date}},
        {'time': 1, 'close': 1},
    ))
    daily_days = set((d['time'].year, d['time'].month, d['time'].day) for d in daily_docs)
    daily_months = set((d['time'].year, d['time'].month) for d in daily_docs)
    daily_cov = (len(daily_days) / expected_days * 100) if expected_days > 0 else 0
    daily_month_cov = (len(daily_months) / expected_months * 100) if expected_months > 0 else 0

    result['stock_daily'] = {
        'total': len(daily_docs),
        'days': len(daily_days),
        'day_coverage_pct': round(daily_cov, 1),
        'months': len(daily_months),
        'month_coverage_pct': round(daily_month_cov, 1),
    }
    if daily_month_cov < 90:
        result['issues'].append('stock_daily month coverage {:.0f}% < 90%'.format(daily_month_cov))

    # ---- 3. TF Aggregates ----
    tf_stats = {}
    for tf in ['15m', '30m', '1h']:
        cnt = db[COL_CANDLES_TF].count_documents({
            'symbol': symbol, 'tf': tf,
            'time': {'$gte': from_date, '$lte': to_date},
        })
        tf_stats[tf] = cnt
    result['tf'] = tf_stats

    # ---- 4. Option History ----
    opt_docs = list(db[COL_OPTION_HISTORY].find(
        {'underlying': symbol, 'time': {'$gte': from_date, '$lte': to_date}},
        {'time': 1, 'ivApi': 1, 'deltaApi': 1, 'bid': 1, 'ask': 1, 'oi': 1, 'strike': 1},
    ))
    opt_total = len(opt_docs)
    opt_with_iv = sum(1 for d in opt_docs if d.get('ivApi') and d['ivApi'] > 0)
    opt_with_delta_range = sum(1 for d in opt_docs if d.get('deltaApi') and 0.4 <= d['deltaApi'] <= 0.75)
    opt_with_bid_ask = sum(1 for d in opt_docs if (d.get('bid') or 0) > 0 and (d.get('ask') or 0) > 0)

    opt_months = set((d['time'].year, d['time'].month) for d in opt_docs)
    opt_month_cov = (len(opt_months) / expected_months * 100) if expected_months > 0 else 0

    result['option'] = {
        'total': opt_total,
        'with_iv': opt_with_iv,
        'iv_pct': round(opt_with_iv / opt_total * 100, 1) if opt_total else 0,
        'with_bid_ask': opt_with_bid_ask,
        'bid_ask_pct': round(opt_with_bid_ask / opt_total * 100, 1) if opt_total else 0,
        'in_delta_range': opt_with_delta_range,
        'months': len(opt_months),
        'month_coverage_pct': round(opt_month_cov, 1),
    }

    if opt_month_cov < 60:
        result['issues'].append('option month coverage {:.0f}% < 60%'.format(opt_month_cov))
    if opt_total > 0 and opt_with_iv / opt_total < 0.20:
        result['issues'].append('option IV coverage only {:.0f}%'.format(result['option']['iv_pct']))
    if opt_total > 0 and opt_with_delta_range < 100:
        result['issues'].append('delta-range contracts only {}'.format(opt_with_delta_range))

    # ---- Overall ----
    critical_issues = [i for i in result['issues'] if '0%' in i or '< 30%' in i or 'only 0' in i]
    if critical_issues or not base_docs:
        result['overall'] = 'critical'
    elif len(result['issues']) > 0:
        result['overall'] = 'warn'

    return result


def audit_all(symbols=None, days=730):
    """Audit all symbols (or specific list). Returns summary + per-symbol."""
    db = get_db()
    if not symbols:
        symbols = [s['symbol'] for s in db[COL_MONITORED].find({})]

    to_date = datetime.now(timezone.utc)
    from_date = to_date - timedelta(days=days)

    reports = []
    summary = {'ok': 0, 'warn': 0, 'critical': 0}
    for sym in symbols:
        try:
            r = audit_symbol(sym, from_date, to_date)
            reports.append(r)
            summary[r['overall']] = summary.get(r['overall'], 0) + 1
        except Exception as e:
            reports.append({'symbol': sym, 'overall': 'critical', 'error': str(e)})
            summary['critical'] += 1

    return {
        'at': datetime.now(timezone.utc).isoformat(),
        'period_days': days,
        'from': from_date.isoformat()[:10],
        'to': to_date.isoformat()[:10],
        'summary': summary,
        'symbols': reports,
    }