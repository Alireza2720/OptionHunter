#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Full backfill: TSETMC -> MongoDB.

Usage:
    python3 backfill_tsetmc.py --full
    python3 backfill_tsetmc.py --symbols اهرم,خودرو
    python3 backfill_tsetmc.py --underlying-only
    python3 backfill_tsetmc.py --options-only
"""
import sys
import os
import argparse
import time
from datetime import datetime


sys.path.insert(0, "/opt/collector")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pipeline.db import get_db, log
from pipeline import options as opt_mod
from pipeline import stocks as stk_mod


def log_fn(msg):
    print("[{}] {}".format(datetime.now().strftime("%H:%M:%S"), msg), flush=True)
    try:
        log("backfill_tsetmc", msg)
    except Exception:
        pass


def step_underlying_daily(symbols):
    log_fn("=== Step 1: Underlying daily ({} symbols) ===".format(len(symbols)))
    total = 0
    for i, sym in enumerate(symbols, 1):
        try:
            recs, err = stk_mod.fetch_daily(sym)
            if err:
                log_fn("  [{}/{}] {}: ERROR {}".format(i, len(symbols), sym, err))
                continue
            if recs:
                n = stk_mod.write_daily(recs)
                total += n
                log_fn("  [{}/{}] {}: +{} daily".format(i, len(symbols), sym, n))
            else:
                log_fn("  [{}/{}] {}: no data".format(i, len(symbols), sym))
        except Exception as e:
            log_fn("  [{}/{}] {}: EXC {}".format(i, len(symbols), sym, e))
    return total


def step_options(symbols):
    log_fn("=== Step 2: Options ({} underlyings) ===".format(len(symbols)))
    try:
        stats = opt_mod.migrate_from_tsetmc(underlyings=symbols, log_fn=log_fn)
        log_fn("  Result: {}".format({k: v for k, v in stats.items() if k != "errors"}))
        if stats.get("errors"):
            log_fn("  Errors: {}".format(len(stats["errors"])))
        return stats
    except Exception as e:
        log_fn("  FATAL: {}".format(e))
        return {"error": str(e)}


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--full", action="store_true")
    p.add_argument("--symbols", type=str)
    p.add_argument("--underlying-only", action="store_true")
    p.add_argument("--options-only", action="store_true")
    p.add_argument("--auto-enrich", action="store_true",
                   help="After backfill, run enrichment automatically")
    args = p.parse_args()

    db = get_db()
    t0 = time.time()

    if args.symbols:
        symbols = [s.strip() for s in args.symbols.split(",") if s.strip()]
    else:
        symbols = [s["symbol"] for s in db["monitored_symbols"].find({})]

    log_fn("Backfill for {} symbols: {}".format(len(symbols), ", ".join(symbols)))

    if not args.options_only:
        step_underlying_daily(symbols)
    if not args.underlying_only:
        step_options(symbols)

    # Auto-enrichment (optional)
    if args.auto_enrich:
        log_fn("=== Auto-enrichment starting ===")
        try:
            sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
            from option_reconstruction.spread_model import load_spread_model, build_spread_model
            from option_reconstruction.enricher import enrich_collection
            if not load_spread_model(db):
                log_fn("No spread model — building first...")
                build_spread_model(db, log_fn=log_fn)
            log_fn("Running enrichment (tags dataQuality=enriched)...")
            enrich_collection(db, log_fn=log_fn)
            log_fn("=== Auto-enrichment DONE ===")
        except Exception as e:
            log_fn("Auto-enrichment FAILED: {}".format(e))

    log_fn("=== DONE in {}s ===".format(int(time.time() - t0)))


if __name__ == "__main__":
    main()

