# -*- coding: utf-8 -*-
"""Black-Scholes pricing, Greeks, implied vol, risk-free curve.

Pure functions, no external deps beyond math.
"""
import math


# ─── Normal CDF ───
def norm_cdf(x):
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def norm_pdf(x):
    return math.exp(-0.5 * x * x) / math.sqrt(2.0 * math.pi)


# ─── Black-Scholes ───
def bs_call(S, K, T, r, sigma):
    """Return dict: {price, delta, gamma, theta, vega}."""
    if T <= 0:
        intrinsic = max(S - K, 0.0)
        return {"price": intrinsic, "delta": 1.0 if S > K else 0.0,
                "gamma": 0.0, "theta": 0.0, "vega": 0.0}
    if sigma <= 0.001:
        sigma = 0.001
    sq = math.sqrt(T)
    d1 = (math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sq)
    d2 = d1 - sigma * sq
    Nd1 = norm_cdf(d1)
    Nd2 = norm_cdf(d2)
    pdf = norm_pdf(d1)
    return {
        "price": S * Nd1 - K * math.exp(-r * T) * Nd2,
        "delta": Nd1,
        "gamma": pdf / (S * sigma * sq) if S > 0 else 0.0,
        "theta": (-(S * pdf * sigma) / (2 * sq) - r * K * math.exp(-r * T) * Nd2) / 365.0,
        "vega": S * pdf * sq / 100.0,
    }


def bs_put(S, K, T, r, sigma):
    """Return dict: {price, delta, gamma, theta, vega}."""
    if T <= 0:
        intrinsic = max(K - S, 0.0)
        return {"price": intrinsic, "delta": -1.0 if S < K else 0.0,
                "gamma": 0.0, "theta": 0.0, "vega": 0.0}
    if sigma <= 0.001:
        sigma = 0.001
    sq = math.sqrt(T)
    d1 = (math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sq)
    d2 = d1 - sigma * sq
    Nd1 = norm_cdf(d1)
    Nd2 = norm_cdf(d2)
    pdf = norm_pdf(d1)
    return {
        "price": K * math.exp(-r * T) * (1 - Nd2) - S * (1 - Nd1),
        "delta": Nd1 - 1.0,
        "gamma": pdf / (S * sigma * sq) if S > 0 else 0.0,
        "theta": (-(S * pdf * sigma) / (2 * sq) + r * K * math.exp(-r * T) * (1 - Nd2)) / 365.0,
        "vega": S * pdf * sq / 100.0,
    }


def implied_vol(price, S, K, T, r, is_call=True, tol=1e-5, max_iter=60):
    """Newton-Raphson implied volatility. Returns None if impossible."""
    if T <= 0 or price <= 0 or S <= 0 or K <= 0:
        return None

    intrinsic = max(S - K, 0.0) if is_call else max(K - S, 0.0)
    if price < intrinsic * 0.999:
        return None
    if price > S * 1.5:
        return None

    sigma = 0.5
    for _ in range(max_iter):
        g = bs_call(S, K, T, r, sigma) if is_call else bs_put(S, K, T, r, sigma)
        diff = g["price"] - price
        if abs(diff) < tol:
            return sigma if 0.01 <= sigma <= 5.0 else None
        vega = g["vega"] * 100.0
        if vega < 1e-6:
            break
        sigma -= diff / vega
        if sigma < 0.01:
            sigma = 0.01
        elif sigma > 5.0:
            sigma = 5.0

    if 0.01 <= sigma <= 5.0:
        return sigma
    return None


# ─── Risk-free curve (اخزا) ───
def get_risk_free_rate(rate_from_db=None, days_to_expiry=None):
    """Return risk-free rate. Simple: flat rate from DB.
    Future: interpolate from yield curve.
    """
    if rate_from_db and 0.05 < rate_from_db < 1.0:
        return rate_from_db
    return 0.42  # Fallback: typical اخزا rate
