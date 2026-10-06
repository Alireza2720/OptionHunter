# -*- coding: utf-8 -*-
"""Option data — TSETMC raw HTTP client.

Replaces algotik-tse for options.
Preserves the same public interface used by service.py:
    fetch_market(underlying)                      -> (df, err)
    analyze_records(records, rf)                  -> list[doc]
    write_history(docs)                           -> count
    write_snapshot_ticks(underlying, records)     -> count
    migrate_from_daily_algotik(...)               -> alias to migrate_from_tsetmc
    migrate_snapshots_to_history(...)             -> noop stub
    migrate_from_tsetmc(underlyings, ...)         -> NEW: full historical backfill
    discover_contracts_for_underlying(underlying) -> list of contracts
"""
import os
from datetime import datetime, timezone

import pandas as pd
from pymongo import UpdateOne

from .db import get_db, COL_OPTION_HISTORY, COL_OPTION_SNAPSHOTS
from .tsetmc_client import get_client, TSETMCError
from .tsetmc_parser import parse_lval30, normalize_fa


SOURCE_HISTORICAL = os.getenv("OPTION_HISTORICAL_SOURCE", "tsetmc_historical")
SOURCE_LIVE = os.getenv("OPTION_LIVE_SOURCE", "tsetmc_live")
SOURCE_SNAPSHOT = os.getenv("OPTION_SNAPSHOT_SOURCE", "tsetmc_snapshot")


# ─── Discovery ───
def _learn_option_prefixes(underlying):
    """Learn existing option prefixes from DB (ضهرم, ضخود, ...).

    TSETMC uses abbreviated underlying names in option tickers, e.g.
        اهرم    → ضهرم / طهرم
        خودرو   → ضخود / طخود
        فملی    → ضملی / طملی  (sometimes drops first letter)
    So we cannot naively concat 'ض' + underlying. We learn from DB or
    try multiple heuristics.
    """
    import re
    prefixes = set()
    try:
        from .db import get_db
        db = get_db()
        existing = db.option_history.distinct(
            "symbol", {"underlying": underlying}
        )
        for sym in existing:
            if not sym:
                continue
            m = re.match(r"^(ض|ط)([^\d]+)", str(sym))
            if m:
                prefixes.add(m.group(0))
    except Exception:
        pass
    return sorted(prefixes)


def _heuristic_option_prefixes(underlying):
    """Try multiple plausible prefixes if DB has no data yet."""
    candidates = []
    for kind in ("ض", "ط"):
        candidates.append(kind + underlying)                    # ضاهرم
        if len(underlying) > 2:
            candidates.append(kind + underlying[1:])            # ضهرم
        if len(underlying) > 3:
            candidates.append(kind + underlying[2:])            # ضرم
            candidates.append(kind + underlying[-3:])           # ضهرم
        if len(underlying) > 4:
            candidates.append(kind + underlying[1:4])           # ضهر
    return candidates


def discover_contracts_for_underlying(underlying):
    """Find all option contracts for one underlying.

    Strategy:
        1. Learn prefixes from DB (authoritative).
        2. Fallback to heuristics if DB empty.
        3. Search each prefix, validate via parse_lval30.
    """
    client = get_client()
    found = {}

    # 1) learn from DB
    db_prefixes = _learn_option_prefixes(underlying)

    # 2) heuristics
    heur = _heuristic_option_prefixes(underlying)

    # merge (DB first, then heuristics)
    seen = set()
    prefixes = []
    for p in (db_prefixes + heur):
        if p not in seen:
            seen.add(p)
            prefixes.append(p)

    # 3) search each prefix
    for prefix in prefixes:
        try:
            results = client.search(prefix)
        except TSETMCError:
            continue
        for r in results:
            ticker = r.get("lVal18AFC", "")
            ins = r.get("insCode")
            name = r.get("lVal30", "")
            if not (ticker and ins):
                continue
            parsed = parse_lval30(name)
            if not parsed:
                continue
            if normalize_fa(parsed.get("underlying", "")) != normalize_fa(underlying):
                continue
            found[str(ins)] = {
                "insCode": str(ins),
                "ticker": ticker,
                "name": name,
                **parsed,
            }

    return list(found.values())
def _get_risk_free(db):
    try:
        doc = db["risk_free_cache"].find_one({}, sort=[("date", -1)])
        if doc and doc.get("rate"):
            return float(doc["rate"])
    except Exception:
        pass
    return 0.42


# ─── Full historical backfill (the big one) ───
def migrate_from_tsetmc(underlyings=None, dry_run=False, log_fn=None):
    """Fetch option OHLCV + metadata + ClientType from TSETMC.

    Writes to:
        option_history      (source='tsetmc_historical')
        option_client_type  (source='tsetmc_clienttype')

    Returns dict with stats.
    """
    db = get_db()
    rf = _get_risk_free(db)
    if log_fn:
        log_fn("migrate_from_tsetmc starting (rf={})".format(rf))

    if not underlyings:
        underlyings = [s["symbol"] for s in db["monitored_symbols"].find({})]

    stats = {
        "underlyings": len(underlyings),
        "contracts_discovered": 0,
        "contracts_written": 0,
        "contracts_skipped": 0,
        "records_inserted": 0,
        "clienttype_records": 0,
        "errors": [],
    }

    for ua in underlyings:
        if log_fn:
            log_fn("processing {}...".format(ua))

        try:
            contracts = discover_contracts_for_underlying(ua)
        except Exception as e:
            stats["errors"].append({"underlying": ua, "error": str(e)})
            continue
        stats["contracts_discovered"] += len(contracts)

        # Underlying daily close map (for S field)
        ua_daily = {}
        for row in db["candles_daily"].find({"symbol": ua}, {"time": 1, "close": 1}):
            t = row.get("time")
            if t:
                ua_daily[t.strftime("%Y-%m-%d")] = row.get("close")

        for contract in contracts:
            ins = contract["insCode"]
            try:
                client = get_client()
                raw = client.ohlcv_full(ins)
                if not raw:
                    stats["contracts_skipped"] += 1
                    continue

                ops = []
                for r in raw:
                    date_str = str(r.get("date", "")).strip()
                    if len(date_str) != 8:
                        continue
                    if (r.get("close") or 0) <= 0:
                        continue
                    try:
                        y, m, d = int(date_str[:4]), int(date_str[4:6]), int(date_str[6:8])
                        ts = datetime(y, m, d, 9, 0, 0, tzinfo=timezone.utc)
                    except Exception:
                        continue
                    iso_date = "{:04d}-{:02d}-{:02d}".format(y, m, d)

                    days_left = None
                    expiry = contract.get("expiry_gregorian")
                    if expiry:
                        try:
                            ey, em, ed = map(int, expiry.split("-"))
                            exp_ts = datetime(ey, em, ed, tzinfo=timezone.utc)
                            days_left = (exp_ts - ts).days
                        except Exception:
                            pass

                    doc = {
                        "symbol": contract["ticker"],
                        "insCode": ins,
                        "underlying": ua,
                        "time": ts,
                        "strike": contract["strike"],
                        "expiry": expiry,
                        "daysLeft": days_left,
                        "isCall": contract["type"] == "call",
                        "S": ua_daily.get(iso_date),
                        "open": r["open"],
                        "high": r["high"],
                        "low": r["low"],
                        "close": r["close"],
                        "yesterday": r.get("yesterday"),
                        "volume": r.get("volume"),
                        "value": r.get("value"),
                        "trades": int(r.get("trades") or 0),
                        "riskFreeRate": rf,
                        "source": SOURCE_HISTORICAL,
                        "computedAt": datetime.now(timezone.utc),
                    }
                    ops.append(UpdateOne(
                        {"symbol": doc["symbol"], "time": doc["time"]},
                        {"$set": doc},
                        upsert=True,
                    ))

                    if len(ops) >= 500 and not dry_run:
                        try:
                            res = db[COL_OPTION_HISTORY].bulk_write(ops, ordered=False)
                            stats["records_inserted"] += (res.upserted_count or 0) + (res.modified_count or 0)
                        except Exception as e:
                            stats["errors"].append({"insCode": ins, "error": str(e)})
                        ops = []

                if ops and not dry_run:
                    try:
                        res = db[COL_OPTION_HISTORY].bulk_write(ops, ordered=False)
                        stats["records_inserted"] += (res.upserted_count or 0) + (res.modified_count or 0)
                    except Exception as e:
                        stats["errors"].append({"insCode": ins, "error": str(e)})

                stats["contracts_written"] += 1

                # ClientType
                try:
                    ct = client.client_type(ins)
                    if ct:
                        ct_ops = []
                        for row in ct:
                            date_str = str(row.get("date", "")).strip()
                            if len(date_str) != 8:
                                continue
                            iso = "{}-{}-{}".format(date_str[:4], date_str[4:6], date_str[6:8])
                            ct_doc = {
                                "symbol": contract["ticker"],
                                "insCode": ins,
                                "underlying": ua,
                                "date": iso,
                                "strike": contract["strike"],
                                "expiry": contract.get("expiry_gregorian"),
                                "type": contract["type"],
                                **{k: v for k, v in row.items() if k != "date"},
                                "source": "tsetmc_clienttype",
                            }
                            ct_ops.append(UpdateOne(
                                {"symbol": ct_doc["symbol"], "date": iso},
                                {"$set": ct_doc},
                                upsert=True,
                            ))
                        if ct_ops and not dry_run:
                            db["option_client_type"].bulk_write(ct_ops, ordered=False)
                            stats["clienttype_records"] += len(ct_ops)
                except TSETMCError:
                    pass

            except Exception as e:
                stats["errors"].append({"insCode": ins, "error": str(e)})
                stats["contracts_skipped"] += 1

    if log_fn:
        log_fn("done: {}".format({k: v for k, v in stats.items() if k != "errors"}))
    return stats


# ─── Live market snapshot (compat with service.py) ───
def fetch_market(underlying):
    """Return (DataFrame, err) of active contracts for an underlying.

    Columns match the old algotik output (Symbol, InsCode, Strike, ...).
    """
    try:
        contracts = discover_contracts_for_underlying(underlying)
        if not contracts:
            return None, "no contracts found"
        client = get_client()
        mw = client.market_watch(paper_types=(5, 6))
        mw_map = {}
        for r in mw:
            key = r.get("insCode")
            if key:
                mw_map[key] = r
        rows = []
        for c in contracts:
            m = mw_map.get(c["insCode"], {})
            rows.append({
                "Symbol": c["ticker"],
                "InsCode": c["insCode"],
                "UnderlyingSymbol": underlying,
                "OptionType": c["type"],
                "Strike": c["strike"],
                "EndDate": c.get("expiry_gregorian"),
                "DaysToExpiry": None,
                "Last": float(m.get("last", 0) or 0),
                "Close": float(m.get("pcl", 0) or m.get("pClosing", 0) or 0),
                "Volume": float(m.get("qTotTran5J", 0) or 0),
                "TradeCount": float(m.get("zTotTran", 0) or 0),
                "BidPrice": float(m.get("pmd", 0) or 0),
                "AskPrice": float(m.get("pmo", 0) or 0),
                "OpenInterest": float(m.get("op", 0) or 0),
                "UnderlyingLast": 0.0,
                "UnderlyingClose": 0.0,
            })
        return pd.DataFrame(rows), None
    except Exception as e:
        return None, str(e)


# ─── Record conversion ───
def analyze_records(records, risk_free_rate):
    """Convert list of dicts to option_history docs (no IV computed here)."""
    docs = []
    now = datetime.now(timezone.utc)
    for r in records:
        symbol = r.get("Symbol") or r.get("symbol")
        if not symbol:
            continue
        docs.append({
            "symbol": symbol,
            "underlying": r.get("UnderlyingSymbol") or r.get("underlying"),
            "time": now,
            "strike": r.get("Strike"),
            "expiry": r.get("EndDate"),
            "isCall": (r.get("OptionType") or "").lower() == "call",
            "bid": r.get("BidPrice"),
            "ask": r.get("AskPrice"),
            "last": r.get("Last"),
            "close": r.get("Close"),
            "volume": r.get("Volume"),
            "trades": r.get("TradeCount"),
            "oi": r.get("OpenInterest"),
            "ivApi": None,
            "source": SOURCE_LIVE,
            "computedAt": now,
        })
    return docs


# ─── Writers ───
def write_history(docs):
    if not docs:
        return 0
    db = get_db()
    ops = [UpdateOne(
        {"symbol": d["symbol"], "time": d["time"]},
        {"$set": d},
        upsert=True,
    ) for d in docs]
    res = db[COL_OPTION_HISTORY].bulk_write(ops, ordered=False)
    return (res.upserted_count or 0) + (res.modified_count or 0)


def write_snapshot_ticks(underlying, records):
    if not records:
        return 0
    db = get_db()
    ts = datetime.now(timezone.utc)
    docs = [{
        "underlying": underlying,
        "timestamp": ts,
        "symbol": r.get("Symbol"),
        "ins_code": r.get("InsCode"),
        "strike": r.get("Strike"),
        "option_type": r.get("OptionType"),
        "bid": r.get("BidPrice"),
        "ask": r.get("AskPrice"),
        "last": r.get("Last"),
        "volume": r.get("Volume"),
        "oi": r.get("OpenInterest"),
        "source": SOURCE_SNAPSHOT,
    } for r in records]
    try:
        res = db[COL_OPTION_SNAPSHOTS].insert_many(docs, ordered=False)
        return len(res.inserted_ids)
    except Exception:
        return 0


# ─── Backward-compat aliases (service.py calls these) ───
def migrate_from_daily_algotik(underlyings=None, dry_run=False, **kwargs):
    """Deprecated alias -> migrate_from_tsetmc."""
    return migrate_from_tsetmc(
        underlyings=underlyings,
        dry_run=dry_run,
        log_fn=kwargs.get("log_fn"),
    )


def migrate_snapshots_to_history(underlyings=None, days=180, dry_run=False, **kwargs):
    """Deprecated — TSETMC historical covers this. Noop stub."""
    return {
        "total_processed": 0,
        "written": 0,
        "note": "superseded by migrate_from_tsetmc",
    }


def fetch_contract_history(*args, **kwargs):
    """Deprecated stub."""
    return None, "use migrate_from_tsetmc instead"

