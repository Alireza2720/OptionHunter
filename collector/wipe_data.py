#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Wipe all data collections. Requires --confirm flag."""
import sys
sys.path.insert(0, '/opt/collector')
from pipeline.db import get_db

COLLECTIONS = [
    'candles_base', 'candles_daily', 'candles_tf',
    'option_history', 'option_snapshots',
    'backtest_trade_cache', 'backtest_jobs', 'backtest_result_cache',
    'signals_state', 'signal_history',
]

if __name__ == '__main__':
    if '--confirm' not in sys.argv:
        print('Usage: python wipe_data.py --confirm')
        print('This deletes:', COLLECTIONS)
        sys.exit(1)
    db = get_db()
    for col in COLLECTIONS:
        r = db[col].delete_many({})
        print(f'{col}: {r.deleted_count} deleted')
    print('✅ wipe complete')