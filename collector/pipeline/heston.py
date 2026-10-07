# -*- coding: utf-8 -*-
"""heston.py — Stochastic Volatility option pricing (Heston 1993).

Advanced pricing model as an alternative to Black-Scholes.
Uses the "Little Trap" characteristic function formulation from
Albrecher et al. (2007) to avoid branch-cut issues.

Public API:
    price_call(S, K, T, r, heston_params)  -> dict {price, delta, gamma, theta, vega}
    implied_heston_vol(...)                -> float (equivalent vol)

Default parameters are calibrated to typical Tehran market conditions.
Callers can override per-contract or globally.
"""

import math

DEFAULT_HESTON = {
    # v0: initial variance (σ_init² ≈ 0.45² for TSE)
    "v0": 0.20,
    # theta: long-term mean variance
    "theta": 0.25,
    # kappa: mean-reversion speed
    "kappa": 2.0,
    # sigma: vol-of-vol
    "sigma": 0.5,
    # rho: correlation between asset and vol
    "rho": -0.7,
}


def _char_func(u, T, r, S, K, p):
    """Heston characteristic function (Albrecher "little trap").

    Returns complex φ(u) for φ(u) = E[e^{iu·log(S_T)}].
    """
    v0 = p["v0"]
    theta = p["theta"]
    kappa = p["kappa"]
    sigma = p["sigma"]
    rho = p["rho"]

    iu = 1j * u
    # "Little Trap" formulation
    d = math.sqrt((rho * sigma * iu - kappa) ** 2 + sigma * sigma * (iu + u * u))
    # Use the sign that gives positive real part
    if (rho * sigma * iu - kappa).real >= 0:
        g = (rho * sigma * iu - kappa + d) / (rho * sigma * iu - kappa - d)
    else:
        g = (rho * sigma * iu - kappa - d) / (rho * sigma * iu - kappa + d)

    exp_dT = _safe_exp(-d * T)

    C = (kappa * theta / (sigma * sigma)) * (
        (rho * sigma * iu - kappa + d) * T
        - 2 * _safe_log((1 - g * exp_dT) / (1 - g))
    )
    D = ((rho * sigma * iu - kappa + d) / (sigma * sigma)) * (
        (1 - exp_dT) / (1 - g * exp_dT)
    )

    return _safe_exp(iu * (math.log(S / K)) + C + D * v0)


def _safe_exp(z):
    """Complex-safe exp with overflow guard."""
    try:
        return _cx_exp(z)
    except OverflowError:
        # Fall back to polar form with clamped exponent
        r = z.real if hasattr(z, "real") else z
        im = z.imag if hasattr(z, "imag") else 0
        r = max(-500, min(500, r))
        return _cx_exp(complex(r, im))


def _cx_exp(z):
    return complex(math.cos(z.imag), math.sin(z.imag)) * math.exp(z.real)


def _safe_log(z):
    """Complex-safe log with magnitude guard."""
    if z == 0:
        return complex(math.log(1e-300), 0)
    return _cx_log(z)


def _cx_log(z):
    r = abs(z)
    if r < 1e-300:
        r = 1e-300
    return complex(math.log(r), math.atan2(z.imag, z.real))


def _heston_probability(u, T, r, S, K, p, j):
    """P_j characteristic function for Carr-Madan integral."""
    iu = 1j * u
    # For j=1: φ(u-i) / φ(-i);  for j=2: φ(u)   (standard Heston)
    if j == 1:
        num = _char_func(u - 1j, T, r, S, K, p)
        den = _char_func(-1j, T, r, S, K, p)
        if abs(den) < 1e-300:
            return 0.0
        return (num / den).real / (iu * (1j * u + 1) * 1j * 1j)
    else:
        return _char_func(u, T, r, S, K, p).real / (iu * (1j * u - 1) * 1j * 1j) * 1j * 1j


def _carr_madan_call(S, K, T, r, p, n_points=128, u_max=100.0):
    """Carr-Madan style numerical integration for Heston call price."""
    if T <= 0:
        return max(S - K, 0.0)

    def integrand(u, j):
        iu = 1j * u
        phi = _char_func(u, T, r, S, K, p)
        # Re[ e^{-iu K} φ(u-i) / (iu φ(-i)) ]  (j=1)
        # Re[ e^{-iu K} φ(u)    / (iu)         ]  (j=2)
        if j == 1:
            den = _char_func(-1j, T, r, S, K, p)
            if abs(den) < 1e-300:
                return 0.0
            return ((_cx_exp(-1j * u * math.log(K)) * _char_func(u - 1j, T, r, S, K, p))
                    / (1j * u * den)).real
        else:
            return ((_cx_exp(-1j * u * math.log(K)) * phi) / (1j * u)).real

    # Simpson integration on [0, u_max]
    h = u_max / n_points
    integral1 = 0.0
    integral2 = 0.0
    for i in range(n_points + 1):
        u = i * h
        if u == 0:
            continue
        w = 1.0 if (i == 0 or i == n_points) else (4.0 if i % 2 == 1 else 2.0)
        integral1 += w * integrand(u, 1)
        integral2 += w * integrand(u, 2)
    integral1 *= h / 3.0
    integral2 *= h / 3.0

    P1 = 0.5 + integral1 / math.pi
    P2 = 0.5 + integral2 / math.pi

    price = S * P1 - K * math.exp(-r * T) * P2
    return max(price, max(S - K * math.exp(-r * T), 0.0))


def price_call(S, K, T, r, heston_params=None):
    """Heston call price + Greeks via finite difference."""
    p = dict(DEFAULT_HESTON)
    if heston_params:
        p.update(heston_params)

    if T <= 0:
        return {"price": max(S - K, 0.0), "delta": 1.0 if S > K else 0.0,
                "gamma": 0.0, "theta": 0.0, "vega": 0.0}

    # Base price
    price = _carr_madan_call(S, K, T, r, p)

    # Delta (∂C/∂S) via finite difference
    dS = max(S * 0.005, 1.0)
    price_up = _carr_madan_call(S + dS, K, T, r, p)
    price_dn = _carr_madan_call(S - dS, K, T, r, p)
    delta = (price_up - price_dn) / (2 * dS)

    # Gamma (∂²C/∂S²)
    gamma = (price_up - 2 * price + price_dn) / (dS * dS)

    # Theta (∂C/∂t) via backward difference in T
    dT = max(T * 0.02, 1.0 / 365.0)
    if T - dT > 0:
        price_t = _carr_madan_call(S, K, T - dT, r, p)
        theta_annual = (price_t - price) / dT  # per year
    else:
        theta_annual = 0.0
    theta_day = theta_annual / 365.0

    # Vega (∂C/∂σ) — bump v0 and sqrt(theta) together
    d_sigma = 0.01
    p_up = dict(p)
    p_dn = dict(p)
    p_up["v0"] = max(0.001, p["v0"] + d_sigma * 2 * math.sqrt(max(p["v0"], 1e-6)))
    p_dn["v0"] = max(0.001, p["v0"] - d_sigma * 2 * math.sqrt(max(p["v0"], 1e-6)))
    price_su = _carr_madan_call(S, K, T, r, p_up)
    price_sd = _carr_madan_call(S, K, T, r, p_dn)
    vega_per_1pct = (price_su - price_sd) / (2 * d_sigma) / 100.0

    return {
        "price": price,
        "delta": delta,
        "gamma": gamma,
        "theta": theta_day,
        "vega": vega_per_1pct,
        "model": "heston",
    }


def implied_heston_vol(S, K, T, r, market_price, heston_params=None):
    """Solve for the BS-equivalent IV that reproduces the Heston price.

    Used to back out a single vol number for display when Heston is the model.
    """
    from option_reconstruction.pricing import implied_vol
    return implied_vol(market_price, S, K, T, r, is_call=True)