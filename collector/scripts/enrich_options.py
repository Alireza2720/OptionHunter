#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Enrichment CLI.

Usage:
    python3 enrich_options.py --build-model
    python3 enrich_options.py --enrich
    python3 enrich_options.py --enrich --symbol اهرم
    python3 enrich_options.py --validate
    python3 enrich_options.py --status
    python3 enrich_options.py --dry-run --enrich
"""
import sys
import os
import argparse
import time
from datetime import datetime

sys.path.insert(0, "/opt/collector")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pipeline.db import get_db, log
from option_reconstruction.spread_model import build_spread_model
from option_reconstruction.enricher import enrich_collection
from option_reconstruction.validator import validate


def log_fn(msg):
    print("[{}] {}".format(datetime.now().strftime("%H:%M:%S"), msg), flush=True)
    try:
        log("enrich_options", msg)
    except Exception:
        pass


def show_status(db):
    log_fn("── Status ──")
    total = db["option_history"].count_documents({})
    log_fn("  option_history total: {}".format(total))

    by_dq = list(db["option_history"].aggregate([
        {"$group": {"_id": "$dataQuality", "n": {"$sum": 1}}},
        {"$sort": {"n": -1}},
    ]))
    for r in by_dq:
        log_fn("  dataQuality={} : {}".format(r["_id"], r["n"]))

    by_src = list(db["option_history"].aggregate([
        {"$group": {"_id": "$source", "n": {"$sum": 1}}},
        {"$sort": {"n": -1}},
    ]))
    log_fn("── Sources ──")
    for r in by_src:
        log_fn("  source={} : {}".format(r["_id"], r["n"]))

    model = db["meta"].find_one({"_id": "spread_model_v1"})
    if model:
        log_fn("── Spread model ──")
        log_fn("  computedAt: {}".format(model.get("computedAt")))
        log_fn("  scanned:    {}".format(model.get("scanned")))
        log_fn("  used:       {}".format(model.get("used")))
        log_fn("  symbols:    {}".format(len(model.get("per_symbol") or {})))

    val = db["meta"].find_one({"_id": "spread_model_validation"})
    if val:
        log_fn("── Validation ──")
        log_fn("  n={}  bid MAPE={}%  ask MAPE={}%".format(
            val.get("sampleSize"),
            val.get("bid", {}).get("MAPE"),
            val.get("ask", {}).get("MAPE")))


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--build-model", action="store_true")
    p.add_argument("--enrich", action="store_true")
    p.add_argument("--validate", action="store_true")
    p.add_argument("--status", action="store_true")
    p.add_argument("--symbol", type=str)
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args()

    if not any([args.build_model, args.enrich, args.validate, args.status]):
        p.print_help()
        return

    db = get_db()
    t0 = time.time()

    if args.status:
        show_status(db)

    if args.build_model:
        log_fn("=== Building spread model ===")
        build_spread_model(db, log_fn=log_fn)

    if args.enrich:
        log_fn("=== Enriching (dry_run={}) ===".format(args.dry_run))
        enrich_collection(db, symbol=args.symbol, dry_run=args.dry_run, log_fn=log_fn)

    if args.validate:
        log_fn("=== Validating (20% holdout) ===")
        validate(db, log_fn=log_fn)

    log_fn("=== DONE in {}s ===".format(int(time.time() - t0)))


if __name__ == "__main__":
    main()
