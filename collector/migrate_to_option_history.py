#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Migration: option_snapshots_algotik → option_history
Adds IV, Greeks, and analysis via algotik-tse's analyze_option_chain.

Usage (on server):
    /opt/collector/venv/bin/python migrate_to_option_history.py --dry-run
    /opt/collector/venv/bin/python migrate_to_option_history.py
"""
import os
import argparse
from datetime import datetime, timezone

import algotik_tse as att
import pandas as pd
from pymongo import MongoClient, UpdateOne, ASCENDING

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
    return p.parse_args()


def get_risk_free(override):
    if override is not None:
        return override
    try:
        t = att.get_treasury_yields(min_volume=1, progress=False)
        if t is not None and len(t) > 0:
            return float(t["EffectiveAnnualYield"].median())
    except Exception as e:
        print(f"[warn] treasury fetch failed: {e}")
    return RF_DEFAULT


def rows_to_df(rows):
    """Reconstruct AlgoTik-compatible DataFrame from flat snapshot rows."""
    return pd.DataFrame([{
        "InsCode": r.get("ins_code"),
        "Symbol": r.get("symbol"),
        "Name": r.get("name"),
        "OptionType": (r.get("option_type") or "call").lower(),
        "UnderlyingSymbol": r.get("underlying"),
        "ContractSize": r.get("contract_size") or 1000,
        "Strike": r.get("strike"),
        "EndDate": r.get("end_date"),
        "DaysToExpiry": r.get("days_to_expiry"),
        "Last": r.get("last"),
        "Close": r.get("close"),
        "Volume": r.get("volume"),
        "TradeCount": r.get("trade_count"),
        "OpenInterest": r.get("open_interest"),
        "BidPrice": r.get("bid_price"),
        "AskPrice": r.get("ask_price"),
        "BidVolume": r.get("bid_volume"),
        "AskVolume": r.get("ask_volume"),
        "UnderlyingLast": r.get("underlying_last"),
        "UnderlyingClose": r.get("underlying_close"),
    } for r in rows])


def row_to_doc(row, underlying, ts):
    exp = row.get("EndDate")
    if exp is not None:
        try:
            exp = str(exp)[:10]
        except Exception:
            exp = str(exp)
    return {
        "symbol": row.get("Symbol"),
        "underlying": underlying,
        "time": ts,
        "strike": row.get("Strike"),
        "expiry": exp,
        "daysLeft": row.get("DaysToExpiry"),
        "size": row.get("ContractSize") or 1000,
        "isCall": str(row.get("OptionType", "")).lower() == "call",
        "S": row.get("UnderlyingClose") or row.get("UnderlyingLast"),
        "bid": row.get("BidPrice"),
        "ask": row.get("AskPrice"),
        "last": row.get("Last"),
        "close": row.get("Close"),
        "bidVol": row.get("BidVolume"),
        "askVol": row.get("AskVolume"),
        "oi": row.get("OpenInterest"),
        "volume": row.get("Volume"),
        "trades": row.get("TradeCount"),
        "ivApi": row.get("ImpliedVolatility"),
        "ivStatus": row.get("IVStatus"),
        "deltaApi": row.get("Delta"),
        "gammaApi": row.get("Gamma"),
        "vegaApi": row.get("Vega"),
        "thetaApi": row.get("ThetaPerDay"),
        "spreadPct": row.get("SpreadPct"),
        "liquidityScore": row.get("LiquidityScore"),
        "parityStatus": row.get("ParityStatus"),
        "analyticsReliability": row.get("AnalyticsReliability"),
        "riskFreeRate": row.get("RiskFreeRate"),
        "spot": row.get("Spot"),
        "source": "migrated",
        "migratedFrom": SRC_COL,
        "migratedAt": datetime.now(timezone.utc),
    }


def main():
    args = parse_args()
    client = MongoClient(MONGO_URI)
    db = client[MONGO_DB]

    print(f"[info] src={SRC_COL} dst={DST_COL} dry-run={args.dry_run}")

    if not args.dry_run:
        db[DST_COL].create_index([("symbol", ASCENDING), ("time", ASCENDING)], unique=True)
        db[DST_COL].create_index([("underlying", ASCENDING), ("time", ASCENDING)])
        db[DST_COL].create_index([("time", ASCENDING)])

    rf = get_risk_free(args.rf)
    print(f"[info] risk-free rate = {rf:.4f}")

    pipeline = [
        {"$group": {
            "_id": {"u": "$underlying", "t": "$timestamp"},
            "rows": {"$push": "$$ROOT"},
        }},
        {"$sort": {"_id.t": 1}},
    ]

    groups = contracts = written = errors = 0
    ops = []

    for grp in db[SRC_COL].aggregate(pipeline, allowDiskUse=True):
        groups += 1
        if args.limit and groups > args.limit:
            break

        underlying = grp["_id"]["u"]
        ts_raw = grp["_id"]["t"]

        try:
            ts = datetime.fromisoformat(ts_raw.replace("Z", "+00:00")) if isinstance(ts_raw, str) else ts_raw
        except Exception as e:
            print(f"[warn] bad ts {ts_raw}: {e}")
            errors += 1
            continue

        try:
            df = rows_to_df(grp["rows"])
        except Exception as e:
            print(f"[warn] df build failed {underlying}@{ts}: {e}")
            errors += 1
            continue

        try:
            analysis = att.analyze_option_chain(
                df,
                risk_free_rate=rf,
                exercise_style="european",
                allow_unverified_freshness=True,
                progress=False,
            )
        except Exception as e:
            print(f"[warn] analyze failed {underlying}@{ts}: {e}")
            analysis = df
            errors += 1

        for _, row in analysis.iterrows():
            doc = row_to_doc(row, underlying, ts)
            ops.append(UpdateOne(
                {"symbol": doc["symbol"], "time": doc["time"]},
                {"$set": doc},
                upsert=True,
            ))
            contracts += 1

        if len(ops) >= 500:
            if not args.dry_run:
                try:
                    res = db[DST_COL].bulk_write(ops, ordered=False)
                    written += res.upserted_count + res.modified_count
                except Exception as e:
                    print(f"[error] bulk write: {e}")
            ops = []
            print(f"[progress] groups={groups} contracts={contracts} written={written}")

    if ops and not args.dry_run:
        try:
            res = db[DST_COL].bulk_write(ops, ordered=False)
            written += res.upserted_count + res.modified_count
        except Exception as e:
            print(f"[error] final bulk: {e}")

    print("\n" + "=" * 60)
    print(f"groups processed:  {groups}")
    print(f"contracts built:   {contracts}")
    print(f"written:           {written}")
    print(f"errors:            {errors}")
    print("=" * 60)
    print("Mode:", "DRY-RUN" if args.dry_run else "COMMIT")


if __name__ == "__main__":
    main()