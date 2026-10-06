# -*- coding: utf-8 -*-
"""Enricher — fill missing bid/ask using pessimistic spread model.

Enrichment only. NO synthesis for symbols with zero option coverage.

Classification:
    - source == 'synthetic_daily'        → 'needs_rebuild'
    - real bid/ask, real source          → 'real' (kept unchanged)
    - has close/last but no bid/ask      → 'enrich'
    - no price at all                    → 'missing_price' (skip)

Spread lookup:
    - Uses p40 (pessimistic baseline) + delta-zone penalty
    - Extra +10%/+8% if delta/IV missing
    - Final cap [3%, 80%]
"""
from datetime import datetime, timezone

from .pricing import bs_call, bs_put, get_risk_free_rate
from .spread_model import (
    load_spread_model, get_spread_pct, _compute_delta, _safe_float,
)


REAL_SOURCES = {"algotik", "algotik_snapshot", "tsetmc_live"}
SYNTHETIC_SOURCES = {"synthetic_daily"}


def _classify(row):
    src = str(row.get("source") or "").lower()

    # Previously enriched → rebuild with current model (model may improve)
    if row.get("enrichedMethod"):
        return "needs_rebuild"

    if src in SYNTHETIC_SOURCES:
        return "needs_rebuild"

    bid = _safe_float(row.get("bid"))
    ask = _safe_float(row.get("ask"))
    if bid > 0 and ask > 0:
        return "real"

    close = _safe_float(row.get("close"))
    last = _safe_float(row.get("last"))
    if close > 0 or last > 0:
        return "enrich"

    return "missing_price"


def _base_price(row):
    close = _safe_float(row.get("close"))
    if close > 0:
        return close
    last = _safe_float(row.get("last"))
    if last > 0:
        return last
    return None


def _has_iv(row):
    v = row.get("ivApi")
    if v is None:
        return False
    try:
        f = float(v)
        return 0.01 <= f <= 5.0
    except (TypeError, ValueError):
        return False


def _has_delta(row):
    v = row.get("deltaApi")
    if v is None:
        return False
    try:
        f = float(v)
        return -1.0 <= f <= 1.0
    except (TypeError, ValueError):
        return False


def enrich_row(row, spread_model, symbol=None):
    classification = _classify(row)

    if classification == "real":
        return {"dataQuality": "real"}
    if classification == "missing_price":
        return {"dataQuality": "missing_price"}

    base = _base_price(row)
    if base is None:
        return {"dataQuality": "missing_price"}

    has_iv = _has_iv(row)
    has_delta = _has_delta(row)

    delta = _compute_delta(row)
    if delta is None:
        delta = 0.30
        has_delta = False

    is_call = bool(row.get("isCall"))

    spread_pct = get_spread_pct(
        spread_model, delta, is_call, symbol=symbol,
        prefer="p40", min_n=20,
        has_iv=has_iv, has_delta=has_delta,
    )

    half = spread_pct / 200.0
    bid = base * (1.0 - half)
    ask = base * (1.0 + half)

    # Sanity guards
    if bid <= 0:
        bid = base * 0.5
    if ask <= bid:
        ask = bid * 1.02

    src_keep = row.get("source") or ""
    if src_keep in ("", "synthetic_daily"):
        src_keep = "tsetmc_historical"

    return {
        "bid": round(bid, 4),
        "ask": round(ask, 4),
        "bidFilled": True,
        "askFilled": True,
        "dataQuality": "enriched",
        "enrichedAt": datetime.now(timezone.utc),
        "enrichedMethod": "spread_model_v2_pessimistic",
        "enrichedSpreadPct": round(spread_pct, 3),
        "enrichedDelta": round(abs(float(delta)), 4),
        "enrichedHasIv": has_iv,
        "enrichedHasDelta": has_delta,
        "source": src_keep,
    }


def enrich_collection(db, symbol=None, dry_run=False, log_fn=None, batch_size=1000):
    coll = db["option_history"]
    spread_model = load_spread_model(db)
    if spread_model is None:
        if log_fn:
            log_fn("ERROR: spread model not built. Run --build-model first.")
        return {"error": "no_spread_model"}

    q = {}
    if symbol:
        q["underlying"] = symbol

    stats = {
        "scanned": 0,
        "skipped_real": 0,
        "skipped_missing": 0,
        "enriched": 0,
        "rebuilt": 0,
        "errors": 0,
        "startedAt": datetime.now(timezone.utc).isoformat(),
    }

    if log_fn:
        log_fn("Scanning option_history (symbol={})...".format(symbol or "all"))

    batch = []
    from pymongo import UpdateOne

    cursor = coll.find(q, {
        "_id": 1, "symbol": 1, "underlying": 1, "isCall": 1,
        "strike": 1, "S": 1, "daysLeft": 1, "ivApi": 1, "deltaApi": 1,
        "riskFreeRate": 1, "bid": 1, "ask": 1, "close": 1, "last": 1,
        "source": 1,
    })

    for row in cursor:
        stats["scanned"] += 1
        classification = _classify(row)

        if classification == "real":
            stats["skipped_real"] += 1
            if row.get("dataQuality") != "real":
                batch.append(UpdateOne(
                    {"_id": row["_id"]},
                    {"$set": {"dataQuality": "real"}},
                ))
        elif classification == "missing_price":
            stats["skipped_missing"] += 1
            batch.append(UpdateOne(
                {"_id": row["_id"]},
                {"$set": {"dataQuality": "missing_price"}},
            ))
        else:
            patch = enrich_row(row, spread_model, symbol=row.get("underlying"))
            if patch and patch.get("dataQuality") == "enriched":
                if classification == "needs_rebuild":
                    stats["rebuilt"] += 1
                else:
                    stats["enriched"] += 1
                batch.append(UpdateOne({"_id": row["_id"]}, {"$set": patch}))

        if len(batch) >= batch_size:
            if not dry_run:
                try:
                    coll.bulk_write(batch, ordered=False)
                except Exception as e:
                    stats["errors"] += 1
                    if log_fn:
                        log_fn("  bulk error: {}".format(e))
            batch = []
            if stats["scanned"] % 50000 == 0:
                if log_fn:
                    log_fn("  progress: scanned={} enriched={} rebuilt={}".format(
                        stats["scanned"], stats["enriched"], stats["rebuilt"]))

    if batch and not dry_run:
        try:
            coll.bulk_write(batch, ordered=False)
        except Exception as e:
            stats["errors"] += 1

    stats["finishedAt"] = datetime.now(timezone.utc).isoformat()
    if log_fn:
        log_fn("Done. {}".format({k: v for k, v in stats.items()
                                  if k not in ("startedAt", "finishedAt")}))
    return stats

