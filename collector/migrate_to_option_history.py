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


def _clean(v):
    """Convert pandas NA/NaN/numpy types to plain Python values MongoDB can store."""
    if v is None:
        return None
    # pandas NA
    try:
        import pandas as pd
        if pd.isna(v):
            return None
    except (TypeError, ValueError):
        pass
    # numpy types → python
    try:
        import numpy as np
        if isinstance(v, np.integer):
            return int(v)
        if isinstance(v, np.floating):
            f = float(v)
            return None if (f != f) else f  # NaN check
        if isinstance(v, np.bool_):
            return bool(v)
    except ImportError:
        pass
    # nested: keep only primitives
    if isinstance(v, (str, int, float, bool)):
        return v
    return str(v)  # fallback


def row_to_doc(row, underlying, ts):
    exp = row.get("EndDate")
    if exp is not None:
        try:
            exp = str(exp)[:10]
        except Exception:
            exp = str(exp)

    # 🆕 تاریخ رو هم clean کن
    doc = {
        "symbol": _clean(row.get("Symbol")),
        "underlying": underlying,
        "time": ts,
        "strike": _clean(row.get("Strike")),
        "expiry": _clean(exp),
        "daysLeft": _clean(row.get("DaysToExpiry")),
        "size": _clean(row.get("ContractSize")) or 1000,
        "isCall": str(row.get("OptionType", "")).lower() == "call",
        "S": _clean(row.get("UnderlyingClose") or row.get("UnderlyingLast")),
        "bid": _clean(row.get("BidPrice")),
        "ask": _clean(row.get("AskPrice")),
        "last": _clean(row.get("Last")),
        "close": _clean(row.get("Close")),
        "bidVol": _clean(row.get("BidVolume")),
        "askVol": _clean(row.get("AskVolume")),
        "oi": _clean(row.get("OpenInterest")),
        "volume": _clean(row.get("Volume")),
        "trades": _clean(row.get("TradeCount")),
        "ivApi": _clean(row.get("ImpliedVolatility")),
        "ivStatus": _clean(row.get("IVStatus")),
        "deltaApi": _clean(row.get("Delta")),
        "gammaApi": _clean(row.get("Gamma")),
        "vegaApi": _clean(row.get("Vega")),
        "thetaApi": _clean(row.get("ThetaPerDay")),
        "spreadPct": _clean(row.get("SpreadPct")),
        "liquidityScore": _clean(row.get("LiquidityScore")),
        "parityStatus": _clean(row.get("ParityStatus")),
        "analyticsReliability": _clean(row.get("AnalyticsReliability")),
        "riskFreeRate": _clean(row.get("RiskFreeRate")),
        "spot": _clean(row.get("Spot")),
        "source": "migrated",
        "migratedFrom": SRC_COL,
        "migratedAt": datetime.now(timezone.utc),
    }
    return doc


def main():
    args = parse_args()
    client = MongoClient(MONGO_URI)
    db = client[MONGO_DB]

    print(f"[info] src={SRC_COL} dst={DST_COL} dry-run={args.dry_run}")

    if not args.dry_run:
        try:
            db[DST_COL].create_index([("symbol", ASCENDING), ("time", ASCENDING)])
        except Exception as e:
            print(f"[warn] index symbol+time: {e}")
        try:
            db[DST_COL].create_index([("underlying", ASCENDING), ("time", ASCENDING)])
        except Exception as e:
            print(f"[warn] index underlying+time: {e}")
        try:
            db[DST_COL].create_index([("time", ASCENDING)])
        except Exception as e:
            print(f"[warn] index time: {e}")

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