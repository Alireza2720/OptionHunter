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

# --- .env loader (جایگزین: هیچ dependency نیست) ---
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
                        if not line or line.startswith("#"):
                            continue
                        if "=" not in line:
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
    return p.parse_args()


def get_risk_free(override):
    if override is not None:
        return override
    try:
        t = att.get_treasury_yields(min_volume=1)
        if t is not None and len(t) > 0:
            return float(t["EffectiveAnnualYield"].median())
    except Exception as e:
        print(f"[warn] treasury fetch failed: {e}")
    return RF_DEFAULT


def rows_to_df(rows):
    """Reconstruct AlgoTik-compatible DataFrame from flat snapshot rows."""
    out = []
    for r in rows:
        bid = r.get("bid_price") or 0
        ask = r.get("ask_price") or 0
        last = r.get("last") or 0
        close = r.get("close") or 0

        # Price logic (مشابه analyze_option_chain)
        if bid > 0 and ask > 0:
            price = (bid + ask) / 2
            price_source = "mid"
        elif last > 0:
            price = last
            price_source = "last"
        elif close > 0:
            price = close
            price_source = "close"
        else:
            price = 0
            price_source = "missing"

        ts = r.get("timestamp")
        out.append({
            "InsCode": r.get("ins_code"),
            "Symbol": r.get("symbol"),
            "Name": r.get("name"),
            "OptionType": (r.get("option_type") or "call").lower(),
            "UnderlyingSymbol": r.get("underlying"),
            "UnderlyingSymbol": r.get("underlying"),
            "UnderlyingInsCode": None,  # 🆕
            "UnderlyingName": None,      # 🆕
            "PairID": None,              # 🆕
            "PairSequence": None,        # 🆕
            "ISIN": None,                # 🆕
            "BeginDate": None,           # 🆕
            "Yesterday": r.get("yesterday") or 0,  # 🆕
            "NotionalValue": None,       # 🆕
            "ImpliedVolatility": None,   # 🆕
            "IVStatus": None,            # 🆕
            "ContractSize": r.get("contract_size") or 1000,
            "Strike": r.get("strike"),
            "EndDate": r.get("end_date"),
            "DaysToExpiry": r.get("days_to_expiry"),
            "Last": last,
            "Close": close,
            "Volume": r.get("volume") or 0,
            "TradeCount": r.get("trade_count") or 0,
            "OpenInterest": r.get("open_interest") or 0,
            "YesterdayOpenInterest": r.get("yesterday_oi") or 0,
            "BidPrice": bid,
            "AskPrice": ask,
            "BidVolume": r.get("bid_volume") or 0,
            "AskVolume": r.get("ask_volume") or 0,
            "UnderlyingLast": r.get("underlying_last"),
            "UnderlyingClose": r.get("underlying_close"),
            "Price": price,
            "PriceSource": price_source,
            "AsOf": ts,
            "AsOfSource": "snapshot",
            "SnapshotFreshnessKnown": False,
            "PriceFreshnessKnown": False,
            "Stale": False,
            "NoTrade": (r.get("volume") or 0) == 0,
            "AnalyticsEligible": True,
            "AnalyticsEligibilityReason": None,
            "MetadataConflict": False,
            "Source": "migrated",
        })
    return pd.DataFrame(out)


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
            import traceback
            print(f"[warn] analyze failed {underlying}@{ts}: {type(e).__name__}: {e}")
            traceback.print_exc()
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