# -*- coding: utf-8 -*-
"""Validator — holdout 20% of real data, compute enriched, compare."""
import random
from datetime import datetime, timezone

from .enricher import enrich_row
from .spread_model import load_spread_model, _safe_float


def validate(db, holdout_pct=0.20, log_fn=None, seed=42):
    """Pick 20% random real rows, enrich them, compare to real bid/ask.

    Returns stats: RMSE, MAE, MAPE on bid and ask.
    """
    random.seed(seed)
    coll = db["option_history"]
    spread_model = load_spread_model(db)

    # Sample from real rows
    real_q = {
        "bid": {"$gt": 0},
        "ask": {"$gt": 0},
        "source": {"$in": ["algotik", "algotik_snapshot", "tsetmc_live"]},
        "close": {"$gt": 0},
    }

    # Count first
    total = coll.count_documents(real_q)
    if total < 100:
        return {"error": "not enough real rows", "total": total}

    # Reservoir sample: use $sample
    target = int(total * holdout_pct)
    if log_fn:
        log_fn("Holdout: {} real rows / {} total ({}%)".format(target, total, int(holdout_pct * 100)))

    sample = list(coll.aggregate([
        {"$match": real_q},
        {"$sample": {"size": target}},
    ]))

    bid_sq_err = 0.0
    ask_sq_err = 0.0
    bid_abs_err = 0.0
    ask_abs_err = 0.0
    bid_pct_err = 0.0
    ask_pct_err = 0.0
    n = 0

    for row in sample:
        real_bid = _safe_float(row.get("bid"))
        real_ask = _safe_float(row.get("ask"))
        if real_bid <= 0 or real_ask <= 0:
            continue

        # Force re-enrichment by treating as if no bid/ask
        test_row = dict(row)
        test_row["bid"] = None
        test_row["ask"] = None
        test_row["source"] = "tsetmc_historical"  # not real

        patch = enrich_row(test_row, spread_model, symbol=row.get("underlying"))
        if not patch or patch.get("dataQuality") != "enriched":
            continue

        e_bid = _safe_float(patch.get("bid"))
        e_ask = _safe_float(patch.get("ask"))
        if e_bid <= 0 or e_ask <= 0:
            continue

        bid_sq_err += (e_bid - real_bid) ** 2
        ask_sq_err += (e_ask - real_ask) ** 2
        bid_abs_err += abs(e_bid - real_bid)
        ask_abs_err += abs(e_ask - real_ask)
        bid_pct_err += abs(e_bid - real_bid) / real_bid * 100.0
        ask_pct_err += abs(e_ask - real_ask) / real_ask * 100.0
        n += 1

    if n == 0:
        return {"error": "no valid samples"}

    import math
    result = {
        "sampleSize": n,
        "bid": {
            "RMSE": round(math.sqrt(bid_sq_err / n), 4),
            "MAE": round(bid_abs_err / n, 4),
            "MAPE": round(bid_pct_err / n, 3),
        },
        "ask": {
            "RMSE": round(math.sqrt(ask_sq_err / n), 4),
            "MAE": round(ask_abs_err / n, 4),
            "MAPE": round(ask_pct_err / n, 3),
        },
        "computedAt": datetime.now(timezone.utc).isoformat(),
    }

    # Store in meta
    db["meta"].update_one(
        {"_id": "spread_model_validation"},
        {"$set": result},
        upsert=True,
    )

    if log_fn:
        log_fn("Validation: n={} bid_MAPE={}% ask_MAPE={}%".format(
            n, result["bid"]["MAPE"], result["ask"]["MAPE"]))
    return result
