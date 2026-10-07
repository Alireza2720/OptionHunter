#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""test_chain_compare.py — Compare our enriched chain with optionschool24.

Usage (on server):
    cd /opt/collector
    /opt/collector/venv/bin/python scripts/test_chain_compare.py

Or from repo root:
    python collector/scripts/test_chain_compare.py
"""

import sys
import os
import json
import urllib.request

# Ensure collector root is on sys.path
_HERE = os.path.dirname(os.path.abspath(__file__))
_COLLECTOR = os.path.dirname(_HERE)
sys.path.insert(0, _COLLECTOR)
sys.path.insert(0, "/opt/collector")

try:
    from pipeline import option_greeks as og
    from pipeline.db import get_db
except Exception as e:
    print("FATAL: cannot import collector modules: " + str(e))
    sys.exit(1)


def fetch_school():
    """Fetch the raw optionschool24 chain."""
    req = urllib.request.Request(
        "https://s3.optionschool24.com/last?type=3",
        headers={"User-Agent": "Mozilla/5.0"},
    )
    with urllib.request.urlopen(req, timeout=25) as r:
        return json.loads(r.read().decode("utf-8"))


def _f(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def main():
    print("=" * 62)
    print("  Chain Comparison — ours (TSETMC) vs optionschool24")
    print("=" * 62)
    print()

    print("[1/3] Computing our enriched chain...")
    try:
        ours = og.compute_enriched_chain()
        print("      → {} contracts".format(len(ours)))
    except Exception as e:
        import traceback
        print("      FAILED: " + str(e))
        traceback.print_exc()
        ours = []

    print()
    print("[2/3] Fetching optionschool24...")
    try:
        theirs = fetch_school()
        print("      → {} contracts".format(len(theirs)))
    except Exception as e:
        print("      FAILED: " + str(e))
        theirs = []

    print()
    print("[3/3] Comparing common contracts...")

    our_map = {o["name"]: o for o in ours if o.get("name")}
    their_map = {t.get("name"): t for t in theirs if t.get("name")}
    common = sorted(set(our_map) & set(their_map))

    print("      Our:     {}".format(len(our_map)))
    print("      Theirs:  {}".format(len(their_map)))
    print("      Common:  {}".format(len(common)))
    print()

    if not common:
        print("No common contracts to compare. Check that:")
        print("  • both sources have active options today")
        print("  • contract tickers match exactly")
        return

    # Compare key metrics
    diffs = {"imp": [], "delta": [], "gamma": [], "theta": [],
             "vega": [], "black_sholes": []}

    for name in common:
        o, t = our_map[name], their_map[name]
        for f in diffs:
            ov = _f(o.get(f))
            tv = _f(t.get(f))
            if ov != 0 and tv != 0:
                rel = abs(ov - tv) / max(abs(tv), 1e-6)
                diffs[f].append(rel)

    print("{:14s} {:>6s}  {:>8s}  {:>8s}  {:>8s}  {:>6s}".format(
        "field", "n", "avg", "p50", "p90", ">15%"))
    print("-" * 62)
    for f, arr in diffs.items():
        if not arr:
            continue
        arr.sort()
        avg = sum(arr) / len(arr)
        p50 = arr[len(arr) // 2]
        p90 = arr[int(len(arr) * 0.9)]
        bad = sum(1 for r in arr if r > 0.15)
        print("{:14s} {:>6d}  {:>7.2%}  {:>7.2%}  {:>7.2%}  {:>6d}".format(
            f, len(arr), avg, p50, p90, bad))

    print()
    print("Sample (first 5 common):")
    print("-" * 62)
    for name in common[:5]:
        o, t = our_map[name], their_map[name]
        print("  " + name)
        print("    ours   : imp={:>6} delta={:>7} bs={:>8} S={:>10}".format(
            o.get("imp", 0), o.get("delta", 0), o.get("black_sholes", 0), o.get("basis", 0)))
        print("    theirs : imp={:>6} delta={:>7} bs={:>8} S={:>10}".format(
            t.get("imp", 0), t.get("delta", 0), t.get("black_sholes", 0), t.get("basis", 0)))

    print()
    print("=" * 62)
    print("  Interpretation:")
    print("  • If 'avg' and 'p50' are small (< 10%) for imp/delta → our")
    print("    model matches theirs. Ready for Phase 2.")
    print("  • If large differences → check delta tolerance, IV solver,")
    print("    or dividend/rate assumptions.")
    print("=" * 62)


if __name__ == "__main__":
    main()