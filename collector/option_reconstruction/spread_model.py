# -*- coding: utf-8 -*-
"""Spread model — learn bid-ask spread distribution by delta bucket.

Pessimistic by design:
    - Uses p40 (not median/mean) as baseline
    - Blends per-symbol + global weighted by sample count
    - Applies delta-based penalty (deep OTM/ITM widen naturally)
    - Caps final spread to [3%, 80%]

Model stored in meta.spread_model_v1:
    {
        global: {call: {bucket: stats}, put: {...}, n: int},
        per_symbol: {symbol: {call: {...}, put: {...}, n: int}},
        sampleSource: "real_only",
        scanned/used: int,
        computedAt: date,
        version: "v2-pessimistic"
    }
"""
import statistics
from datetime import datetime, timezone

from .pricing import bs_call, bs_put, get_risk_free_rate


DELTA_BUCKETS = [
    (0.00, 0.20, "0.00-0.20"),
    (0.20, 0.40, "0.20-0.40"),
    (0.40, 0.60, "0.40-0.60"),
    (0.60, 0.80, "0.60-0.80"),
    (0.80, 1.01, "0.80-1.00"),
]

# Sampling filters — reject suspicious rows
SPREAD_MIN_PCT = 0.5     # lower bound: 0.5% spread is minimum plausible
SPREAD_MAX_PCT = 60.0    # upper bound: above this is probably bad data
MIN_OI = 0               # open interest >= this
MIN_VOLUME = 0           # volume >= this

# Enrichment constraints
SPREAD_FLOOR_PCT = 3.0
SPREAD_CEIL_PCT = 80.0
DEFAULT_FALLBACK_SPREAD = 20.0

# Blend weights
SYMBOL_FULL_CONFIDENCE_N = 100  # at this many samples, weight=1.0


def _bucket_for_delta(delta_abs):
    for lo, hi, name in DELTA_BUCKETS:
        if lo <= delta_abs < hi:
            return name
    return "0.80-1.00"


def _safe_float(v, default=0.0):
    try:
        f = float(v)
        return f if f == f else default  # NaN check
    except (TypeError, ValueError):
        return default


def _compute_delta(row):
    """Return delta (or None). Prefer deltaApi, else compute from BS."""
    d = row.get("deltaApi")
    if d is not None:
        try:
            f = float(d)
            if -1.0 <= f <= 1.0 and f == f:
                return f
        except (TypeError, ValueError):
            pass

    # Fallback: compute from BS
    S = _safe_float(row.get("S"))
    K = _safe_float(row.get("strike"))
    days = _safe_float(row.get("daysLeft"))
    sigma = _safe_float(row.get("ivApi"))
    if not (S > 0 and K > 0 and days > 0):
        return None
    if sigma <= 0.01:
        sigma = 0.4
    rf = get_risk_free_rate(_safe_float(row.get("riskFreeRate")) or None)
    T = days / 365.0
    is_call = bool(row.get("isCall"))
    g = bs_call(S, K, T, rf, sigma) if is_call else bs_put(S, K, T, rf, sigma)
    return g["delta"]


def _spread_pct(row):
    """Compute spread% for a row with real bid/ask. None if invalid."""
    bid = _safe_float(row.get("bid"))
    ask = _safe_float(row.get("ask"))
    if bid <= 0 or ask <= 0 or ask <= bid:
        return None
    mid = (bid + ask) / 2.0
    if mid <= 0:
        return None
    return (ask - bid) / mid * 100.0


def _percentile(sorted_list, p):
    """Linear-interpolated percentile on a sorted list."""
    if not sorted_list:
        return None
    n = len(sorted_list)
    if n == 1:
        return sorted_list[0]
    k = (n - 1) * p
    f = int(k)
    c = min(f + 1, n - 1)
    if f == c:
        return sorted_list[f]
    return sorted_list[f] + (sorted_list[c] - sorted_list[f]) * (k - f)


def build_spread_model(db, log_fn=None, sample_limit=500000):
    """Scan option_history, compute spread distribution by delta bucket.

    Trains ONLY on real rows (source in REAL_SOURCES).
    Applies outlier filter: SPREAD_MIN..SPREAD_MAX.
    """
    if log_fn:
        log_fn("Building spread model (pessimistic v2)...")

    coll = db["option_history"]

    query = {
        "bid": {"$gt": 0},
        "ask": {"$gt": 0},
        "source": {"$in": ["algotik", "algotik_snapshot", "tsetmc_live"]},
    }

    per_symbol = {}
    global_acc = {"call": {}, "put": {}}
    for kind in ("call", "put"):
        for _, _, bname in DELTA_BUCKETS:
            global_acc[kind][bname] = []

    scanned = 0
    rejected_outlier = 0
    rejected_delta = 0
    used = 0

    cursor = coll.find(query, {
        "underlying": 1, "S": 1, "strike": 1, "daysLeft": 1,
        "ivApi": 1, "deltaApi": 1, "riskFreeRate": 1, "isCall": 1,
        "bid": 1, "ask": 1,
    }).limit(sample_limit)

    for row in cursor:
        scanned += 1
        sp = _spread_pct(row)
        if sp is None:
            continue
        # Outlier filter
        if sp < SPREAD_MIN_PCT or sp > SPREAD_MAX_PCT:
            rejected_outlier += 1
            continue

        d = _compute_delta(row)
        if d is None:
            rejected_delta += 1
            continue

        is_call = bool(row.get("isCall"))
        kind = "call" if is_call else "put"
        d_abs = abs(float(d))
        if d_abs < 0.0 or d_abs > 1.01:
            rejected_delta += 1
            continue

        bucket = _bucket_for_delta(d_abs)
        sym = row.get("underlying") or "?"

        if sym not in per_symbol:
            per_symbol[sym] = {"call": {}, "put": {}, "n": 0}
        if bucket not in per_symbol[sym][kind]:
            per_symbol[sym][kind][bucket] = []
        per_symbol[sym][kind][bucket].append(sp)
        per_symbol[sym]["n"] += 1

        global_acc[kind][bucket].append(sp)
        used += 1

    def summarize(samples):
        if not samples:
            return None
        s = sorted(samples)
        n = len(s)
        return {
            "n": n,
            "mean": round(statistics.mean(s), 3),
            "median": round(_percentile(s, 0.50), 3),
            "p25": round(_percentile(s, 0.25), 3),
            "p40": round(_percentile(s, 0.40), 3),
            "p60": round(_percentile(s, 0.60), 3),
            "p75": round(_percentile(s, 0.75), 3),
            "std": round(statistics.stdev(s), 3) if n > 1 else 0.0,
            "p10": round(_percentile(s, 0.10), 3),
            "p90": round(_percentile(s, 0.90), 3),
        }

    global_summary = {"call": {}, "put": {}, "n": used}
    for kind in ("call", "put"):
        for _, _, bname in DELTA_BUCKETS:
            summ = summarize(global_acc[kind][bname])
            if summ:
                global_summary[kind][bname] = summ

    per_symbol_summary = {}
    for sym, data in per_symbol.items():
        entry = {"n": data["n"], "call": {}, "put": {}}
        for kind in ("call", "put"):
            for _, _, bname in DELTA_BUCKETS:
                summ = summarize(data[kind].get(bname, []))
                if summ:
                    entry[kind][bname] = summ
        per_symbol_summary[sym] = entry

    model = {
        "_id": "spread_model_v1",
        "global": global_summary,
        "per_symbol": per_symbol_summary,
        "sampleSource": "real_only",
        "scanned": scanned,
        "used": used,
        "rejectedOutlier": rejected_outlier,
        "rejectedDelta": rejected_delta,
        "spreadRange": [SPREAD_MIN_PCT, SPREAD_MAX_PCT],
        "computedAt": datetime.now(timezone.utc),
        "version": "v2-pessimistic",
    }

    db["meta"].replace_one({"_id": "spread_model_v1"}, model, upsert=True)
    if log_fn:
        log_fn("  Model: scanned={} used={} rej_outlier={} rej_delta={} symbols={}".format(
            scanned, used, rejected_outlier, rejected_delta, len(per_symbol_summary)))
    return model


def load_spread_model(db):
    return db["meta"].find_one({"_id": "spread_model_v1"})


def _delta_penalty(delta_abs):
    """Pessimistic penalty by delta zone.

    Rationale:
        - Deep OTM (0-0.15): speculative, wide spread, thin quotes → +25%
        - OTM (0.15-0.30): less liquid → +12%
        - ATM (0.30-0.70): liquid, tight → +5% (still slightly pessimistic)
        - ITM (0.70-0.85): behaves like stock, tighter → -10%
        - Deep ITM (0.85+): near-intrinsic, very tight → -25%
    """
    if delta_abs < 0.15:
        return 1.25
    if delta_abs < 0.30:
        return 1.12
    if delta_abs < 0.70:
        return 1.05
    if delta_abs < 0.85:
        return 0.90
    return 0.75


def get_spread_pct(model, delta, is_call, symbol=None,
                   prefer="p40", min_n=20,
                   has_iv=True, has_delta=True):
    """Pessimistic spread estimate.

    Layers:
        1. Baseline: p40 of the matching delta bucket
        2. Blend per-symbol + global weighted by sample size
        3. Delta-zone penalty (deep OTM widens, deep ITM tightens)
        4. Extra penalty if IV/delta missing (uncertainty)
        5. Cap to [SPREAD_FLOOR, SPREAD_CEIL]

    Returns float (percent).
    """
    # 1. No model
    if model is None:
        base = DEFAULT_FALLBACK_SPREAD
    else:
        kind = "call" if is_call else "put"
        bucket = _bucket_for_delta(abs(delta))

        sym_stat = None
        if symbol:
            sym_data = (model.get("per_symbol") or {}).get(symbol)
            if sym_data:
                b = (sym_data.get(kind) or {}).get(bucket)
                if b and b.get("n", 0) >= min_n:
                    sym_stat = b

        glob_stat = (model.get("global") or {}).get(kind, {}).get(bucket)

        # 2. Blend
        if sym_stat and glob_stat:
            w = min(1.0, sym_stat["n"] / float(SYMBOL_FULL_CONFIDENCE_N))
            p_sym = float(sym_stat.get(prefer, sym_stat.get("median", DEFAULT_FALLBACK_SPREAD)))
            p_glob = float(glob_stat.get(prefer, glob_stat.get("median", DEFAULT_FALLBACK_SPREAD)))
            base = w * p_sym + (1.0 - w) * p_glob
        elif sym_stat:
            base = float(sym_stat.get(prefer, sym_stat.get("median", DEFAULT_FALLBACK_SPREAD)))
        elif glob_stat:
            base = float(glob_stat.get(prefer, glob_stat.get("median", DEFAULT_FALLBACK_SPREAD)))
        else:
            base = DEFAULT_FALLBACK_SPREAD

    # 3. Delta-zone penalty
    penalty = _delta_penalty(abs(delta))

    # 4. Uncertainty penalty
    if not has_delta:
        penalty *= 1.10  # no delta → +10%
    if not has_iv:
        penalty *= 1.08  # no IV → +8%

    result = base * penalty

    # 5. Caps
    if result < SPREAD_FLOOR_PCT:
        result = SPREAD_FLOOR_PCT
    if result > SPREAD_CEIL_PCT:
        result = SPREAD_CEIL_PCT

    return round(result, 3)
