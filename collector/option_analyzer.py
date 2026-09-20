#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
option_analyzer.py — مشترک بین snapshot زنده و migration

مسئولیت‌ها:
  1. تبدیل snapshot خام → DataFrame قابل قبول برای analyze_option_chain
  2. استخراج فیلدهای تحلیلی → doc آماده برای option_history
  3. فیلتر IV برای deep ITM/OTM (پاک کردن نویز)
"""
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import pandas as pd
import algotik_tse as att


# بازه معقول برای IV (بیرون این → نویز)
IV_MONEYNESS_MIN = 0.75
IV_MONEYNESS_MAX = 1.25
IV_MIN_VALID = 0.05
IV_MAX_VALID = 5.0


def _clean_num(v: Any) -> Optional[float]:
    """pandas NA/NaN/numpy → python float یا None"""
    if v is None:
        return None
    try:
        if pd.isna(v):
            return None
    except (TypeError, ValueError):
        pass
    try:
        import numpy as np
        if isinstance(v, np.integer):
            return int(v)
        if isinstance(v, np.floating):
            f = float(v)
            return None if f != f else f
        if isinstance(v, np.bool_):
            return bool(v)
    except ImportError:
        pass
    if isinstance(v, (int, float)):
        return v
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _clean_str(v: Any) -> Optional[str]:
    if v is None:
        return None
    try:
        if pd.isna(v):
            return None
    except (TypeError, ValueError):
        pass
    s = str(v).strip()
    return s if s else None


def _parse_time(v: Any) -> Optional[datetime]:
    if v is None:
        return None
    if isinstance(v, datetime):
        return v.replace(tzinfo=timezone.utc) if v.tzinfo is None else v
    try:
        if hasattr(v, "to_pydatetime"):
            v = v.to_pydatetime()
        if isinstance(v, str):
            return datetime.fromisoformat(v.replace("Z", "+00:00"))
    except Exception:
        pass
    return None


# ============================================================
# 1) Input DF builder
# ============================================================
def build_input_df(rows: List[Dict[str, Any]]) -> pd.DataFrame:
    """
    از لیست doc های snapshot خام، DataFrame قابل قبول
    برای analyze_option_chain می‌سازه.
    """
    out = []
    for r in rows:
        bid = r.get("bid_price") or r.get("bid") or 0
        ask = r.get("ask_price") or r.get("ask") or 0
        last = r.get("last") or 0
        close = r.get("close") or 0

        if bid > 0 and ask > 0:
            price, price_source = (bid + ask) / 2, "mid"
        elif last > 0:
            price, price_source = last, "last"
        elif close > 0:
            price, price_source = close, "close"
        else:
            price, price_source = 0, "missing"

        ts = r.get("timestamp") or r.get("time") or r.get("fetchedAt")
        underlying = r.get("underlying") or r.get("basis_name")

        out.append({
            "InsCode": r.get("ins_code"),
            "Symbol": r.get("symbol"),
            "Name": r.get("name"),
            "OptionType": (r.get("option_type") or "call").lower(),
            "UnderlyingSymbol": underlying,
            "UnderlyingInsCode": r.get("underlying_ins_code"),
            "UnderlyingName": None,
            "ContractSize": r.get("contract_size") or 1000,
            "Strike": r.get("strike"),
            "EndDate": r.get("end_date") or r.get("expiry"),
            "DaysToExpiry": r.get("days_to_expiry") or r.get("daysLeft"),
            "Last": last,
            "Close": close,
            "Volume": r.get("volume") or 0,
            "TradeCount": r.get("trade_count") or r.get("trades") or 0,
            "OpenInterest": r.get("open_interest") or r.get("oi") or 0,
            "YesterdayOpenInterest": r.get("yesterday_oi") or 0,
            "BidPrice": bid,
            "AskPrice": ask,
            "BidVolume": r.get("bid_volume") or r.get("bidVol") or 0,
            "AskVolume": r.get("ask_volume") or r.get("askVol") or 0,
            "UnderlyingLast": r.get("underlying_last"),
            "UnderlyingClose": r.get("underlying_close"),
            "Price": price,
            "PriceSource": price_source,
            "AsOf": ts,
            "AsOfSource": "snapshot",
            "SnapshotFreshnessKnown": True,
            "PriceFreshnessKnown": True,
            "Stale": False,
            "NoTrade": (r.get("volume") or 0) == 0,
            "AnalyticsEligible": True,
            "AnalyticsEligibilityReason": None,
            "MetadataConflict": False,
            "Source": "algotik",
        })
    return pd.DataFrame(out)


# ============================================================
# 2) Output docs
# ============================================================
def _is_iv_reliable(strike, spot) -> bool:
    if not strike or not spot or strike <= 0 or spot <= 0:
        return False
    ratio = strike / spot
    return IV_MONEYNESS_MIN <= ratio <= IV_MONEYNESS_MAX


def _filter_iv(iv, strike, spot):
    """IV رو برمی‌گردونه فقط اگه در بازه معقول باشه"""
    if iv is None:
        return None, "missing"
    if iv < IV_MIN_VALID:
        return None, "too_low"
    if iv > IV_MAX_VALID:
        return None, "too_high"
    if not _is_iv_reliable(strike, spot):
        return None, "out_of_moneyness"
    return iv, "ok"


def _row_to_doc(row, rf_rate: float) -> Optional[Dict[str, Any]]:
    symbol = _clean_str(row.get("Symbol"))
    underlying = _clean_str(row.get("UnderlyingSymbol"))
    time_val = _parse_time(row.get("AsOf"))

    if not symbol or not underlying or not time_val:
        return None

    strike = _clean_num(row.get("Strike"))
    spot = _clean_num(row.get("Spot")) or _clean_num(row.get("UnderlyingClose"))

    iv_raw = _clean_num(row.get("ImpliedVolatilityMid")) \
             or _clean_num(row.get("ImpliedVolatility"))
    iv, iv_status = _filter_iv(iv_raw, strike, spot)

    end_date = row.get("EndDate")
    if end_date is not None and not pd.isna(end_date):
        try:
            expiry = str(end_date)[:10]
        except Exception:
            expiry = str(end_date)
    else:
        expiry = None

    return {
        # --- Identity ---
        "symbol": symbol,
        "underlying": underlying,
        "time": time_val,

        # --- Contract ---
        "strike": strike,
        "expiry": expiry,
        "daysLeft": _clean_num(row.get("DaysToExpiry")),
        "size": int(_clean_num(row.get("ContractSize")) or 1000),
        "isCall": str(row.get("OptionType", "")).lower() == "call",

        # --- Price ---
        "S": spot,
        "bid": _clean_num(row.get("BidPrice")),
        "ask": _clean_num(row.get("AskPrice")),
        "last": _clean_num(row.get("Last")),
        "close": _clean_num(row.get("Close")),
        "bidVol": _clean_num(row.get("BidVolume")),
        "askVol": _clean_num(row.get("AskVolume")),
        "oi": _clean_num(row.get("OpenInterest")),
        "volume": _clean_num(row.get("Volume")),
        "trades": _clean_num(row.get("TradeCount")),

        # --- IV (filtered) ---
        "ivApi": iv,
        "ivStatus": iv_status,
        "ivRaw": iv_raw,        # ذخیره خام برای audit
        "ivBid": _clean_num(row.get("ImpliedVolatilityBid")),
        "ivAsk": _clean_num(row.get("ImpliedVolatilityAsk")),

        # --- Greeks (per share) ---
        "deltaApi": _clean_num(row.get("Delta")),
        "gammaApi": _clean_num(row.get("Gamma")),
        "vegaApi": _clean_num(row.get("Vega")),
        "vega1Pct": _clean_num(row.get("Vega1Pct")),
        "thetaApi": _clean_num(row.get("ThetaPerDay")),
        "rhoApi": _clean_num(row.get("Rho")),

        # --- Greeks (per contract — × size) ---
        "thetaApiContract": _clean_num(row.get("ThetaPerDayContract")),
        "deltaContract": _clean_num(row.get("DeltaContract")),
        "gammaContract": _clean_num(row.get("GammaContract")),
        "vegaContract": _clean_num(row.get("VegaContract")),
        "premiumContract": _clean_num(row.get("PremiumContract")),

        # --- Liquidity / Parity ---
        "spreadPct": _clean_num(row.get("SpreadPct")),
        "spreadAbs": _clean_num(row.get("SpreadAbs")),
        "quotedDepth": _clean_num(row.get("QuotedDepth")),
        "liquidityScore": _clean_num(row.get("LiquidityScore")),
        "parityResidual": _clean_num(row.get("ParityResidual")),
        "parityStatus": _clean_str(row.get("ParityStatus")),
        "parityWithinBand": bool(row.get("ParityWithinBand")) if pd.notna(row.get("ParityWithinBand")) else None,

        # --- Context ---
        "timeToExpiry": _clean_num(row.get("TimeToExpiry")),
        "riskFreeRate": rf_rate,
        "analyticsReliability": _clean_str(row.get("AnalyticsReliability")),
        "analyticsWarning": _clean_str(row.get("AnalyticsWarning")),
        "greeksStatus": _clean_str(row.get("GreeksStatus")),

        # --- Meta ---
        "source": "algotik_analyzed",
        "analyticsVersion": "v1",
        "computedAt": datetime.now(timezone.utc),
    }


# ============================================================
# 3) Main entry
# ============================================================
def analyze_snapshot(
    rows: List[Dict[str, Any]],
    risk_free_rate: float,
) -> List[Dict[str, Any]]:
    """
    از snapshot خام → لیست doc آماده برای option_history.

    Args:
        rows: لیست doc های خام از option_snapshots_algotik
        risk_free_rate: نرخ بدون ریسک روزانه (از اخزا)

    Returns:
        لیست doc، آماده bulk_write به option_history
    """
    if not rows:
        return []

    df = build_input_df(rows)
    if df.empty:
        return []

    try:
        analysis = att.analyze_option_chain(
            df,
            risk_free_rate=risk_free_rate,
            exercise_style="european",
            allow_unverified_freshness=True,
            progress=False,
        )
    except Exception as e:
        print(f"[analyze_snapshot] analyze failed: {e}")
        analysis = df  # fallback: خام

    docs = []
    for _, row in analysis.iterrows():
        doc = _row_to_doc(row, risk_free_rate)
        if doc:
            docs.append(doc)
    return docs