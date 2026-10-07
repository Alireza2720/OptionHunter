#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Backfill روزانه: ClientType + ClosingPrice برای همه قراردادها.

اجرا:
    /opt/collector/venv/bin/python scripts/backfill_daily.py
    /opt/collector/venv/bin/python scripts/backfill_daily.py --symbol ضهرم7050
    /opt/collector/venv/bin/python scripts/backfill_daily.py --limit 100
"""
import sys
import os
import argparse
import time
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor, as_completed

sys.path.insert(0, "/opt/collector")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pymongo import UpdateOne
from pipeline.db import (
    get_db, log,
    COL_OPTION_HISTORY, COL_MONITORED,
)
from pipeline.tsetmc_client import get_client, TSETMCError


COL_OPTION_CLIENT_TYPE = "option_client_type"


def _log(msg):
    ts = datetime.now().strftime("%H:%M:%S")
    print("[{}] {}".format(ts, msg), flush=True)
    try:
        log("backfill_daily", msg)
    except Exception:
        pass


def _fetch_one(client, symbol, ins_code):
    """Fetch ClientType + ClosingPrice for one contract."""
    out = {
        "symbol": symbol,
        "insCode": ins_code,
        "client_type": None,
        "closing_price": None,
        "error": None,
    }
    try:
        out["client_type"] = client.client_type(ins_code)
    except TSETMCError as e:
        out["error"] = "client_type: {}".format(str(e)[:120])
    except Exception as e:
        out["error"] = "client_type_exc: {}".format(str(e)[:120])

    try:
        out["closing_price"] = client.closing_price_history(ins_code)
    except TSETMCError as e:
        out["error"] = (out["error"] or "") + " | cp: {}".format(str(e)[:120])
    except Exception as e:
        out["error"] = (out["error"] or "") + " | cp_exc: {}".format(str(e)[:120])

    return out


def _parse_d_even(d_even):
    """Convert 20261007 → datetime(2026, 10, 7, 9, 0, UTC)."""
    try:
        s = str(int(d_even))
        if len(s) != 8:
            return None
        y, m, d = int(s[:4]), int(s[4:6]), int(s[6:8])
        return datetime(y, m, d, 9, 0, 0, tzinfo=timezone.utc)
    except Exception:
        return None


def _write_closing_price(db, symbol, ins_code, rows):
    """ذخیره ClosingPrice تاریخی در option_history."""
    if not rows:
        return 0
    now = datetime.now(timezone.utc)
    ops = []
    for r in rows:
        ts = _parse_d_even(r.get("dEven"))
        if not ts:
            continue
        p_close = float(r.get("pClosing") or 0)
        # فقط روزهایی که قیمت مثبت دارند (روزهای معاملاتی)
        if p_close <= 0:
            continue

        doc = {
            "symbol": symbol,
            "insCode": ins_code,
            "time": ts,
            "close": p_close,
            "priceMin": float(r.get("priceMin") or 0),
            "priceMax": float(r.get("priceMax") or 0),
            "priceFirst": float(r.get("priceFirst") or 0),
            "priceYesterday": float(r.get("priceYesterday") or 0),
            "pDrCotVal": float(r.get("pDrCotVal") or 0),
            "volume": float(r.get("qTotTran5J") or 0),
            "trades": float(r.get("zTotTran") or 0),
            "value": float(r.get("qTotCap") or 0),
            "dataQuality": "real",
            "source": "tsetmc_closingprice",
            "updatedAt": now,
        }
        ops.append(UpdateOne(
            {"symbol": symbol, "time": ts},
            {"$set": doc, "$setOnInsert": {
                "underlying": "",
                "strike": 0,
                "expiry": "",
                "isCall": True,
                "daysLeft": 0,
            }},
            upsert=True,
        ))

    if not ops:
        return 0
    try:
        res = db[COL_OPTION_HISTORY].bulk_write(ops, ordered=False)
        return (res.upserted_count or 0) + (res.modified_count or 0)
    except Exception as e:
        _log("  [X] bulk_write option_history failed for {}: {}".format(symbol, str(e)[:120]))
        return 0


def _write_client_type(db, symbol, ins_code, rows):
    """ذخیره ClientType در کالکشن جدا."""
    if not rows:
        return 0
    now = datetime.now(timezone.utc)
    ops = []
    for r in rows:
        date_iso = r.get("date")
        if not date_iso:
            continue
        doc = {
            "symbol": symbol,
            "insCode": ins_code,
            "date": date_iso,
            "dEven": r.get("dEven"),
            "buy_I_Volume": r.get("buy_I_Volume", 0),
            "buy_N_Volume": r.get("buy_N_Volume", 0),
            "buy_DDD_Volume": r.get("buy_DDD_Volume", 0),
            "buy_CountI": r.get("buy_CountI", 0),
            "buy_CountN": r.get("buy_CountN", 0),
            "buy_CountDDD": r.get("buy_CountDDD", 0),
            "sell_I_Volume": r.get("sell_I_Volume", 0),
            "sell_N_Volume": r.get("sell_N_Volume", 0),
            "sell_CountI": r.get("sell_CountI", 0),
            "sell_CountN": r.get("sell_CountN", 0),
            "source": "tsetmc_clienttype",
            "updatedAt": now,
        }
        ops.append(UpdateOne(
            {"symbol": symbol, "date": date_iso},
            {"$set": doc},
            upsert=True,
        ))

    if not ops:
        return 0
    try:
        res = db[COL_OPTION_CLIENT_TYPE].bulk_write(ops, ordered=False)
        return (res.upserted_count or 0) + (res.modified_count or 0)
    except Exception as e:
        _log("  [X] bulk_write client_type failed for {}: {}".format(symbol, str(e)[:120]))
        return 0


def run(symbols=None, limit=None, max_workers=10):
    """اجرای اصلی."""
    db = get_db()
    client = get_client()

    # ── انتخاب قراردادها ──
    if symbols:
        # اگر کاربر symbol داده، همه‌ی آن‌ها را بگیر
        target_pairs = []
        for sym in symbols:
            doc = db[COL_OPTION_HISTORY].find_one({"symbol": sym}, {"insCode": 1})
            if doc and doc.get("insCode"):
                target_pairs.append((sym, doc["insCode"]))
            else:
                _log("  [!] {} not found in option_history".format(sym))
    else:
        # همه‌ی قراردادهای یکتای option_history
        distinct = db[COL_OPTION_HISTORY].aggregate([
            {"$match": {"insCode": {"$exists": True, "$ne": None}}},
            {"$group": {
                "_id": {"symbol": "$symbol", "insCode": "$insCode"},
                "count": {"$sum": 1},
            }},
            {"$sort": {"count": -1}},
            {"$limit": limit or 100000},
        ])
        target_pairs = [(d["_id"]["symbol"], d["_id"]["insCode"]) for d in distinct]

    if not target_pairs:
        _log("[!] No contracts to backfill")
        return {"total": 0, "ok": 0, "errors": 0}

    _log("Backfilling {} contracts (workers={})".format(len(target_pairs), max_workers))

    # ── موازی ──
    t0 = time.time()
    ok = 0
    errors = 0
    total_cp_ops = 0
    total_ct_ops = 0

    with ThreadPoolExecutor(max_workers=max_workers) as ex:
        futures = {
            ex.submit(_fetch_one, client, sym, ins): (sym, ins)
            for sym, ins in target_pairs
        }
        for i, fut in enumerate(as_completed(futures), 1):
            sym, ins = futures[fut]
            try:
                res = fut.result()
            except Exception as e:
                errors += 1
                _log("  [X] {}: {}".format(sym, str(e)[:120]))
                continue

            if res.get("error"):
                _log("  [!] {}: {}".format(sym, res["error"][:120]))

            cp = res.get("closing_price") or []
            ct = res.get("client_type") or []
            cp_ops = _write_closing_price(db, sym, ins, cp)
            ct_ops = _write_client_type(db, sym, ins, ct)
            total_cp_ops += cp_ops
            total_ct_ops += ct_ops
            ok += 1

            if i % 50 == 0 or i == len(target_pairs):
                elapsed = round(time.time() - t0, 1)
                _log("  Progress: {}/{} ({:.0f}%) cp={} ct={} elapsed={}s".format(
                    i, len(target_pairs), i / len(target_pairs) * 100,
                    total_cp_ops, total_ct_ops, elapsed))

    elapsed = round(time.time() - t0, 1)
    _log("DONE in {}s: {} contracts processed, {} errors, {} cp updates, {} ct updates".format(
        elapsed, ok, errors, total_cp_ops, total_ct_ops))

    return {
        "total": len(target_pairs),
        "ok": ok,
        "errors": errors,
        "cp_updates": total_cp_ops,
        "ct_updates": total_ct_ops,
        "elapsed": elapsed,
    }


def main():
    p = argparse.ArgumentParser(description="Backfill ClientType + ClosingPrice")
    p.add_argument("--symbol", action="append", help="symbol (can be repeated)")
    p.add_argument("--limit", type=int, help="max contracts")
    p.add_argument("--workers", type=int, default=10, help="threads (default 10)")
    args = p.parse_args()

    result = run(
        symbols=args.symbol,
        limit=args.limit,
        max_workers=args.workers,
    )
    _log("Result: {}".format(result))


if __name__ == "__main__":
    main()