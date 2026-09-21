#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Wipe data older than CUTOFF_DATE.
Keeps last ~3.5 months aligned with option data availability.
Run without --confirm for dry-run."""
import sys
from datetime import datetime, timezone

sys.path.insert(0, '/opt/collector')
from pipeline.db import get_db

# 🆕 Cutoff = oldest option data (2026-06-09)
CUTOFF_DATE = datetime(2026, 6, 9, 0, 0, 0, tzinfo=timezone.utc)

# Collections with time/timestamp field → delete older than cutoff
COLLECTIONS_BY_TIME = {
    'candles_base':      'time',
    'candles_daily':     'time',
    'candles_tf':        'time',
    'option_history':    'time',
    'option_snapshots':  'timestamp',
}

# Collections to wipe completely (invalidated by data range change)
COLLECTIONS_WIPE_ALL = [
    'backtest_trade_cache',
    'signals_state',
]

# Collections to leave alone
COLLECTIONS_KEEP = [
    'option_daily_algotik',
    'option_snapshots_algotik',
    'strategy_configs',
    'monitored_symbols',
    'backtest_jobs',
    'risk_free_cache',
    'signal_history',
    'collector_log',
    'meta',
]

def main(dry_run=True):
    db = get_db()
    print("=" * 72)
    print(f"CUTOFF_DATE : {CUTOFF_DATE.isoformat()}")
    print(f"MODE        : {'DRY-RUN' if dry_run else '⚠️  LIVE DELETE'}")
    print("=" * 72)

    total_deleted = 0

    print("\n[1] Delete-by-time collections:")
    for col_name, time_field in COLLECTIONS_BY_TIME.items():
        col = db[col_name]
        total = col.estimated_document_count()
        if total == 0:
            print(f"  {col_name:25s} : empty")
            continue

        # Detect actual time field (some collections may differ)
        sample = col.find_one({})
        actual_field = None
        for f in [time_field, 'time', 'timestamp', 'date']:
            if f in sample:
                actual_field = f
                break

        if not actual_field:
            print(f"  {col_name:25s} : ⚠️ no time field (keys={list(sample.keys())[:6]})")
            continue

        old = col.count_documents({actual_field: {'$lt': CUTOFF_DATE}})
        print(f"  {col_name:25s} : {old:>8,} / {total:>8,} before cutoff (field={actual_field})")
        if not dry_run and old > 0:
            r = col.delete_many({actual_field: {'$lt': CUTOFF_DATE}})
            print(f"  {'':25s}   → deleted {r.deleted_count:,}")
            total_deleted += r.deleted_count

    print("\n[2] Wipe-all collections:")
    for col_name in COLLECTIONS_WIPE_ALL:
        col = db[col_name]
        n = col.estimated_document_count()
        print(f"  {col_name:25s} : {n:>8,} docs")
        if not dry_run and n > 0:
            r = col.delete_many({})
            print(f"  {'':25s}   → deleted {r.deleted_count:,}")
            total_deleted += r.deleted_count

    print("\n[3] Kept untouched:")
    for col_name in COLLECTIONS_KEEP:
        n = db[col_name].estimated_document_count()
        print(f"  {col_name:25s} : {n:>8,} docs")

    print("\n" + "=" * 72)
    print(f"TOTAL DELETED: {total_deleted:,}")
    if dry_run:
        print("\n⚠️  DRY-RUN — no changes were made.")
        print("   To apply: python wipe_keep_recent.py --confirm")
    else:
        print("\n✅ Wipe complete. Data now spans ~3.5 months.")
    print("=" * 72)


if __name__ == '__main__':
    dry_run = '--confirm' not in sys.argv
    main(dry_run=dry_run)