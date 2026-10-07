# -*- coding: utf-8 -*-
"""option_greeks.py — Enriched option chain from TSETMC.

Replaces optionschool24.com for Greeks + IV computation.
Output format is compatible with optionschool24's /last?type=3 so both
OptionHunter backend and OptionStrategist can consume it unchanged.

Pipeline:
    1. Discover contracts from TSETMC (cached 1h)
    2. Fetch options MarketWatch (bid/ask/last/vol)
    3. Fetch stock MarketWatch (underlying spot)
    4. For each contract:
        - compute days_left, T, HV (30d window)
        - solve IV via Newton-Raphson from mid price
        - compute BS price + Greeks (delta/gamma/theta/vega)
    5. Return optionschool24-compatible JSON array
"""

import math
import time
from datetime import datetime, timezone
from typing import Optional, List, Dict

from concurrent.futures import ThreadPoolExecutor, as_completed
from .db import get_db, log
from .tsetmc_client import get_client, TSETMCError
from .tsetmc_parser import normalize_fa
try:
    from . import heston as heston_mod
    _HESTON_AVAILABLE = True
except Exception:
    _HESTON_AVAILABLE = False
    heston_mod = None

# BS helpers (already in collector)
try:
    from option_reconstruction.pricing import (
        bs_call, bs_put, implied_vol, norm_cdf,
    )
    _BS_AVAILABLE = True
except ImportError:
    _BS_AVAILABLE = False
    def _stub_bs(*a, **kw):
        return {'price': 0.0, 'delta': 0.0, 'gamma': 0.0, 'theta': 0.0, 'vega': 0.0}
    bs_call = _stub_bs
    bs_put = _stub_bs
    def implied_vol(*a, **kw):
        return None
    def norm_cdf(x):
        return 0.5

# ================================================================
# Caches
# ================================================================
_contract_cache = {'at': 0.0, 'data': None}
_CONTRACT_TTL = 3600          # refresh contract list every 1h

_chain_cache = {'at': 0.0, 'data': None, 'meta': None}
_CHAIN_TTL = 60               # refresh full chain every 60s

HV_WINDOW = 30                # HV window (trading days)
MIN_HV_SAMPLES = 10


# ================================================================
# Helpers
# ================================================================
def _safe_float(v, default=0.0):
    try:
        x = float(v)
        if x != x:  # NaN
            return default
        return x
    except (TypeError, ValueError):
        return default


def _pv_str(price, volume):
    """Format 'price/volume' like optionschool24 (e.g., '1234/5678')."""
    p = _safe_float(price)
    v = _safe_float(volume)
    if p <= 0:
        return ''
    if v > 0:
        return '{}/{}'.format(round(p, 2), int(v))
    return str(round(p, 2))


def _compute_hv_from_closes(closes):
    """Annualized HV from chronological closes."""
    if not closes or len(closes) < MIN_HV_SAMPLES + 1:
        return None
    rets = []
    for i in range(1, len(closes)):
        a, b = closes[i - 1], closes[i]
        if a > 0 and b > 0:
            rets.append(math.log(b / a))
    if len(rets) < MIN_HV_SAMPLES:
        return None
    m = sum(rets) / len(rets)
    var = sum((r - m) ** 2 for r in rets) / max(1, len(rets) - 1)
    try:
        return math.sqrt(var * 245)  # Tehran trading days/year
    except Exception:
        return None


def _get_hv_map(symbols, window=HV_WINDOW):
    """Compute 30d HV for each symbol from candles_daily."""
    db = get_db()
    out = {}
    for sym in symbols:
        try:
            rows = list(db['candles_daily'].find(
                {'symbol': sym},
                {'time': 1, 'close': 1},
            ).sort('time', -1).limit(window + 5))
            if not rows:
                continue
            closes = [r['close'] for r in reversed(rows) if r.get('close', 0) > 0]
            hv = _compute_hv_from_closes(closes)
            if hv and 0.01 < hv < 5.0:
                out[sym] = hv
        except Exception as e:
            log('og_hv_err', '{}: {}'.format(sym, str(e)[:100]))
    return out


def _get_risk_free():
    """Risk-free rate from risk_free_cache (populated by OptionHunter job)."""
    try:
        db = get_db()
        doc = db['risk_free_cache'].find_one({}, sort=[('date', -1)])
        if doc and doc.get('rate'):
            r = float(doc['rate'])
            if 0.01 < r < 1.0:
                return r
    except Exception:
        pass
    return 0.23


def _discover_all_contracts_cached(force=False):
    """Discover all option contracts for all monitored underlyings (cached)."""
    from . import options as opt_mod
    db = get_db()
    now = time.time()
    if not force and _contract_cache['data'] is not None and (now - _contract_cache['at']) < _CONTRACT_TTL:
        return _contract_cache['data']

    underlyings = [s['symbol'] for s in db['monitored_symbols'].find({})]
    all_contracts = []
    for ua in underlyings:
        try:
            cs = opt_mod.discover_contracts_for_underlying(ua)
            for c in cs:
                c['_underlying'] = ua
                all_contracts.append(c)
        except Exception as e:
            log('og_disc_err', '{}: {}'.format(ua, str(e)[:120]))

    _contract_cache['data'] = all_contracts
    _contract_cache['at'] = now
    log('og_disc', 'discovered {} contracts for {} underlyings'.format(len(all_contracts), len(underlyings)))
    return all_contracts


# ================================================================
# Main
# ================================================================
def compute_enriched_chain(underlyings=None, force=False, pricing_model='bsm'):
    """Build the full enriched option chain (optionschool24-compatible)."""
    db = get_db()
    now = datetime.now(timezone.utc)

    if not underlyings:
        underlyings = [s['symbol'] for s in db['monitored_symbols'].find({})]

    ua_set = set(normalize_fa(u) for u in underlyings)

    contracts_all = _discover_all_contracts_cached(force=force)
    contracts_all = [c for c in contracts_all
                     if normalize_fa(c.get('_underlying', '')) in ua_set]

    rf = _get_risk_free()
    hv_map = _get_hv_map(underlyings)

    client = get_client()

    # Options MarketWatch (single HTTP call for all options)
    try:
        mw_opts = client.market_watch(paper_types=(5, 6), with_best_limits=True)
    except TSETMCError as e:
        log('og_mw_opt_err', str(e)[:200])
        mw_opts = []
    opt_map = {r.get('insCode'): r for r in (mw_opts or []) if r.get('insCode')}

    # Stock MarketWatch (for underlying spot)
    try:
        mw_stocks = client.market_watch(paper_types=(1, 2, 3))
    except TSETMCError:
        mw_stocks = []
    spot_map = {}
    for r in (mw_stocks or []):
        sym = r.get('lva') or r.get('lVal18AFC')
        if not sym:
            continue
        last = _safe_float(r.get('pDrCotVal') or r.get('last') or r.get('pcl'))
        if last > 0:
            spot_map[normalize_fa(sym)] = last

    # ── Parallel BestLimits: fetch 5-level order book for all contracts ──
    _best_limits_map = {}
    _all_ins = [cc.get('insCode') for cc in contracts_all if cc.get('insCode')]

    if _all_ins:
        _t0_bl = time.time()
        _bl_ok = 0
        _bl_fail = 0

        def _fetch_best(code):
            try:
                return code, client.best_limits(code)
            except Exception:
                return code, None

        with ThreadPoolExecutor(max_workers=10) as ex:
            futures = {ex.submit(_fetch_best, code): code for code in _all_ins}
            for fut in as_completed(futures):
                try:
                    code, limits = fut.result()
                    if limits:
                        _best_limits_map[code] = limits
                        _bl_ok += 1
                    else:
                        _bl_fail += 1
                except Exception:
                    _bl_fail += 1

        _elapsed = round(time.time() - _t0_bl, 1)
        log('og_best_limits', 'fetched {}/{} in {}s (failed={})'.format(
            _bl_ok, len(_all_ins), _elapsed, _bl_fail))

    out = []

    for c in contracts_all:
        ua = c.get('_underlying')
        ins = c.get('insCode')
        if not ua or not ins:
            continue

        ua_norm = normalize_fa(ua)
        S = spot_map.get(ua_norm)
        if not S or S <= 0:
            continue

        m = opt_map.get(ins, {})

        # Bid/ask from bestLimits[0]
        bid_p, ask_p, bid_v, ask_v = 0.0, 0.0, 0.0, 0.0
        bl = m.get('bestLimits')
        if isinstance(bl, list) and bl:
            lvl0 = bl[0]
            bid_p = _safe_float(lvl0.get('bd') or lvl0.get('bid'))
            bid_v = _safe_float(lvl0.get('bq') or lvl0.get('bidVol') or lvl0.get('bVolume'))
            ask_p = _safe_float(lvl0.get('od') or lvl0.get('ask'))
            ask_v = _safe_float(lvl0.get('oq') or lvl0.get('askVol') or lvl0.get('oVolume'))

        # ── Merge real volumes from BestLimits ──
        _book = _best_limits_map.get(ins)
        if _book and _book[0]:
            _lvl1 = _book[0]
            if _lvl1['bid'] > 0:
                bid_p = _lvl1['bid']
                bid_v = _lvl1['bid_vol']
            if _lvl1['ask'] > 0:
                ask_p = _lvl1['ask']
                ask_v = _lvl1['ask_vol']

        last = _safe_float(m.get('pDrCotVal') or m.get('last'))
        close_px = _safe_float(m.get('pcl') or m.get('pClosing') or last)
        yday = _safe_float(m.get('py') or m.get('yesterday'))
        vol = _safe_float(m.get('qTotTran5J') or m.get('volume'))
        val = _safe_float(m.get('qTotTran') or m.get('value'))
        tno = _safe_float(m.get('zTotTran') or m.get('tradeCount'))
        oi = _safe_float(m.get('op') or m.get('openInterest'))

        close_pct = 0.0
        if yday > 0 and close_px > 0:
            close_pct = (close_px / yday - 1) * 100

        # Days to expiry: always from calendar, +1 (include today and expiry day)
        # Matches optionschool24 semantics.
        expiry_greg = c.get('expiry_gregorian')
        days_left = None
        if expiry_greg:
            try:
                ey, em, ed = map(int, expiry_greg.split('-'))
                exp_date = datetime(ey, em, ed, 0, 0, 0, tzinfo=timezone.utc)
                today_date = now.replace(hour=0, minute=0, second=0, microsecond=0)
                days_left = max(1, (exp_date - today_date).days + 1)
            except Exception:
                pass
        if days_left is None or days_left <= 0:
            continue

        strike = _safe_float(c.get('strike'))
        if strike <= 0:
            continue

        is_call = c.get('type') == 'call'
        T = max(days_left, 1) / 365.0

        # Price for IV: prefer last (like optionschool24) → close → mid
        mid = 0.0
        if last > 0:
            mid = last
        elif close_px > 0:
            mid = close_px
        elif bid_p > 0 and ask_p > 0:
            mid = (bid_p + ask_p) / 2
        elif ask_p > 0:
            mid = ask_p

        # IV via Newton-Raphson
        iv = None
        if _BS_AVAILABLE and mid > 0 and S > 0:
            try:
                iv = implied_vol(mid, S, strike, T, rf, is_call=is_call)
                if iv and not (0.01 <= iv <= 5.0):
                    iv = None
            except Exception:
                iv = None

        hv = hv_map.get(ua)
        sigma = iv if iv else (hv if hv else 0.4)

        # Pricing model selection: 'bsm' (default) or 'heston'
        use_heston = (pricing_model == 'heston') and _HESTON_AVAILABLE and is_call
        if use_heston:
            try:
                # Derive Heston params: v0 from IV, others from defaults
                hp = dict(heston_mod.DEFAULT_HESTON)
                hp['v0'] = max(0.001, sigma * sigma)
                hres = heston_mod.price_call(S, strike, T, rf, hp)
                bs = {
                    'price': hres['price'],
                    'delta': hres['delta'],
                    'gamma': hres['gamma'],
                    'theta': hres['theta'],
                    'vega': hres['vega'],
                }
            except Exception:
                # Fall back to BSM if Heston fails
                use_heston = False
                if _BS_AVAILABLE:
                    bs = bs_call(S, strike, T, rf, sigma)
                else:
                    bs = {'price': 0.0, 'delta': 0.0, 'gamma': 0.0, 'theta': 0.0, 'vega': 0.0}
        else:
            if _BS_AVAILABLE:
                bs = bs_call(S, strike, T, rf, sigma) if is_call else bs_put(S, strike, T, rf, sigma)
            else:
                bs = {'price': 0.0, 'delta': 0.0, 'gamma': 0.0, 'theta': 0.0, 'vega': 0.0}

        intrinsic = max(S - strike, 0) if is_call else max(strike - S, 0)

        if is_call:
            status_text = 'سود' if S > strike else ('ضرر' if S < strike else 'تفاوت')
        else:
            status_text = 'سود' if S < strike else ('ضرر' if S > strike else 'تفاوت')

        bs_diff = 0.0
        if bs['price'] > 0 and mid > 0:
            bs_diff = (mid - bs['price']) / bs['price'] * 100

        out.append({
            'name': c.get('ticker') or '',
            'fname': c.get('name') or '',
            'co': ins,
            'basis_name': ua,
            'type': 1 if is_call else 2,
            'basis': S,
            'basis_c': S,
            'emal': strike,
            'to_date': expiry_greg,
            'day_left': days_left,
            'days_left_actual': days_left,
            'close': last,
            'close_c': round(close_pct, 2),
            'final': last,
            'final_c': round(close_pct, 2),
            'yday': yday,
            'highest_price': 0,
            'lowest_price': 0,
            'Tvolume': vol,
            'Tvalue': val,
            'Tcount': tno,
            'op': oi,
            'op_change': 0,
            'b_price': _pv_str(bid_p, bid_v),
            'b_volume': bid_v,
            's_price': _pv_str(ask_p, ask_v),
            's_volume': ask_v,
            'bid_book': _best_limits_map.get(ins) or None,
            'black_sholes': round(_safe_float(bs.get('price')), 2),
            'bs_d': round(bs_diff, 2),
            'imp': round(iv, 4) if iv else 0,
            'sigma': round(hv, 4) if hv else 0,
            'delta': round(_safe_float(bs.get('delta')), 4),
            'gamma': round(_safe_float(bs.get('gamma')), 6),
            'theta': round(_safe_float(bs.get('theta')), 4),
            'vega': round(_safe_float(bs.get('vega')), 4),
            'rho': 0,
            'size': 1000,
            'tazmin': 0,
            'tazmin_3': 0,
            'value': intrinsic,
            'status_text': status_text,
            'isCall': is_call,
            'source': 'tsetmc_enriched',
            'pricingModel': 'heston' if use_heston else 'bsm',
        })

    return out


def get_chain_cached(force=False, ttl=None, pricing_model='bsm'):
    """Return cached enriched chain (refreshed if stale)."""
    if ttl is None:
        ttl = _CHAIN_TTL
    now = time.time()
    if (not force
            and _chain_cache['data'] is not None
            and (now - _chain_cache['at']) < ttl):
        return _chain_cache['data']

    t0 = time.time()
    data = compute_enriched_chain(force=force, pricing_model=pricing_model)
    elapsed_ms = int((time.time() - t0) * 1000)

    _chain_cache['data'] = data
    _chain_cache['at'] = time.time()
    _chain_cache['meta'] = {
        'count': len(data),
        'computeMs': elapsed_ms,
        'at': datetime.now(timezone.utc).isoformat(),
        'source': 'tsetmc_enriched',
        'pricingModel': pricing_model,
    }
    log('og_chain_refresh', 'count={} ms={}'.format(len(data), elapsed_ms))
    return data


def get_chain_meta():
    return _chain_cache.get('meta')


def invalidate_caches():
    """Clear both chain and contract caches."""
    _chain_cache['data'] = None
    _chain_cache['at'] = 0.0
    _contract_cache['data'] = None
    _contract_cache['at'] = 0.0


def diagnose_market_watch():
    """Return diagnostic info about raw MarketWatch fields."""
    client = get_client()
    try:
        opts = client.market_watch(paper_types=(5, 6))
    except TSETMCError as e:
        return {'error': str(e)}
    if not opts:
        return {'count': 0}
    return {
        'count': len(opts),
        'sample_keys': list(opts[0].keys()),
        'sample_row': opts[0],
    }