# -*- coding: utf-8 -*-
"""Option data: live snapshot + daily + IV/Greeks analysis."""
import algotik_tse as att
import pandas as pd
from datetime import datetime, timezone
from pymongo import UpdateOne
from .db import get_db, COL_OPTION_HISTORY, COL_OPTION_SNAPSHOTS

IV_MONEYNESS_MIN = 0.75
IV_MONEYNESS_MAX = 1.25
IV_MIN_VALID = 0.05
IV_MAX_VALID = 5.0

def fetch_market(underlying):
    """get_option_market(underlying) → DataFrame or None."""
    try:
        df = att.get_option_market(underlying=underlying, progress=False)
        return df, None
    except Exception as e:
        return None, str(e)

def fetch_contract_history(contract_symbol, from_date=None, to_date=None, limit=0):
    try:
        kwargs = {'progress': False}
        if from_date: kwargs['start'] = from_date
        if to_date: kwargs['end'] = to_date
        if limit: kwargs['limit'] = limit
        df = att.get_option_history(contract_symbol, **kwargs)
        return df, None
    except Exception as e:
        return None, str(e)

def analyze_chain(df, risk_free_rate):
    """Run analyze_option_chain."""
    try:
        out = att.analyze_option_chain(
            df, risk_free_rate=risk_free_rate,
            exercise_style='european',
            allow_unverified_freshness=True, progress=False,
        )
        return out, None
    except Exception as e:
        return df, str(e)

def _clean_num(v):
    if v is None: return None
    try:
        if pd.isna(v): return None
    except (TypeError, ValueError):
        pass
    try:
        return float(v)
    except (TypeError, ValueError):
        return None

def _clean_str(v):
    if v is None: return None
    try:
        if pd.isna(v): return None
    except (TypeError, ValueError):
        pass
    s = str(v).strip()
    return s if s else None

def _filter_iv(iv_raw, strike, spot):
    if iv_raw is None: return None, 'missing'
    if iv_raw < IV_MIN_VALID: return None, 'too_low'
    if iv_raw > IV_MAX_VALID: return None, 'too_high'
    if not strike or not spot or strike <= 0 or spot <= 0:
        return None, 'missing_spot'
    ratio = strike / spot
    if ratio < IV_MONEYNESS_MIN or ratio > IV_MONEYNESS_MAX:
        return None, 'out_of_moneyness'
    return iv_raw, 'ok'

def build_input_df(records):
    out = []
    for r in records:
        bid = r.get('BidPrice', 0) or 0
        ask = r.get('AskPrice', 0) or 0
        last = r.get('Last', 0) or 0
        close = r.get('Close', 0) or 0
        if bid > 0 and ask > 0:
            price, psrc = (bid + ask) / 2, 'mid'
        elif last > 0:
            price, psrc = last, 'last'
        elif close > 0:
            price, psrc = close, 'close'
        else:
            price, psrc = 0, 'missing'
        out.append({
            'InsCode': r.get('InsCode'),
            'Symbol': r.get('Symbol'),
            'Name': r.get('Name'),
            'OptionType': (r.get('OptionType') or 'call').lower(),
            'UnderlyingSymbol': r.get('UnderlyingSymbol'),
            'UnderlyingInsCode': r.get('UnderlyingInsCode'),
            'UnderlyingName': r.get('UnderlyingName'),
            'ContractSize': r.get('ContractSize') or 1000,
            'Strike': r.get('Strike'),
            'EndDate': r.get('EndDate'),
            'DaysToExpiry': r.get('DaysToExpiry'),
            'Last': last, 'Close': close,
            'Volume': r.get('Volume') or 0,
            'TradeCount': r.get('TradeCount') or 0,
            'OpenInterest': r.get('OpenInterest') or 0,
            'YesterdayOpenInterest': r.get('YesterdayOpenInterest') or 0,
            'BidPrice': bid, 'AskPrice': ask,
            'BidVolume': r.get('BidVolume') or 0,
            'AskVolume': r.get('AskVolume') or 0,
            'UnderlyingLast': r.get('UnderlyingLast'),
            'UnderlyingClose': r.get('UnderlyingClose'),
            'Price': price, 'PriceSource': psrc,
            'AsOf': r.get('AsOf') or datetime.now(timezone.utc).isoformat(),
            'AsOfSource': 'snapshot',
            'SnapshotFreshnessKnown': True,
            'PriceFreshnessKnown': True,
            'Stale': False,
            'NoTrade': (r.get('Volume') or 0) == 0,
            'AnalyticsEligible': True,
            'AnalyticsEligibilityReason': None,
            'MetadataConflict': False,
            'Source': 'algotik',
        })
    return pd.DataFrame(out)

def _row_to_doc(row, rf, time_val=None):
    symbol = _clean_str(row.get('Symbol'))
    underlying = _clean_str(row.get('UnderlyingSymbol'))
    if not symbol or not underlying:
        return None
    strike = _clean_num(row.get('Strike'))
    spot = _clean_num(row.get('Spot')) or _clean_num(row.get('UnderlyingClose'))
    iv_raw = _clean_num(row.get('ImpliedVolatilityMid')) or _clean_num(row.get('ImpliedVolatility'))
    iv, iv_status = _filter_iv(iv_raw, strike, spot)

    if time_val is None:
        as_of = row.get('AsOf')
        try:
            if hasattr(as_of, 'to_pydatetime'):
                time_val = as_of.to_pydatetime()
            elif isinstance(as_of, str):
                time_val = datetime.fromisoformat(as_of.replace('Z', '+00:00'))
            else:
                time_val = as_of or datetime.now(timezone.utc)
            if time_val.tzinfo is None:
                time_val = time_val.replace(tzinfo=timezone.utc)
        except Exception:
            time_val = datetime.now(timezone.utc)

    end_date = row.get('EndDate')
    if end_date is not None and not pd.isna(end_date):
        expiry = str(end_date)[:10]
    else:
        expiry = None

    return {
        'symbol': symbol, 'underlying': underlying, 'time': time_val,
        'strike': strike, 'expiry': expiry,
        'daysLeft': _clean_num(row.get('DaysToExpiry')),
        'size': int(_clean_num(row.get('ContractSize')) or 1000),
        'isCall': str(row.get('OptionType', '')).lower() == 'call',
        'S': spot,
        'bid': _clean_num(row.get('BidPrice')),
        'ask': _clean_num(row.get('AskPrice')),
        'last': _clean_num(row.get('Last')),
        'close': _clean_num(row.get('Close')),
        'bidVol': _clean_num(row.get('BidVolume')),
        'askVol': _clean_num(row.get('AskVolume')),
        'oi': _clean_num(row.get('OpenInterest')),
        'volume': _clean_num(row.get('Volume')),
        'trades': _clean_num(row.get('TradeCount')),
        'ivApi': iv, 'ivStatus': iv_status, 'ivRaw': iv_raw,
        'deltaApi': _clean_num(row.get('Delta')),
        'gammaApi': _clean_num(row.get('Gamma')),
        'vegaApi': _clean_num(row.get('Vega')),
        'thetaApi': _clean_num(row.get('ThetaPerDay')),
        'thetaApiContract': _clean_num(row.get('ThetaPerDayContract')),
        'rhoApi': _clean_num(row.get('Rho')),
        'spreadPct': _clean_num(row.get('SpreadPct')),
        'liquidityScore': _clean_num(row.get('LiquidityScore')),
        'parityStatus': _clean_str(row.get('ParityStatus')),
        'riskFreeRate': rf,
        'timeToExpiry': _clean_num(row.get('TimeToExpiry')),
        'source': 'algotik',
        'computedAt': datetime.now(timezone.utc),
    }

def analyze_records(records, risk_free_rate):
    """List of raw dicts (from get_option_market) → docs for option_history."""
    if not records:
        return []
    df = build_input_df(records)
    if df.empty:
        return []
    analysis, _ = analyze_chain(df, risk_free_rate)
    docs = []
    for _, row in analysis.iterrows():
        d = _row_to_doc(row, risk_free_rate)
        if d:
            docs.append(d)
    return docs
def migrate_from_daily_algotik(underlyings=None, dry_run=False, log_fn=None):
    """
    Migrate option_daily_algotik → option_history with IV/Greeks.
    Returns stats dict.
    """
    import pandas as pd
    db = get_db()

    q = {}
    if underlyings:
        q['underlying'] = {'$in': underlyings}

    # Preload candles_daily for S
    candle_cache = {}
    for c in db['candles_daily'].find({}, {'symbol': 1, 'time': 1, 'close': 1}):
        s = c.get('symbol'); t = c.get('time')
        if s and t:
            try:
                date_str = t.strftime('%Y-%m-%d')
                candle_cache.setdefault(s, {})[date_str] = c.get('close')
            except Exception:
                pass

    # Get current risk-free
    rf = 0.414
    try:
        rf_doc = db['risk_free_cache'].find_one({}, sort=[('date', -1)])
        if rf_doc:
            rf = float(rf_doc.get('rate', 0.414))
    except Exception:
        pass

    total = written = skipped = errors = 0
    ops = []

    for doc in db['option_daily_algotik'].find(q):
        total += 1
        underlying = doc.get('underlying')
        date_str = doc.get('date')
        strike = doc.get('strike')
        end_date = doc.get('end_date')
        option_type = (doc.get('option_type') or 'call').lower()
        close_px = doc.get('close') or doc.get('last')

        if not all([underlying, date_str, strike, end_date, close_px]):
            skipped += 1; continue
        if float(close_px) <= 1:
            skipped += 1; continue
        if not (doc.get('volume') or 0) > 0:
            skipped += 1; continue

        S = candle_cache.get(underlying, {}).get(date_str)
        if not S or S <= 0:
            skipped += 1; continue

        try:
            y1, m1, d1 = map(int, date_str.split('-'))
            y2, m2, d2 = map(int, end_date.split('-'))
            days_left = (datetime(y2, m2, d2) - datetime(y1, m1, d1)).days
        except Exception:
            skipped += 1; continue

        if days_left <= 0:
            skipped += 1; continue

        T = days_left / 365.0

        # IV
        iv = None
        try:
            iv_res = att.implied_volatility(float(close_px), float(S), float(strike), T, rf, option_type)
            if isinstance(iv_res, dict):
                iv = iv_res.get('ImpliedVolatility')
            if iv and (iv < 0.05 or iv > 5.0):
                iv = None
        except Exception:
            iv = None

        # Greeks
        delta = gamma = theta = vega = None
        if iv:
            try:
                g = att.black_scholes_greeks(float(S), float(strike), T, rf, iv, option_type)
                if isinstance(g, dict):
                    delta = g.get('Delta')
                    gamma = g.get('Gamma')
                    theta = g.get('ThetaPerDay')
                    vega = g.get('Vega')
            except Exception:
                pass

        # Convert date to UTC (Tehran 12:30 = UTC 09:00)
        try:
            y, m, d = map(int, date_str.split('-'))
            time_val = datetime(y, m, d, 9, 0, 0, tzinfo=timezone.utc)
        except Exception:
            skipped += 1; continue

        rec = {
            'symbol': doc.get('symbol'),
            'underlying': underlying,
            'time': time_val,
            'strike': float(strike) if strike else None,
            'expiry': end_date,
            'daysLeft': days_left,
            'size': int(doc.get('contract_size') or 1000),
            'isCall': option_type == 'call',
            'S': float(S),
            'bid': None,
            'ask': None,
            'last': float(doc.get('last') or 0) or None,
            'close': float(close_px),
            'oi': None,
            'volume': float(doc.get('volume') or 0),
            'trades': float(doc.get('trade_count') or 0),
            'ivApi': iv,
            'deltaApi': delta,
            'gammaApi': gamma,
            'thetaApi': theta,
            'vegaApi': vega,
            'riskFreeRate': rf,
            'source': 'migrated_daily',
            'migratedAt': datetime.now(timezone.utc),
        }

        ops.append(UpdateOne(
            {'symbol': rec['symbol'], 'time': time_val},
            {'$set': rec},
            upsert=True,
        ))

        if len(ops) >= 500:
            if not dry_run:
                try:
                    res = db[COL_OPTION_HISTORY].bulk_write(ops, ordered=False)
                    written += res.upserted_count + res.modified_count
                except Exception as e:
                    errors += 1
                    if log_fn: log_fn(f'bulk error: {e}')
            ops = []

    if ops and not dry_run:
        try:
            res = db[COL_OPTION_HISTORY].bulk_write(ops, ordered=False)
            written += res.upserted_count + res.modified_count
        except Exception as e:
            errors += 1

    return {
        'total_processed': total,
        'written': written,
        'skipped': skipped,
        'errors': errors,
    }

def write_history(docs):
    if not docs:
        return 0
    db = get_db()
    ops = [UpdateOne(
        {'symbol': d['symbol'], 'time': d['time']},
        {'$set': d}, upsert=True
    ) for d in docs]
    res = db[COL_OPTION_HISTORY].bulk_write(ops, ordered=False)
    return res.upserted_count + res.modified_count

def write_snapshot_ticks(underlying, records):
    """Raw ticks → option_snapshots (for live ticker)."""
    if not records:
        return 0
    db = get_db()
    ts = datetime.now(timezone.utc)
    docs = [{
        'underlying': underlying,
        'timestamp': ts,
        'symbol': r.get('Symbol'),
        'ins_code': r.get('InsCode'),
        'strike': r.get('Strike'),
        'option_type': r.get('OptionType'),
        'bid': r.get('BidPrice'),
        'ask': r.get('AskPrice'),
        'last': r.get('Last'),
        'volume': r.get('Volume'),
        'oi': r.get('OpenInterest'),
        'source': 'live_tick',
    } for r in records]
    res = db[COL_OPTION_SNAPSHOTS].insert_many(docs, ordered=False)
    return len(res.inserted_ids)