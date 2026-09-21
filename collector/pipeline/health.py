# -*- coding: utf-8 -*-
"""Health checks — focus on real issues, not natural market phenomena."""
from datetime import datetime, timezone
from .db import get_db, COL_CANDLES_TF, COL_OPTION_HISTORY, COL_MONITORED


def check_all():
    """Run all health checks. Returns dict with results and overall status."""
    db = get_db()
    checks = {}

    # 1. Symbols
    try:
        total_sym = db[COL_MONITORED].count_documents({})
        enabled_sym = db[COL_MONITORED].count_documents({'enabled': True})
        checks['symbols'] = {
            'ok': total_sym > 0 and enabled_sym > 0,
            'total': total_sym,
            'enabled': enabled_sym,
            'severity': 'critical' if total_sym == 0 else ('warn' if enabled_sym == 0 else 'ok'),
        }
    except Exception as e:
        checks['symbols'] = {'ok': False, 'error': str(e), 'severity': 'critical'}

    # 2. Stock 15m quality
    # flat در بورس ایران طبیعی است (صف خرید/فروش، دامنه نوسان)
    # فقط مقادیر خیلی بالا (>90%) هشدار
    try:
        total_15 = db[COL_CANDLES_TF].count_documents({'tf': '15m'})
        flat_15 = db[COL_CANDLES_TF].count_documents({
            'tf': '15m',
            '$expr': {'$and': [
                {'$eq': ['$open', '$high']},
                {'$eq': ['$high', '$low']},
                {'$eq': ['$low', '$close']},
            ]}
        })
        ratio = (flat_15 / total_15 * 100) if total_15 > 0 else 0
        if total_15 == 0:
            sev, note = 'critical', 'هیچ کندل 15m نیست'
        elif ratio > 97:
            sev, note = 'critical', 'تقریباً همه flat — نماد احتمالاً معامله نشده'
        elif ratio > 90:
            sev, note = 'warn', 'flat بالاست — بررسی شود'
        elif ratio > 70:
            sev, note = 'info', 'طبیعی — احتمالاً صف‌های زیاد'
        else:
            sev, note = 'ok', 'نرمال'
        checks['stock_15m'] = {
            'ok': total_15 > 0 and ratio <= 97,
            'total': total_15,
            'flat': flat_15,
            'flatRatio': round(ratio, 1),
            'note': note,
            'severity': sev,
        }
    except Exception as e:
        checks['stock_15m'] = {'ok': False, 'error': str(e), 'severity': 'critical'}

    # 3. Option data quality
    try:
        total = db[COL_OPTION_HISTORY].count_documents({})
        with_iv = db[COL_OPTION_HISTORY].count_documents({'ivApi': {'$gt': 0}})
        in_delta = db[COL_OPTION_HISTORY].count_documents({'deltaApi': {'$gte': 0.4, '$lte': 0.75}})
        iv_ratio = (with_iv / total * 100) if total > 0 else 0
        if total < 100:
            sev = 'critical'
        elif iv_ratio < 10 or in_delta < 50:
            sev = 'warn'
        else:
            sev = 'ok'
        checks['option_data'] = {
            'ok': total >= 100 and iv_ratio >= 10 and in_delta >= 50,
            'total': total,
            'withIV': with_iv,
            'ivRatio': round(iv_ratio, 1),
            'inDeltaRange': in_delta,
            'severity': sev,
        }
    except Exception as e:
        checks['option_data'] = {'ok': False, 'error': str(e), 'severity': 'critical'}

    # 4. Risk-free
    try:
        rf_doc = db['risk_free_cache'].find_one({}, sort=[('date', -1)])
        if rf_doc:
            rate = float(rf_doc.get('rate', 0))
            ok = 0.1 < rate < 1.0
            checks['risk_free'] = {
                'ok': ok,
                'rate': round(rate, 4),
                'date': rf_doc.get('date'),
                'severity': 'ok' if ok else 'warn',
            }
        else:
            checks['risk_free'] = {'ok': False, 'error': 'خالی', 'severity': 'warn'}
    except Exception as e:
        checks['risk_free'] = {'ok': False, 'error': str(e), 'severity': 'warn'}

    # Overall
    severities = [c.get('severity', 'ok') for c in checks.values()]
    if 'critical' in severities:
        overall = 'critical'
    elif 'warn' in severities:
        overall = 'warn'
    else:
        overall = 'ok'

    return {
        'at': datetime.now(timezone.utc).isoformat(),
        'overall': overall,
        'checks': checks,
    }