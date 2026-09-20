#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Migration v2: option_snapshots_algotik → option_history
از option_analyzer.py استفاده می‌کنه (فیلتر IV + Greeks کامل).

Usage:
    python migrate_to_option_history.py --dry-run
    python migrate_to_option_history.py
"""
import os
import argparse
from datetime import datetime, timezone

from pymongo import MongoClient, UpdateOne, ASCENDING

from option_analyzer import analyze_snapshot


# --- .env loader ---
def _load_dotenv():
    for path in [
        os.path.join(os.path.dirname(__file__), "..", ".env"),
        os.path.join(os.getcwd(), ".env"),
        "/home/deploy/apps/OptionHunter/.env",
    ]:
        try:
            if os.path.exists(path):
                with open(path, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if not line or line.startswith("#") or "=" not in line:
                            continue
                        k, v = line.split("=", 1)
                        k, v = k.strip(), v.strip()
                        if len(v) >= 2 and v[0] == v[-1] and v[0] in ("'", '"'):
                            v = v[1:-1]
                        if k and k not in os.environ:
                            os.environ[k] = v
                return
        except Exception:
            pass


_load_dotenv()

MONGO_URI = os.getenv("MONGO_URI", "mongodb://127.0.0.1:27017")
MONGO_DB = os.getenv("MONGO_DB", "trading_bot")

SRC_COL = "option_snapshots_algotik"
DST_COL = "option_history"
RF_DEFAULT = 0.42


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--limit", type=int, default=0, help="max groups (0=all)")
    p.add_argument("--rf", type=float, default=None)
    p.add_argument("--purge-old", action="store_true",
                   help="delete existing source=migrated docs before writing")
    return p.parse_args()


def get_risk_free(override):
    if override is not None:
        return override
    try:
        import algotik_tse as att
        t = att.get_treasury_yields(min_volume=1)
        if t is not None and len(t) > 0:
            return float(t["EffectiveAnnualYield"].median())
    except Exception as e:
        print(f"[warn] treasury fetch failed: {e}")
    return RF_DEFAULT


def main():
    args = parse_args()
    client = MongoClient(MONGO_URI)
    db = client[MONGO_DB]

    print(f"[info] src={SRC_COL} dst={DST_COL} dry-run={args.dry_run}")

    if not args.dry_run:
        # index امن (بدون unique)
        for idx in [
            [("symbol", ASCENDING), ("time", ASCENDING)],
            [("underlying", ASCENDING), ("time", ASCENDING)],
            [("time", ASCENDING)],
        ]:
            try:
                db[DST_COL].create_index(idx)
            except Exception as e:
                print(f"[warn] index {idx}: {e}")

    # Purge قدیمی‌ها (اگه خواستی)
    if args.purge_old and not args.dry_run:
        r = db[DST_COL].deleteMany({"source": "migrated"})
        print(f"[purge] deleted {r.deleted_count} old migrated docs")

    rf = get_risk_free(args.rf)
    print(f"[info] risk-free rate = {rf:.4f}")

    pipeline = [
        {"$group": {
            "_id": {"u": "$underlying", "t": "$timestamp"},
            "rows": {"$push": "$$ROOT"},
        }},
        {"$sort": {"_id.t": 1}},
    ]

    groups = total_docs = written = errors = 0
    ops = []

    for grp in db[SRC_COL].aggregate(pipeline, allowDiskUse=True):
        groups += 1
        if args.limit and groups > args.limit:
            break

        underlying = grp["_id"]["u"]
        ts_raw = grp["_id"]["t"]

        try:
            ts = datetime.fromisoformat(ts_raw.replace("Z", "+00:00")) \
                 if isinstance(ts_raw, str) else ts_raw
        except Exception as e:
            print(f"[warn] bad ts {ts_raw}: {e}")
            errors += 1
            continue

        # normalize rows: timestamp → time + underlying
        rows = []
        for r in grp["rows"]:
            r2 = dict(r)
            r2.setdefault("timestamp", ts)
            r2.setdefault("underlying", underlying)
            rows.append(r2)

        try:
            docs = analyze_snapshot(rows, risk_free_rate=rf)
        except Exception as e:
            print(f"[error] analyze_snapshot failed for {underlying}@{ts}: {e}")
            errors += 1
            continue

        # override source
        for d in docs:
            d["source"] = "migrated_v2"
            d["migratedAt"] = datetime.now(timezone.utc)

        total_docs += len(docs)

        for d in docs:
            ops.append(UpdateOne(
                {"symbol": d["symbol"], "time": d["time"]},
                {"$set": d},
                upsert=True,
            ))

        if len(ops) >= 500:
            if not args.dry_run:
                try:
                    res = db[DST_COL].bulk_write(ops, ordered=False)
                    written += res.upserted_count + res.modified_count
                except Exception as e:
                    print(f"[error] bulk write: {e}")
            ops = []
            print(f"[progress] groups={groups} docs={total_docs} written={written}")

    if ops and not args.dry_run:
        try:
            res = db[DST_COL].bulk_write(ops, ordered=False)
            written += res.upserted_count + res.modified_count
        except Exception as e:
            print(f"[error] final bulk: {e}")

    print("\n" + "=" * 60)
    print(f"groups processed:  {groups}")
    print(f"docs built:        {total_docs}")
    print(f"written:           {written}")
    print(f"errors:            {errors}")
    print("=" * 60)
    print("Mode:", "DRY-RUN" if args.dry_run else "COMMIT")


if __name__ == "__main__":
    main()