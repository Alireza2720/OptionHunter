#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AlgoTik Collector Service — FastAPI for TSETMC data collection
Features:
  - Bulk stock intraday backfill
  - Option snapshots (all active contracts)
  - Option daily OHLCV (job-based, parallel)
  - Chart data (on-demand)
  - Job progress tracking
"""
import os
import asyncio
import threading
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional, List, Dict, Any
from contextlib import asynccontextmanager
from concurrent.futures import ThreadPoolExecutor

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel
import algotik_tse as att
import requests
from pymongo import MongoClient, ASCENDING, DESCENDING, UpdateOne

# === Analytics (فاز ۰.۱) ===
from option_analyzer import analyze_snapshot

COL_OPT_HISTORY = "option_history"

# Risk-free rate cache (per-day)
_RF_CACHE = {"rate": 0.42, "date": None}


def get_current_rf():
    """نرخ بدون ریسک روزانه از اخزا"""
    today = datetime.utcnow().date()
    if _RF_CACHE["date"] == today:
        return _RF_CACHE["rate"]
    try:
        treasuries = att.get_treasury_yields(min_volume=1)
        if treasuries is not None and len(treasuries) > 0:
            rate = float(treasuries["EffectiveAnnualYield"].median())
            _RF_CACHE["rate"] = rate
            _RF_CACHE["date"] = today
            log_event("rf_update", f"risk-free updated: {rate:.4f}")
            return rate
    except Exception as e:
        log_event("rf_error", str(e))
    return _RF_CACHE["rate"]
MONGO_URI = os.getenv("MONGO_URI", "mongodb://127.0.0.1:27017")
MONGO_DB = os.getenv("MONGO_DB", "trading_bot")
PORT = int(os.getenv("PORT", "5000"))
HOST = os.getenv("HOST", "127.0.0.1")

client = MongoClient(MONGO_URI)
db = client[MONGO_DB]

COL_STOCKS = "candles_base"
COL_OPT_SNAP = "option_snapshots_algotik"
COL_OPT_DAILY = "option_daily_algotik"
COL_LOG = "collector_log"
COL_JOBS = "collector_jobs"

# ==================== Job Tracker ====================
JOBS: Dict[str, Dict[str, Any]] = {}
JOBS_LOCK = threading.Lock()

def job_set(job_id: str, **kwargs):
    with JOBS_LOCK:
        if job_id not in JOBS:
            JOBS[job_id] = {"job_id": job_id, "created_at": datetime.utcnow().isoformat(), "progress": {}}
        JOBS[job_id].update(kwargs)

def job_get(job_id: str):
    with JOBS_LOCK:
        return JOBS.get(job_id)

# ==================== FastAPI ====================
@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        db[COL_OPT_SNAP].create_index([("ins_code", ASCENDING), ("timestamp", DESCENDING)])
        db[COL_OPT_SNAP].create_index([("timestamp", DESCENDING)])
        db[COL_OPT_SNAP].create_index([("underlying", ASCENDING)])
        db[COL_OPT_DAILY].create_index([("ins_code", ASCENDING), ("date", DESCENDING)], unique=True)
        db[COL_OPT_DAILY].create_index([("underlying", ASCENDING)])
        db[COL_LOG].create_index([("at", DESCENDING)])
        db[COL_OPT_HISTORY].create_index([("symbol", ASCENDING), ("time", DESCENDING)])
        db[COL_OPT_HISTORY].create_index([("underlying", ASCENDING), ("time", DESCENDING)])
        db[COL_OPT_HISTORY].create_index([("time", DESCENDING)])
        print("✅ Indexes ready")
    except Exception as e:
        print(f"Index error: {e}")
    yield
    client.close()

app = FastAPI(lifespan=lifespan, title="AlgoTik Collector")


# ==================== Models ====================
class StockBackfillReq(BaseModel):
    symbols: Optional[List[str]] = None
    months: int = 6

class OptionSnapshotReq(BaseModel):
    underlyings: Optional[List[str]] = None

class OptionDailyJobReq(BaseModel):
    underlyings: Optional[List[str]] = None
    force: bool = False

class OptionHistoryReq(BaseModel):
    symbol: str
    months: int = 6

class FullBackfillReq(BaseModel):
    months: int = 6
    with_options: bool = True


# ==================== Helpers ====================
def log_event(kind: str, message: str, extra: Optional[Dict] = None):
    doc = {"kind": kind, "message": message, "at": datetime.utcnow()}
    if extra:
        doc.update(extra)
    try:
        db[COL_LOG].insert_one(doc)
    except Exception as e:
        print(f"Log error: {e}")

def get_monitored_symbols():
    docs = db["monitored_symbols"].find({}, {"symbol": 1}).sort("addedAt", 1)
    return [d["symbol"] for d in docs if d.get("symbol")]

def safe_json(val):
    if val is None: return None
    if hasattr(val, 'isoformat'): return val.isoformat()
    if hasattr(val, 'item'):
        try: return val.item()
        except Exception: return str(val)
    if isinstance(val, float) and (val != val): return None
    return val


# ==================== Stock Backfill ====================
async def backfill_stocks_async(symbols, months):
    end_date = datetime.utcnow().date()
    start_date = end_date - timedelta(days=months * 30)
    start_str = start_date.strftime("%Y-%m-%d")
    end_str = end_date.strftime("%Y-%m-%d")

    results = []
    total_candles = 0
    loop = asyncio.get_event_loop()

    for sym in symbols:
        try:
            log_event("stock_fetch_start", f"Fetching {sym}", {"symbol": sym})
            df = await loop.run_in_executor(
                None,
                lambda s=sym: att.get_intraday(symbol=s, start=start_str, end=end_str,
                                               interval="1min", progress=False)
            )
            if df is None or len(df) == 0:
                results.append({"symbol": sym, "status": "empty", "candles": 0})
                continue

            records = []
            for ts, row in df.iterrows():
                t = ts.to_pydatetime() if hasattr(ts, 'to_pydatetime') else ts
                records.append({
                    "symbol": sym, "time": t,
                    "open": float(row.get("Open", 0)),
                    "high": float(row.get("High", 0)),
                    "low": float(row.get("Low", 0)),
                    "close": float(row.get("Close", 0)),
                    "volume": float(row.get("Volume", 0)),
                    "trades": int(row.get("TradeCount", 0)) if "TradeCount" in row else 0,
                    "source": "algotik", "fetchedAt": datetime.utcnow()
                })

            ops = [UpdateOne({"symbol": r["symbol"], "time": r["time"]}, {"$set": r}, upsert=True) for r in records]
            for i in range(0, len(ops), 1000):
                db[COL_STOCKS].bulk_write(ops[i:i+1000], ordered=False)

            total_candles += len(records)
            results.append({"symbol": sym, "status": "ok", "candles": len(records)})
            log_event("stock_fetch_ok", f"{sym}: {len(records)} candles", {"symbol": sym, "count": len(records)})
        except Exception as e:
            log_event("stock_fetch_err", f"{sym}: {e}", {"symbol": sym, "error": str(e)})
            results.append({"symbol": sym, "status": "error", "error": str(e)})

    return {"results": results, "total_candles": total_candles}


# ==================== Option Snapshot ====================
def fetch_option_snapshot_sync(underlyings):
    timestamp = datetime.utcnow()
    results = []
    total = 0

    for ua in underlyings:
        try:
            log_event("option_snapshot_start", f"Fetching options for {ua}", {"underlying": ua})
            df = att.get_option_market(underlying=ua, progress=False)
            if df is None or len(df) == 0:
                results.append({"underlying": ua, "status": "empty", "contracts": 0})
                continue

            records = []
            for _, row in df.iterrows():
                records.append({
                    "underlying": ua, "timestamp": timestamp,
                    "ins_code": str(row.get("InsCode", "")),
                    "symbol": safe_json(row.get("Symbol")),
                    "name": safe_json(row.get("Name")),
                    "option_type": safe_json(row.get("OptionType")),
                    "strike": safe_json(row.get("Strike")),
                    "end_date": safe_json(row.get("EndDate")),
                    "days_to_expiry": safe_json(row.get("DaysToExpiry")),
                    "contract_size": safe_json(row.get("ContractSize")),
                    "last": safe_json(row.get("Last")),
                    "close": safe_json(row.get("Close")),
                    "yesterday": safe_json(row.get("Yesterday")),
                    "volume": safe_json(row.get("Volume")),
                    "value": safe_json(row.get("Value")),
                    "trade_count": safe_json(row.get("TradeCount")),
                    "open_interest": safe_json(row.get("OpenInterest")),
                    "yesterday_oi": safe_json(row.get("YesterdayOpenInterest")),
                    "bid_price": safe_json(row.get("BidPrice")),
                    "ask_price": safe_json(row.get("AskPrice")),
                    "bid_volume": safe_json(row.get("BidVolume")),
                    "ask_volume": safe_json(row.get("AskVolume")),
                    "underlying_last": safe_json(row.get("UnderlyingLast")),
                    "underlying_close": safe_json(row.get("UnderlyingClose")),
                    "source": "algotik"
                })

            if records:
                db[COL_OPT_SNAP].insert_many(records, ordered=False)
                total += len(records)

                # 🆕 تحلیل + ذخیره در option_history
                try:
                    rf = get_current_rf()
                    analysis_docs = analyze_snapshot(records, risk_free_rate=rf)
                    if analysis_docs:
                        ops = [
                            UpdateOne(
                                {"symbol": d["symbol"], "time": d["time"]},
                                {"$set": d},
                                upsert=True,
                            )
                            for d in analysis_docs
                        ]
                        res = db[COL_OPT_HISTORY].bulk_write(ops, ordered=False)
                        log_event(
                            "option_analyzed",
                            f"{ua}: {len(analysis_docs)} docs → option_history",
                            {"underlying": ua,
                             "docs": len(analysis_docs),
                             "upserted": res.upserted_count,
                             "modified": res.modified_count},
                        )
                except Exception as e:
                    log_event("analyze_err", f"{ua}: {e}", {"underlying": ua, "error": str(e)})

            results.append({"underlying": ua, "status": "ok", "contracts": len(records)})
            log_event("option_snapshot_ok", f"{ua}: {len(records)} contracts", {"underlying": ua, "count": len(records)})
        except Exception as e:
            log_event("option_snapshot_err", f"{ua}: {e}", {"underlying": ua, "error": str(e)})
            results.append({"underlying": ua, "status": "error", "error": str(e)})

    return {"timestamp": timestamp.isoformat(), "results": results, "total_contracts": total}


# ==================== Option Daily (fast, raw TSETMC) ====================
TSETMC_SESSION = requests.Session()
TSETMC_SESSION.headers.update({
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "Accept": "application/json,text/plain,*/*",
    "Referer": "https://www.tsetmc.com/"
})

def fetch_option_daily_one(ins_code: str, symbol: str, underlying: str, meta: Dict) -> int:
    """Fetch daily OHLCV for one contract from TSETMC raw endpoint (fast)."""
    try:
        url = f"https://cdn.tsetmc.com/api/ClosingPrice/GetClosingPriceDailyList/{ins_code}/0"
        r = TSETMC_SESSION.get(url, timeout=10)
        if r.status_code != 200:
            return 0
        data = r.json()
        rows = data.get("closingPriceDaily", [])
        if not rows:
            return 0

        ops = []
        for row in rows:
            d_even = row.get("dEven")
            if not d_even or d_even <= 0: continue
            # dEven = YYYYMMDD
            s = str(int(d_even))
            if len(s) != 8: continue
            date_key = f"{s[:4]}-{s[4:6]}-{s[6:8]}"

            doc = {
                "ins_code": ins_code,
                "symbol": symbol,
                "underlying": underlying,
                "date": date_key,
                "open": float(row.get("priceFirst", 0) or 0),
                "high": float(row.get("priceMax", 0) or 0),
                "low": float(row.get("priceMin", 0) or 0),
                "close": float(row.get("pClosing", 0) or 0),
                "last": float(row.get("pDrCotVal", 0) or 0),
                "volume": float(row.get("qTotTran5J", 0) or 0),
                "value": float(row.get("qTotCap", 0) or 0),
                "trade_count": int(row.get("zTotTran", 0) or 0),
                "yesterday": float(row.get("priceYesterday", 0) or 0),
                "change": float(row.get("priceChange", 0) or 0),
                **meta,
                "source": "tsetmc-raw",
                "fetchedAt": datetime.utcnow()
            }
            ops.append(UpdateOne(
                {"ins_code": ins_code, "date": date_key},
                {"$set": doc},
                upsert=True
            ))

        if ops:
            db[COL_OPT_DAILY].bulk_write(ops, ordered=False)
        return len(ops)
    except Exception as e:
        return 0


def fetch_option_daily_job(job_id: str, underlyings: List[str], force: bool):
    """Background job: fetch daily OHLCV for all active option contracts."""
    try:
        job_set(job_id, status="RUNNING", started_at=datetime.utcnow().isoformat())
        total_contracts = 0
        total_records = 0
        processed = 0
        errors = 0

        # Step 1: collect all contracts from market
        all_contracts = []
        for ua in underlyings:
            try:
                df = att.get_option_market(underlying=ua, progress=False)
                if df is None or len(df) == 0: continue
                for _, row in df.iterrows():
                    ins_code = str(row.get("InsCode", ""))
                    if not ins_code: continue
                    all_contracts.append({
                        "ins_code": ins_code,
                        "symbol": safe_json(row.get("Symbol")),
                        "underlying": ua,
                        "meta": {
                            "strike": safe_json(row.get("Strike")),
                            "end_date": safe_json(row.get("EndDate")),
                            "option_type": safe_json(row.get("OptionType")),
                            "contract_size": safe_json(row.get("ContractSize")),
                        }
                    })
            except Exception as e:
                log_event("option_daily_market_err", f"{ua}: {e}", {"underlying": ua})

        total_contracts = len(all_contracts)
        job_set(job_id, total=total_contracts, processed=0, message=f"کشف {total_contracts} قرارداد")

        # Step 2: skip already-fetched contracts unless force
        if not force:
            today_str = datetime.utcnow().strftime("%Y-%m-%d")
            to_process = []
            for c in all_contracts:
                existing = db[COL_OPT_DAILY].find_one({
                    "ins_code": c["ins_code"],
                    "fetchedAt": {"$gte": datetime.utcnow() - timedelta(hours=12)}
                })
                if not existing:
                    to_process.append(c)
            all_contracts = to_process
            job_set(job_id, message=f"{len(all_contracts)} قرارداد جدید (بقیه تازه fetch شده)")

        # Step 3: parallel fetch with ThreadPoolExecutor
        def worker(c):
            return fetch_option_daily_one(c["ins_code"], c["symbol"], c["underlying"], c["meta"])

        with ThreadPoolExecutor(max_workers=8) as executor:
            futures = [executor.submit(worker, c) for c in all_contracts]
            for i, fut in enumerate(futures):
                try:
                    n = fut.result(timeout=30)
                    total_records += n
                except Exception:
                    errors += 1
                processed += 1
                if processed % 20 == 0 or processed == total_contracts:
                    job_set(job_id, processed=processed, total=total_contracts,
                            records=total_records, errors=errors,
                            message=f"{processed}/{total_contracts} قرارداد")

        job_set(job_id, status="DONE", finished_at=datetime.utcnow().isoformat(),
                total=total_contracts, processed=total_contracts,
                records=total_records, errors=errors,
                message=f"✅ {total_records} رکورد از {total_contracts} قرارداد")
        log_event("option_daily_ok", f"{total_records} records from {total_contracts} contracts")
    except Exception as e:
        job_set(job_id, status="FAILED", error=str(e), finished_at=datetime.utcnow().isoformat())
        log_event("option_daily_err", str(e))


# ==================== Chart Data ====================
def fetch_chart_sync(symbol: str, interval: str, months: int):
    """Fetch chart data for a symbol at any interval."""
    # interval mapping to date range
    # 1min, 5min, 15min, 30min, 1h, 1d
    end_date = datetime.utcnow().date()
    start_date = end_date - timedelta(days=months * 30)
    start_str = start_date.strftime("%Y-%m-%d")
    end_str = end_date.strftime("%Y-%m-%d")

    # algotik supports: tick, 1min, 5min, 15min, 30min, 1h, 4h, 12h
    ak_interval = interval
    if interval == "1d":
        # use daily history instead
        try:
            found = att.searchInstrument(symbol)
            if not found or not found[0].get("insCode"):
                return []
            hist = att.get_daily_history(found[0]["insCode"]) if hasattr(att, "get_daily_history") else None
            if hist is None:
                # fallback to get_history
                hist = att.get_history(symbol=symbol, start=start_str, end=end_str)
            if hist is None or len(hist) == 0: return []
            out = []
            for idx, row in hist.iterrows():
                ts = idx.to_pydatetime() if hasattr(idx, 'to_pydatetime') else idx
                out.append({
                    "time": int(ts.timestamp()),
                    "open": float(row.get("Open", 0)),
                    "high": float(row.get("High", 0)),
                    "low": float(row.get("Low", 0)),
                    "close": float(row.get("Close", 0)),
                    "volume": float(row.get("Volume", 0)),
                })
            return out
        except Exception as e:
            return []

    df = att.get_intraday(symbol=symbol, start=start_str, end=end_str,
                          interval=ak_interval, progress=False)
    if df is None or len(df) == 0:
        return []
    out = []
    for ts, row in df.iterrows():
        t = ts.to_pydatetime() if hasattr(ts, 'to_pydatetime') else ts
        out.append({
            "time": int(t.timestamp()),
            "open": float(row.get("Open", 0)),
            "high": float(row.get("High", 0)),
            "low": float(row.get("Low", 0)),
            "close": float(row.get("Close", 0)),
            "volume": float(row.get("Volume", 0)),
        })
    return out


# ==================== Routes ====================
@app.get("/health")
async def health():
    try:
        db.command("ping")
        return {"status": "ok", "mongo": "connected", "time": datetime.utcnow().isoformat()}
    except Exception as e:
        return JSONResponse(status_code=503, content={"status": "error", "error": str(e)})


@app.get("/status")
async def status():
    try:
        stock_count = db[COL_STOCKS].count_documents({"source": "algotik"})
        opt_snap_count = db[COL_OPT_SNAP].count_documents({})
        opt_daily_count = db[COL_OPT_DAILY].count_documents({})
        latest_snap = db[COL_OPT_SNAP].find_one({}, sort=[("timestamp", DESCENDING)])
        latest_daily = db[COL_OPT_DAILY].find_one({}, sort=[("date", DESCENDING)])
        opt_underlyings = db[COL_OPT_SNAP].distinct("underlying")
        return {
            "stocks_intraday_count": stock_count,
            "option_snapshots_count": opt_snap_count,
            "option_daily_count": opt_daily_count,
            "option_underlyings": opt_underlyings,
            "latest_snapshot_at": latest_snap.get("timestamp").isoformat() if latest_snap and latest_snap.get("timestamp") else None,
            "latest_daily_date": latest_daily.get("date") if latest_daily else None,
        }
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.post("/backfill/stocks/wait")
async def backfill_stocks_wait(req: StockBackfillReq):
    symbols = req.symbols or get_monitored_symbols()
    if not symbols:
        raise HTTPException(400, "No symbols")
    months = min(max(int(req.months or 6), 1), 24)
    return await backfill_stocks_async(symbols, months)


@app.post("/backfill/options")
async def backfill_options(req: OptionSnapshotReq):
    underlyings = req.underlyings or get_monitored_symbols()
    if not underlyings:
        raise HTTPException(400, "No underlyings")
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, lambda: fetch_option_snapshot_sync(underlyings))


@app.post("/options/daily-job")
async def options_daily_job(req: OptionDailyJobReq):
    """Start a background job for option daily OHLCV."""
    underlyings = req.underlyings or get_monitored_symbols()
    if not underlyings:
        raise HTTPException(400, "No underlyings")
    job_id = str(uuid.uuid4())
    job_set(job_id, status="QUEUED", total=0, processed=0, records=0, errors=0,
            message="در صف", underlyings=underlyings, force=req.force)
    threading.Thread(target=fetch_option_daily_job,
                     args=(job_id, underlyings, req.force),
                     daemon=True).start()
    return {"job_id": job_id, "status": "QUEUED", "underlyings": underlyings}


@app.get("/jobs/{job_id}")
async def get_job(job_id: str):
    j = job_get(job_id)
    if not j:
        raise HTTPException(404, "Job not found")
    return j


@app.get("/jobs")
async def list_jobs(limit: int = 20):
    with JOBS_LOCK:
        items = list(JOBS.values())[-limit:]
    return {"jobs": items}


@app.post("/options/history")
async def options_history(req: OptionHistoryReq):
    """Bulk fetch option history for one symbol's active contracts."""
    job_id = str(uuid.uuid4())
    job_set(job_id, status="QUEUED", total=0, processed=0, message="در صف")
    threading.Thread(target=fetch_option_daily_job,
                     args=(job_id, [req.symbol], True),
                     daemon=True).start()
    return {"job_id": job_id, "status": "QUEUED"}


@app.get("/chart/{symbol}")
async def chart(symbol: str, interval: str = Query("1min"), months: int = Query(6)):
    """Get chart data for a symbol. Falls back to online fetch if local data missing."""
    interval = interval.strip()
    allowed = {"1min", "3min", "5min", "10min", "15min", "30min", "1h", "1d"}
    if interval not in allowed:
        raise HTTPException(400, f"interval نامعتبر: {interval}")
    months = min(max(int(months or 6), 1), 24)
    loop = asyncio.get_event_loop()
    candles = await loop.run_in_executor(None, lambda: fetch_chart_sync(symbol, interval, months))
    return {"symbol": symbol, "interval": interval, "months": months,
            "count": len(candles), "candles": candles}


@app.post("/backfill/all")
async def backfill_all(req: FullBackfillReq):
    symbols = get_monitored_symbols()
    if not symbols:
        raise HTTPException(400, "No monitored symbols")
    months = min(max(int(req.months or 6), 1), 24)
    stock_result = await backfill_stocks_async(symbols, months)
    option_result = None
    if req.with_options:
        loop = asyncio.get_event_loop()
        option_result = await loop.run_in_executor(None, lambda: fetch_option_snapshot_sync(symbols))
    return {"stocks": stock_result, "options": option_result}


@app.get("/logs")
async def get_logs(limit: int = 100):
    limit = min(max(limit, 1), 500)
    docs = db[COL_LOG].find({}, {"_id": 0}).sort("at", DESCENDING).limit(limit)
    return {"logs": [{**d, "at": d["at"].isoformat() if d.get("at") else None} for d in docs]}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")