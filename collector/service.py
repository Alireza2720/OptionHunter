#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""AlgoTik Collector — Unified Data Pipeline"""
import os, sys, threading, signal, time, re
import pandas as pd
from datetime import datetime, timezone
from typing import Optional, List

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

sys.path.insert(0, os.path.dirname(__file__))

from pipeline.db import (
    cleanup_legacy_indexes, ensure_indexes, get_db, log,
    COL_RISK_FREE, COL_MONITORED,
    COL_CANDLES_BASE, COL_CANDLES_DAILY,
    COL_OPTION_HISTORY, COL_OPTION_SNAPSHOTS,
    COL_LOG,
)
from pipeline import symbols as sym_mod
from pipeline import stocks as stk_mod
from pipeline import options as opt_mod
from pipeline import aggregate as agg_mod
from pipeline import jobs as job_mod
from pipeline import report as rpt_mod
from pipeline import live as live_mod
from pipeline import option_greeks as og_mod

# ---------- Global locks & shutdown ----------
_backfill_lock = threading.Lock()
_shutdown_event = threading.Event()


# ---------- Date sanitization ----------
import unicodedata

def _clean_date(s: str) -> str:
    """
    پاک‌سازی ورودی تاریخ برای algotik_tse:
    - حذف کاراکترهای نامرئی (Cf)
    - تبدیل / به - (algotik_tse فقط dash قبول می‌کنه)
    - فرمت نهایی: YYYY-MM-DD
    """
    if s is None:
        return s
    s = str(s)
    original = s
    # حذف کاراکترهای Cf نامرئی
    s = ''.join(c for c in s if unicodedata.category(c) != 'Cf')
    s = s.strip()
    # 🆕 تبدیل به dash — algotik_tse با slash کار نمی‌کنه
    s = s.replace('/', '-')
    s = re.sub(r'-+', '-', s)
    if original != s:
        print(f'🧹  _clean_date: {repr(original)} → {repr(s)}')
    return s

# ---------- Risk-free ----------
_rf_cache = {'rate': 0.42, 'date': None}

def get_current_rf(force=False):
    """Read risk-free rate from the shared cache collection.

    The cache is populated externally (backend risk-free.job.js reads
    from a treasury data source and writes to risk_free_cache).
    """
    today = datetime.now(timezone.utc).date()
    today_str = today.isoformat()
    if not force and _rf_cache['date'] == today:
        return _rf_cache['rate']

    db = get_db()
    if not force:
        doc = db[COL_RISK_FREE].find_one({'date': today_str})
        if doc and doc.get('rate'):
            _rf_cache['rate'] = float(doc['rate'])
            _rf_cache['date'] = today
            return _rf_cache['rate']

    # Fallback: latest available entry (any date)
    try:
        doc = db[COL_RISK_FREE].find_one({}, sort=[('date', -1)])
        if doc and doc.get('rate'):
            rate = float(doc['rate'])
            _rf_cache['rate'] = rate
            log('rf_cached', 'risk-free from cache: {:.4f} ({})'.format(rate, doc.get('date')))
            return rate
    except Exception as e:
        log('rf_error', str(e))

    # Last resort: in-memory default
    return _rf_cache['rate']


# ---------- FastAPI ----------
app = FastAPI(title='OptionHunter Collector')


# ---------- Graceful shutdown ----------
def _install_signal_handlers():
    def _handler(signum, frame):
        print(f'🛑 Received signal {signum} — shutting down gracefully...')
        _shutdown_event.set()

        # ticker رو متوقف کن
        try:
            live_mod.stop_ticker()
        except Exception:
            pass

        # 60 ثانیه مهلت برای backfill فعلی
        acquired = False
        for _ in range(60):
            if _backfill_lock.acquire(blocking=False):
                _backfill_lock.release()
                acquired = True
                break
            time.sleep(1)

        if not acquired:
            print('⚠️ Backfill thread did not stop in 60s — forcing exit')
        else:
            print('✅ Backfill stopped cleanly')

        raise SystemExit(0)

    signal.signal(signal.SIGTERM, _handler)
    signal.signal(signal.SIGINT, _handler)
    print('✅ signal handlers installed')


@app.on_event('startup')
def _startup():
    ensure_indexes()
    cleanup_legacy_indexes()
    print('✅ indexes ready')
    # initial RF
    try:
        r = get_current_rf(force=True)
        print(f'✅ initial RF: {r:.4f}')
    except Exception as e:
        print(f'⚠️ RF init failed: {e}')

    _install_signal_handlers()


# ---------- Health ----------
@app.get('/health')
def health():
    return {
        'status': 'ok',
        'mongo': 'connected',
        'time': datetime.now(timezone.utc).isoformat(),
        'ticker': live_mod.is_running(),
        'backfill_running': _backfill_lock.locked(),
        'shutdown': _shutdown_event.is_set(),
    }

@app.get('/status')
def status():
    db = get_db()
    # 🆕 estimated_document_count = O(1) از metadata (به جای اسکن کامل)
    return {
        'symbols_total': db[COL_MONITORED].estimated_document_count(),
        'symbols_enabled': db[COL_MONITORED].count_documents({'enabled': True}),
        'candles_base': db[COL_CANDLES_BASE].estimated_document_count(),
        'candles_daily': db[COL_CANDLES_DAILY].estimated_document_count(),
        'option_history': db[COL_OPTION_HISTORY].estimated_document_count(),
        'option_snapshots': db[COL_OPTION_SNAPSHOTS].estimated_document_count(),
        'risk_free': get_current_rf(),
        'ticker': live_mod.get_stats(),
        'backfill_running': _backfill_lock.locked(),
    }


# ---------- Live Market (برای tick.job.js) ----------
def _tsetmc_row_to_live(r):
    """Normalize a TSETMC MarketWatch row to the shape the backend expects."""
    try:
        sym = r.get('lva') or r.get('lVal18AFC') or r.get('symbol')
        if not sym:
            return None
        last = float(r.get('pDrCotVal') or r.get('last') or 0)
        close = float(r.get('pcl') or r.get('pClosing') or 0)
        po = float(r.get('pOpening') or 0)
        pmax = float(r.get('pmax') or 0)
        pmin = float(r.get('pmin') or 0)
        vol = float(r.get('qTotTran5J') or 0)
        tno = float(r.get('zTotTran') or 0)
        return {
            'Symbol': sym,
            'Last': last,
            'Close': close,
            'pl': last,
            'Open': po,
            'pf': po,
            'MaxAllowed': pmax,
            'tmax': pmax,
            'MinAllowed': pmin,
            'tmin': pmin,
            'Volume': vol,
            'tvol': vol,
            'TradeCount': tno,
            'tno': tno,
        }
    except Exception:
        return None


@app.get('/live-market')
def live_market():
    """Snapshot live کل بازار (سهام پایه) from TSETMC MarketWatch."""
    try:
        from pipeline.tsetmc_client import get_client, TSETMCError
        client = get_client()
        mw = client.market_watch(paper_types=(1, 2, 3))
        records = []
        for r in (mw or []):
            norm = _tsetmc_row_to_live(r)
            if norm:
                records.append(norm)
        return {
            'count': len(records),
            'data': records,
            'at': datetime.now(timezone.utc).isoformat(),
        }
    except Exception as e:
        log('live_market_err', str(e))
        return {'count': 0, 'data': [], 'error': str(e)}


@app.get('/live-market/{symbol}')
def live_symbol(symbol: str):
    """Snapshot live یک نماد from TSETMC MarketWatch."""
    try:
        from pipeline.tsetmc_client import get_client
        from pipeline.tsetmc_parser import normalize_fa
        client = get_client()
        mw = client.market_watch(paper_types=(1, 2, 3))
        target = normalize_fa(symbol)
        records = []
        for r in (mw or []):
            sym = r.get('lva') or r.get('lVal18AFC')
            if not sym or normalize_fa(sym) != target:
                continue
            norm = _tsetmc_row_to_live(r)
            if norm:
                records.append(norm)
        return {'count': len(records), 'data': records}
    except Exception as e:
        return {'count': 0, 'data': [], 'error': str(e)}


# ---------- Logs ----------
@app.get('/logs')
def get_logs(limit: int = 100):
    db = get_db()
    docs = list(db[COL_LOG].find({}).sort('at', -1).limit(limit))
    for d in docs:
        d['_id'] = str(d['_id'])
    return {'logs': docs}


# ---------- Symbols ----------
class SymbolIn(BaseModel):
    symbol: str
    name: Optional[str] = None

class EnabledIn(BaseModel):
    enabled: bool

@app.get('/symbols')
def list_symbols():
    return sym_mod.list_symbols()

@app.post('/symbols')
def add_symbol(p: SymbolIn):
    sym_mod.add_symbol(p.symbol, p.name)
    return {'ok': True}

@app.delete('/symbols/{symbol}')
def remove_symbol(symbol: str):
    return {'ok': sym_mod.remove_symbol(symbol)}

@app.put('/symbols/{symbol}/enabled')
def set_enabled_endpoint(symbol: str, p: EnabledIn):
    return {'ok': sym_mod.set_enabled(symbol, p.enabled)}


# ---------- Jobs ----------
class FullBackfillIn(BaseModel):
    symbols: Optional[List[str]] = None
    dateFrom: str
    dateTo: str
    includeStockIntraday: bool = True
    includeStockDaily: bool = True
    includeOptionHistory: bool = True
    includeOptionSnapshot: bool = True
    includeOptionMigration: bool = True
    includeAggregate: bool = True


def _run_full_backfill(job_id: str, payload: dict):
    """
    Wrapper: فقط یک backfill در هر لحظه اجرا می‌شه.
    اگه backfill دیگه‌ای در حال اجراست، این job در صف می‌مونه.
    """
    # اگه job دیگه‌ای در حال اجراست، پیام بذار و صبر کن
    if _backfill_lock.locked():
        try:
            job_mod.update_job(
                job_id,
                status='QUEUED',
                last_message='در انتظار اتمام backfill قبلی...'
            )
        except Exception:
            pass

    with _backfill_lock:
        _run_full_backfill_locked(job_id, payload)


def _run_full_backfill_locked(job_id: str, payload: dict):
    """Actual backfill logic — با قفل سراسری اجرا می‌شه."""
    try:
        # اگه قبل از گرفتن قفل کنسل شده یا داریم shutdown می‌کنیم
        if job_mod.is_cancelled(job_id) or _shutdown_event.is_set():
            job_mod.finish_job(job_id, 'CANCELLED')
            return

        job_mod.update_job(
            job_id,
            status='RUNNING',
            started_at=datetime.now(timezone.utc)
        )
        symbols = payload.get('symbols') or sym_mod.get_enabled_names()

        # 🆕 دیباگ دقیق: بایت‌های واقعی ورودی
        raw_from = payload.get('dateFrom')
        raw_to = payload.get('dateTo')
        print(f'📅 RAW: from={repr(raw_from)} to={repr(raw_to)}')

        date_from = _clean_date(raw_from)
        date_to   = _clean_date(raw_to)
        print(f'📅 CLEAN: from={repr(date_from)} to={repr(date_to)}')

        stats = {
            'stock_intraday':   {'symbols_done': 0, 'candles': 0, 'errors': 0},
            'stock_daily':      {'symbols_done': 0, 'candles': 0, 'errors': 0},
            'option_history':   {'symbols_done': 0, 'contracts': 0, 'with_iv': 0, 'errors': 0},
            'option_snapshot':  {'symbols_done': 0, 'ticks': 0},
            'option_migration': {'total_processed': 0, 'written': 0, 'skipped': 0, 'errors': 0},
            'aggregate':        {'symbols_done': 0, 'candles': 0},
        }

        # 🆕 ثبت همه‌ی فازها از ابتدا → UI از لحظه‌ی اول همه رو می‌بینه
        _PHASE_FLAGS = [
            ('stock_intraday',   'includeStockIntraday'),
            ('stock_daily',      'includeStockDaily'),
            ('option_history',   'includeOptionHistory'),
            ('option_snapshot',  'includeOptionSnapshot'),
            ('option_migration', 'includeOptionMigration'),
            ('aggregate',        'includeAggregate'),
        ]
        for ph_name, flag in _PHASE_FLAGS:
            enabled = bool(payload.get(flag))
            job_mod.set_phase(job_id, ph_name, {
                'current': 0,
                'total': len(symbols) if enabled else 0,
                'status': 'PENDING' if enabled else 'SKIPPED',
                'stats': stats.get(ph_name, {}),
            })

        # ============================================================
        # Phase 1: stock intraday (1m)
        # ============================================================
        if payload.get('includeStockIntraday'):
            for i, sym in enumerate(symbols, 1):
                if job_mod.is_cancelled(job_id) or _shutdown_event.is_set():
                    job_mod.finish_job(job_id, 'CANCELLED')
                    return

                # قبل از fetch → RUNNING
                job_mod.set_phase(job_id, 'stock_intraday', {
                    'current': i - 1, 'total': len(symbols),
                    'current_symbol': sym, 'status': 'RUNNING',
                    'stats': stats['stock_intraday'],
                })

                try:
                    records, err = stk_mod.fetch_intraday_1m(sym, date_from, date_to)
                    if err:
                        stats['stock_intraday']['errors'] += 1
                        job_mod.append_error(job_id, f'{sym}: {err}')
                    elif records:
                        written = stk_mod.write_base(records)
                        stats['stock_intraday']['candles'] += written
                except Exception as e:
                    stats['stock_intraday']['errors'] += 1
                    job_mod.append_error(job_id, f'{sym}: {e}')

                stats['stock_intraday']['symbols_done'] = i
                job_mod.set_phase(job_id, 'stock_intraday', {
                    'current': i, 'total': len(symbols),
                    'current_symbol': sym, 'status': 'RUNNING',
                    'stats': stats['stock_intraday'],
                })

            job_mod.set_phase(job_id, 'stock_intraday', {
                'current': len(symbols), 'total': len(symbols),
                'status': 'DONE', 'stats': stats['stock_intraday'],
            })

        # ============================================================
        # Phase 2: stock daily
        # ============================================================
        if payload.get('includeStockDaily'):
            for i, sym in enumerate(symbols, 1):
                if job_mod.is_cancelled(job_id) or _shutdown_event.is_set():
                    job_mod.finish_job(job_id, 'CANCELLED')
                    return

                job_mod.set_phase(job_id, 'stock_daily', {
                    'current': i - 1, 'total': len(symbols),
                    'current_symbol': sym, 'status': 'RUNNING',
                    'stats': stats['stock_daily'],
                })

                try:
                    records, err = stk_mod.fetch_daily(sym, date_from, date_to)
                    if err:
                        stats['stock_daily']['errors'] += 1
                        job_mod.append_error(job_id, f'{sym} daily: {err}')
                    elif records:
                        written = stk_mod.write_daily(records)
                        stats['stock_daily']['candles'] += written
                except Exception as e:
                    stats['stock_daily']['errors'] += 1
                    job_mod.append_error(job_id, f'{sym} daily: {e}')

                stats['stock_daily']['symbols_done'] = i
                job_mod.set_phase(job_id, 'stock_daily', {
                    'current': i, 'total': len(symbols),
                    'current_symbol': sym, 'status': 'RUNNING',
                    'stats': stats['stock_daily'],
                })

            job_mod.set_phase(job_id, 'stock_daily', {
                'current': len(symbols), 'total': len(symbols),
                'status': 'DONE', 'stats': stats['stock_daily'],
            })

        # ============================================================
        # Phase 3: option history (IV/Greeks)
        # ============================================================
        if payload.get('includeOptionHistory'):
            for i, sym in enumerate(symbols, 1):
                if job_mod.is_cancelled(job_id) or _shutdown_event.is_set():
                    job_mod.finish_job(job_id, 'CANCELLED')
                    return

                job_mod.set_phase(job_id, 'option_history', {
                    'current': i - 1, 'total': len(symbols),
                    'current_symbol': sym, 'status': 'RUNNING',
                    'stats': stats['option_history'],
                })

                try:
                    # Historical migration from TSETMC: OHLCV + ClientType
                    result = opt_mod.migrate_from_tsetmc(
                        underlyings=[sym],
                        dry_run=False,
                        log_fn=lambda m: log('opt_hist', m),
                    )
                    written = int(result.get('records_inserted', 0) or 0)
                    stats['option_history']['contracts'] += written
                    stats['option_history']['with_iv'] += 0  # IV computed later
                    if written == 0:
                        stats['option_history']['errors'] += 1
                        job_mod.append_warning(job_id, '{}: no historical option data'.format(sym))
                except Exception as e:
                    stats['option_history']['errors'] += 1
                    job_mod.append_error(job_id, '{} options: {}'.format(sym, e))

                stats['option_history']['symbols_done'] = i
                job_mod.set_phase(job_id, 'option_history', {
                    'current': i, 'total': len(symbols),
                    'current_symbol': sym, 'status': 'RUNNING',
                    'stats': stats['option_history'],
                })

            job_mod.set_phase(job_id, 'option_history', {
                'current': len(symbols), 'total': len(symbols),
                'status': 'DONE', 'stats': stats['option_history'],
            })

        # ============================================================
        # Phase 4: option snapshot ticks
        # ============================================================
        if payload.get('includeOptionSnapshot'):
            for i, sym in enumerate(symbols, 1):
                if job_mod.is_cancelled(job_id) or _shutdown_event.is_set():
                    job_mod.finish_job(job_id, 'CANCELLED')
                    return

                job_mod.set_phase(job_id, 'option_snapshot', {
                    'current': i - 1, 'total': len(symbols),
                    'current_symbol': sym, 'status': 'RUNNING',
                    'stats': stats['option_snapshot'],
                })

                try:
                    import json
                    df, err = opt_mod.fetch_market(sym)
                    if df is not None and len(df) > 0:
                        raw = json.loads(df.to_json(orient='records', date_format='iso'))
                        n = opt_mod.write_snapshot_ticks(sym, raw)
                        stats['option_snapshot']['ticks'] += n
                except Exception as e:
                    job_mod.append_error(job_id, f'{sym} snapshot: {e}')

                stats['option_snapshot']['symbols_done'] = i
                job_mod.set_phase(job_id, 'option_snapshot', {
                    'current': i, 'total': len(symbols),
                    'current_symbol': sym, 'status': 'RUNNING',
                    'stats': stats['option_snapshot'],
                })

            job_mod.set_phase(job_id, 'option_snapshot', {
                'current': len(symbols), 'total': len(symbols),
                'status': 'DONE', 'stats': stats['option_snapshot'],
            })

        # ============================================================
        # Phase 4.5: options migration (daily → history)
        # ============================================================
        # ⚠️ Skip phase 5 if running via CLI backfill (--full) to avoid double work
        _skip_phase5 = os.getenv("SKIP_PHASE5_MIGRATION", "").lower() in ("1", "true", "yes")
        if payload.get('includeOptionMigration') and not _skip_phase5:
            if job_mod.is_cancelled(job_id) or _shutdown_event.is_set():
                job_mod.finish_job(job_id, 'CANCELLED')
                return

            job_mod.set_phase(job_id, 'option_migration', {
                'current': 0, 'total': len(symbols),
                'status': 'RUNNING', 'stats': stats['option_migration'],
            })

            try:
                result = opt_mod.migrate_from_tsetmc(
                    underlyings=symbols,
                    dry_run=False,
                )
                stats['option_migration'] = result
                job_mod.set_phase(job_id, 'option_migration', {
                    'current': len(symbols), 'total': len(symbols),
                    'status': 'DONE', 'stats': result,
                })
            except Exception as e:
                stats['option_migration']['errors'] += 1
                job_mod.append_error(job_id, f'option migration: {e}')
                job_mod.set_phase(job_id, 'option_migration', {
                    'current': 0, 'total': len(symbols),
                    'status': 'FAILED', 'stats': stats['option_migration'],
                })

        # ============================================================
        # Phase 4.7: Auto-enrichment (whenever option_history was written)
        # ============================================================
        _skip_enrich = os.getenv("SKIP_AUTO_ENRICH", "").lower() in ("1", "true", "yes")
        if not _skip_enrich and payload.get('includeOptionHistory'):
            job_mod.set_phase(job_id, 'enrichment', {
                'current': 0, 'total': 1,
                'status': 'RUNNING',
                'stats': {'msg': 'enriching options...'},
            })
            try:
                from option_reconstruction.spread_model import load_spread_model, build_spread_model
                from option_reconstruction.enricher import enrich_collection
                db_local = get_db()
                if not load_spread_model(db_local):
                    build_spread_model(db_local, log_fn=lambda m: log('enrich_model', m))
                estats = enrich_collection(db_local, log_fn=lambda m: log('enrich', m))
                job_mod.set_phase(job_id, 'enrichment', {
                    'current': 1, 'total': 1,
                    'status': 'DONE',
                    'stats': estats,
                })
            except Exception as _e:
                job_mod.set_phase(job_id, 'enrichment', {
                    'current': 0, 'total': 1,
                    'status': 'FAILED',
                    'stats': {'error': str(_e)[:200]},
                })
        # ============================================================
        # Phase 5: aggregate (TF candles)
        # ============================================================
        if payload.get('includeAggregate'):
            for i, sym in enumerate(symbols, 1):
                if job_mod.is_cancelled(job_id) or _shutdown_event.is_set():
                    job_mod.finish_job(job_id, 'CANCELLED')
                    return

                job_mod.set_phase(job_id, 'aggregate', {
                    'current': i - 1, 'total': len(symbols),
                    'current_symbol': sym, 'status': 'RUNNING',
                    'stats': stats['aggregate'],
                })

                try:
                    r = agg_mod.rebuild_symbol(sym)
                    stats['aggregate']['candles'] += r.get('written', 0)
                except Exception as e:
                    job_mod.append_error(job_id, f'{sym} aggregate: {e}')

                stats['aggregate']['symbols_done'] = i
                job_mod.set_phase(job_id, 'aggregate', {
                    'current': i, 'total': len(symbols),
                    'current_symbol': sym, 'status': 'RUNNING',
                    'stats': stats['aggregate'],
                })

            job_mod.set_phase(job_id, 'aggregate', {
                'current': len(symbols), 'total': len(symbols),
                'status': 'DONE', 'stats': stats['aggregate'],
            })

        # ============================================================
        # Done
        # ============================================================
        job_mod.finish_job(job_id, 'DONE', {'stats': stats})

    except Exception as e:
        import traceback
        tb = traceback.format_exc()
        job_mod.append_error(job_id, f'{e}\n{tb}')
        job_mod.finish_job(job_id, 'FAILED', {'error': str(e)})


@app.post('/jobs/full-backfill')
def start_full_backfill(p: FullBackfillIn):
    payload = p.dict()
    job = job_mod.create_job('full-backfill', payload)
    t = threading.Thread(
        target=_run_full_backfill,
        args=(job['_id'], payload),
        daemon=True,
    )
    t.start()
    return {
        'jobId': job['_id'],
        'status': 'QUEUED',
        'queued_behind_lock': _backfill_lock.locked(),
    }


@app.get('/jobs/{job_id}')
def get_job(job_id: str):
    j = job_mod.get_job(job_id)
    if not j:
        raise HTTPException(404, 'job not found')
    j['_id'] = str(j['_id'])
    return j


@app.get('/jobs')
def list_jobs(limit: int = 30):
    js = job_mod.list_jobs(limit)
    for j in js:
        j['_id'] = str(j['_id'])
    return js


@app.post('/jobs/{job_id}/cancel')
def cancel_job(job_id: str):
    job_mod.cancel_job(job_id)
    return {'ok': True}


# ---------- Coverage ----------
@app.get('/coverage')
def coverage():
    return {'symbols': rpt_mod.coverage_report()}


# ---------- Enriched Option Chain (Phase 1 — TSETMC-based) ----------
from fastapi import Request as _FRequest, Response as _FResponse

@app.get('/chain/enriched')
def chain_enriched(fresh: int = 0, meta: int = 0):
    """Full enriched option chain from TSETMC (optionschool24-compatible).

    Query params:
        fresh=1     force cache bypass (recompute now)
        meta=1      wrap in {count, data, meta} instead of plain array
    """
    try:
        data = og_mod.get_chain_cached(force=(fresh == 1))
        meta_info = og_mod.get_chain_meta() or {}
        if meta == 1:
            return {
                'count': len(data),
                'data': data,
                'meta': meta_info,
            }
        return _FResponse(
            content=json.dumps(data),
            media_type='application/json',
            headers={
                'X-Chain-Count': str(len(data)),
                'X-Chain-Compute-Ms': str(meta_info.get('computeMs', 0)),
            },
        )
    except Exception as e:
        import traceback
        log('chain_enriched_err', str(e)[:200])
        return _FResponse(
            content=json.dumps({'error': str(e)}),
            media_type='application/json',
            status_code=500,
        )


@app.get('/chain/enriched/status')
def chain_enriched_status():
    """Metadata only: last refresh time, count, compute ms."""
    meta_info = og_mod.get_chain_meta()
    if not meta_info:
        return {'ready': False}
    return {'ready': True, **meta_info}


@app.get('/chain/diagnose')
def chain_diagnose():
    """Diagnostic: raw MarketWatch field names."""
    return og_mod.diagnose_market_watch()


@app.post('/chain/invalidate')
def chain_invalidate():
    """Force cache invalidation."""
    og_mod.invalidate_caches()
    return {'ok': True}


# ---------- Enriched Option Chain (Phase 1 — TSETMC-based) ----------
from fastapi import Request as _FRequest, Response as _FResponse

@app.get('/chain/enriched')
def chain_enriched(fresh: int = 0, meta: int = 0):
    """Full enriched option chain from TSETMC (optionschool24-compatible).

    Query params:
        fresh=1     force cache bypass (recompute now)
        meta=1      wrap in {count, data, meta} instead of plain array
    """
    try:
        data = og_mod.get_chain_cached(force=(fresh == 1))
        meta_info = og_mod.get_chain_meta() or {}
        if meta == 1:
            return {
                'count': len(data),
                'data': data,
                'meta': meta_info,
            }
        return _FResponse(
            content=json.dumps(data),
            media_type='application/json',
            headers={
                'X-Chain-Count': str(len(data)),
                'X-Chain-Compute-Ms': str(meta_info.get('computeMs', 0)),
            },
        )
    except Exception as e:
        import traceback
        log('chain_enriched_err', str(e)[:200])
        return _FResponse(
            content=json.dumps({'error': str(e)}),
            media_type='application/json',
            status_code=500,
        )


@app.get('/chain/enriched/status')
def chain_enriched_status():
    """Metadata only: last refresh time, count, compute ms."""
    meta_info = og_mod.get_chain_meta()
    if not meta_info:
        return {'ready': False}
    return {'ready': True, **meta_info}


@app.get('/chain/diagnose')
def chain_diagnose():
    """Diagnostic: raw MarketWatch field names."""
    return og_mod.diagnose_market_watch()


@app.post('/chain/invalidate')
def chain_invalidate():
    """Force cache invalidation."""
    og_mod.invalidate_caches()
    return {'ok': True}


# ---------- Options Migration ----------
class MigrateOptionsIn(BaseModel):
    underlyings: Optional[List[str]] = None
    dryRun: bool = False


# 🆕 ---------- Backfill Option Bid/Ask ----------
class BackfillBidAskIn(BaseModel):
    underlyings: Optional[List[str]] = None   # None = همه monitored
    fromDate: Optional[str] = None            # jalali '1405-03-19' یا gregorian
    toDate: Optional[str] = None
    contractLimit: int = 100                  # سقف تعداد قرارداد در هر اجرا
    includeToday: bool = True


def _safe_float(v, zero_as_none=True):
    """None-safe float برای فیلدهای ممکنه NaN/None."""
    try:
        if v is None or pd.isna(v):
            return None
        f = float(v)
        if zero_as_none and f == 0:
            return None
        return f
    except (TypeError, ValueError):
        return None


@app.post('/backfill-option-bidask')
def backfill_option_bidask(p: BackfillBidAskIn):
    """
    Two phases:
      1) Migrate historical bid/ask from option_snapshots -> option_history
      2) Fetch current live bid/ask from TSETMC MarketWatch (options)
    """
    from datetime import datetime, timezone
    from pipeline import options as opt_mod
    from pipeline.tsetmc_client import get_client
    from pymongo import UpdateOne

    db = get_db()
    result = {
        'snapshotsMigration': None,
        'liveSnapshotsFetched': 0,
        'contractsFound': 0,
        'recordsUpdated': 0,
        'errors': [],
    }

    # ---- Phase 1: snapshots -> history ----
    try:
        mig = opt_mod.migrate_snapshots_to_history(
            underlyings=p.underlyings,
            days=180,
            dry_run=False,
            log_fn=lambda m: log('backfill_bidask_mig', m),
        )
        result['snapshotsMigration'] = mig
        log('backfill_bidask_mig_done', 'written={}'.format(mig.get('written', 0)), mig)
    except Exception as e:
        result['errors'].append({'stage': 'migration', 'error': str(e)[:200]})

    # ---- Phase 2: live option quotes from TSETMC ----
    try:
        targets = p.underlyings
        if not targets:
            from pipeline.db import COL_MONITORED
            targets = [s['symbol'] for s in db[COL_MONITORED].find({})]

        col = db[COL_OPTION_HISTORY]
        client = get_client()

        for sym in targets:
            try:
                contracts = opt_mod.discover_contracts_for_underlying(sym)
                if not contracts:
                    continue

                mw = client.market_watch(paper_types=(5, 6), with_best_limits=True)
                mw_map = {r.get('insCode'): r for r in (mw or []) if r.get('insCode')}
                result['contractsFound'] += len(contracts)

                ua_doc = db['candles_daily'].find_one(
                    {'symbol': sym}, sort=[('time', -1)], projection={'close': 1}
                )
                ua_price = float(ua_doc['close']) if ua_doc and ua_doc.get('close') else None

                now = datetime.now(timezone.utc)
                ops = []
                for c in contracts:
                    m = mw_map.get(c['insCode'], {})
                    bid, ask = 0.0, 0.0
                    bl = m.get('bestLimits')
                    if isinstance(bl, list) and bl:
                        lvl0 = bl[0]
                        bid = float(lvl0.get('bd') or lvl0.get('bid') or 0)
                        ask = float(lvl0.get('od') or lvl0.get('ask') or 0)
                    if bid <= 0 or ask <= 0:
                        continue

                    days_left = None
                    if c.get('expiry_gregorian'):
                        try:
                            y, mo, d = map(int, c['expiry_gregorian'].split('-'))
                            exp = datetime(y, mo, d, tzinfo=timezone.utc)
                            days_left = max(0, (exp - now).days)
                        except Exception:
                            pass

                    doc = {
                        'symbol': c['ticker'],
                        'underlying': sym,
                        'time': now,
                        'bid': bid,
                        'ask': ask,
                        'last': float(m.get('pDrCotVal') or 0),
                        'close': float(m.get('pcl') or 0),
                        'volume': float(m.get('qTotTran5J') or 0),
                        'oi': float(m.get('op') or 0),
                        'strike': c['strike'],
                        'expiry': c.get('expiry_gregorian'),
                        'daysLeft': days_left,
                        'isCall': c['type'] == 'call',
                        'S': ua_price,
                        'source': 'tsetmc_snapshot',
                        'dataQuality': 'real',
                        'computedAt': now,
                    }
                    ops.append(UpdateOne(
                        {'symbol': doc['symbol'], 'time': now},
                        {'$set': doc},
                        upsert=True
                    ))

                if ops:
                    r = col.bulk_write(ops, ordered=False)
                    result['recordsUpdated'] += (r.upserted_count + r.modified_count)
            except Exception as e:
                result['errors'].append({'symbol': sym, 'error': str(e)[:200]})

        result['liveSnapshotsFetched'] = result['contractsFound']
    except Exception as e:
        result['errors'].append({'stage': 'live', 'error': str(e)[:200]})

    log('backfill_bidask_done',
        'mig={} live={}'.format(
            (result['snapshotsMigration'] or {}).get('written', 0),
            result['liveSnapshotsFetched'],
        ),
        {k: v for k, v in result.items() if k != 'errors'})

    return result


# 🆕 ---------- Enrichment endpoint ----------
class EnrichIn(BaseModel):
    symbol: Optional[str] = None
    build_model_first: bool = True

_enrich_lock = threading.Lock()

def _run_enrichment(symbol, build_model_first):
    """Run in background thread."""
    try:
        import sys
        sys.path.insert(0, os.path.dirname(__file__))
        from option_reconstruction.spread_model import load_spread_model, build_spread_model
        from option_reconstruction.enricher import enrich_collection

        db = get_db()
        if build_model_first and not load_spread_model(db):
            log('enrich_start', 'building spread model first')
            build_spread_model(db, log_fn=lambda m: log('enrich_model', m))

        log('enrich_start', f'symbol={symbol or "all"}')
        stats = enrich_collection(db, symbol=symbol, log_fn=lambda m: log('enrich', m))
        log('enrich_done', f'stats={stats}')
    except Exception as e:
        import traceback
        log('enrich_error', str(e)[:300])
        log('enrich_trace', traceback.format_exc()[:1000])


@app.post('/enrich-now')
def enrich_now(p: EnrichIn):
    """Manually trigger enrichment (async)."""
    if _enrich_lock.locked():
        return {'ok': False, 'error': 'enrichment already running'}

    def _wrapper():
        with _enrich_lock:
            _run_enrichment(p.symbol, p.build_model_first)

    t = threading.Thread(target=_wrapper, daemon=True)
    t.start()
    return {'ok': True, 'status': 'started', 'symbol': p.symbol or 'all'}


@app.get('/enrich-status')
def enrich_status():
    """Check enrichment status."""
    return {
        'running': _enrich_lock.locked(),
    }

@app.post('/migrate-options')
def migrate_options(p: MigrateOptionsIn):
    """Migrate option_daily_algotik → option_history with IV/Greeks."""
    if _backfill_lock.locked():
        raise HTTPException(409, 'backfill در حال اجراست — صبر کن')
    result = opt_mod.migrate_from_daily_algotik(
        underlyings=p.underlyings,
        dry_run=p.dryRun,
    )
    log('options_migration', f'migrated {result["written"]} docs', result)
    return result


# ---------- Audit ----------
@app.get('/audit')
def audit_all_endpoint(days: str = 'auto'):
    from pipeline import audit as audit_mod
    if days in ('auto', '', 'dynamic'):
        return audit_mod.audit_all(days=None)
    return audit_mod.audit_all(days=int(days))


@app.get('/audit/{symbol}')
def audit_one_endpoint(symbol: str, days: str = 'auto'):
    from pipeline import audit as audit_mod
    from datetime import timedelta

    to_d = datetime.now(timezone.utc)
    if days in ('auto', '', 'dynamic'):
        earliest = audit_mod._find_earliest_data_date()
        from_d = earliest or (to_d - timedelta(days=730))
    else:
        from_d = to_d - timedelta(days=int(days))

    return audit_mod.audit_symbol(symbol, from_d, to_d)


# ---------- Data Range ----------
@app.get('/data-range')
def data_range():
    """Global data range across all option data (option_history primary)."""
    from pipeline import audit as audit_mod
    earliest = audit_mod._find_earliest_data_date()
    if not earliest:
        return {'from': None, 'to': None, 'days': 0}

    db = get_db()
    # Latest from option_history first
    latest_doc = db[COL_OPTION_HISTORY].find_one(
        {}, sort=[('time', -1)], projection={'time': 1}
    )
    to_dt = None
    if latest_doc and latest_doc.get('time'):
        t = latest_doc['time']
        if isinstance(t, datetime):
            to_dt = t if t.tzinfo else t.replace(tzinfo=timezone.utc)

    # Fallback to legacy
    if not to_dt:
        latest2 = db['option_daily_algotik'].find_one(
            {}, sort=[('date', -1)], projection={'date': 1}
        )
        if latest2 and latest2.get('date'):
            try:
                to_dt = datetime.strptime(latest2['date'], '%Y-%m-%d').replace(tzinfo=timezone.utc)
            except Exception:
                pass

    if not to_dt:
        to_dt = datetime.now(timezone.utc)

    from_dt = earliest
    return {
        'from': from_dt.strftime('%Y-%m-%d'),
        'to': to_dt.strftime('%Y-%m-%d'),
        'days': (to_dt - from_dt).days,
    }


@app.get('/data-range/{symbol}')
def symbol_data_range(symbol: str):
    """Per-symbol option data range (option_history primary)."""
    from pipeline import audit as audit_mod
    start = audit_mod._find_symbol_option_start(symbol)
    if not start:
        return {'symbol': symbol, 'from': None, 'to': None, 'days': 0}

    db = get_db()
    latest_doc = db[COL_OPTION_HISTORY].find_one(
        {'underlying': symbol}, sort=[('time', -1)], projection={'time': 1}
    )
    to_dt = None
    if latest_doc and latest_doc.get('time'):
        t = latest_doc['time']
        if isinstance(t, datetime):
            to_dt = t if t.tzinfo else t.replace(tzinfo=timezone.utc)

    if not to_dt:
        latest2 = db['option_daily_algotik'].find_one(
            {'underlying': symbol}, sort=[('date', -1)], projection={'date': 1}
        )
        if latest2 and latest2.get('date'):
            try:
                to_dt = datetime.strptime(latest2['date'], '%Y-%m-%d').replace(tzinfo=timezone.utc)
            except Exception:
                pass

    if not to_dt:
        to_dt = datetime.now(timezone.utc)

    return {
        'symbol': symbol,
        'from': start.strftime('%Y-%m-%d'),
        'to': to_dt.strftime('%Y-%m-%d'),
        'days': (to_dt - start).days,
    }


# ---------- Risk-free ----------
@app.get('/risk-free')
def risk_free():
    return {'rate': get_current_rf()}


# ---------- Ticker ----------
class TickerIn(BaseModel):
    intervalSec: int = 10
    action: str = 'start'


@app.post('/ticker')
def control_ticker(p: TickerIn):
    if p.action == 'start':
        ok = live_mod.start_ticker(
            sym_mod.get_enabled_names, get_current_rf, p.intervalSec
        )
        return {'ok': ok, 'interval': p.intervalSec}
    else:
        live_mod.stop_ticker()
        return {'ok': True}


# ---------- Wipe ----------
@app.post('/admin/wipe')
def wipe(confirm: str):
    # 🆕 جلوگیری از wipe وسط backfill
    if _backfill_lock.locked():
        raise HTTPException(409, 'backfill در حال اجراست — صبر کن')

    if confirm != 'I_KNOW_WHAT_IM_DOING':
        raise HTTPException(400, 'confirm string invalid')

    db = get_db()
    from pipeline.db import (
        COL_CANDLES_BASE, COL_CANDLES_DAILY, COL_CANDLES_TF,
        COL_OPTION_HISTORY, COL_OPTION_SNAPSHOTS,
    )
    counts = {}
    for col in [
        COL_CANDLES_BASE, COL_CANDLES_DAILY, COL_CANDLES_TF,
        COL_OPTION_HISTORY, COL_OPTION_SNAPSHOTS,
        'backtest_trade_cache', 'backtest_jobs', 'backtest_result_cache',
        'signals_state', 'signal_history',
    ]:
        r = db[col].delete_many({})
        counts[col] = r.deleted_count
    log('admin_wipe', 'data wiped', counts)
    return {'ok': True, 'deleted': counts}


# ---------- Main ----------
if __name__ == '__main__':
    import uvicorn
    port = int(os.getenv('PORT', '5000'))
    host = os.getenv('HOST', '127.0.0.1')
    print(f'🚀 Collector starting on {host}:{port}')
    uvicorn.run(app, host=host, port=port)

