#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""AlgoTik Collector — Unified Data Pipeline"""
import os, sys, threading, signal, time, re
from datetime import datetime, timezone
from typing import Optional, List, Dict, Any

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

# ---------- Global locks & shutdown ----------
_backfill_lock = threading.Lock()
_shutdown_event = threading.Event()


# ---------- Date sanitization ----------
_BIDI_RE = re.compile(r'[\u200e\u200f\u202a-\u202e\u2066-\u2069\u061c]')

def _clean_date(s: str) -> str:
    """
    پاک‌سازی ورودی تاریخ:
    - حذف کاراکترهای نامرئی Bidi (RLM, LRM, ...)
    - یکسان‌سازی جداکننده‌ها (dash → slash)
    - حذف اسلش‌های تکراری
    """
    if s is None:
        return s
    s = _BIDI_RE.sub('', str(s))
    s = s.strip()
    s = s.replace('-', '/')
    s = re.sub(r'/+', '/', s)
    return s


# ---------- Risk-free ----------
_rf_cache = {'rate': 0.42, 'date': None}

def get_current_rf(force=False):
    today = datetime.now(timezone.utc).date()
    today_str = today.isoformat()
    if not force and _rf_cache['date'] == today:
        return _rf_cache['rate']

    db = get_db()
    if not force:
        doc = db[COL_RISK_FREE].find_one({'date': today_str})
        if doc:
            _rf_cache['rate'] = float(doc['rate'])
            _rf_cache['date'] = today
            return _rf_cache['rate']

    try:
        import algotik_tse as att
        t = att.get_treasury_yields(include_stale=True, min_volume=0)
        if t is not None and len(t) > 0:
            rate = float(t['EffectiveAnnualYield'].median())
            _rf_cache['rate'] = rate
            _rf_cache['date'] = today
            db[COL_RISK_FREE].update_one(
                {'date': today_str},
                {'$set': {
                    'date': today_str, 'rate': rate,
                    'count': len(t), 'source': 'algotik_treasury',
                    'updatedAt': datetime.now(timezone.utc),
                }},
                upsert=True,
            )
            log('rf_update', f'risk-free updated: {rate:.4f}')
            return rate
    except Exception as e:
        log('rf_error', str(e))
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
    return {
        'symbols_total': db[COL_MONITORED].count_documents({}),
        'symbols_enabled': db[COL_MONITORED].count_documents({'enabled': True}),
        'candles_base': db[COL_CANDLES_BASE].count_documents({}),
        'candles_daily': db[COL_CANDLES_DAILY].count_documents({}),
        'option_history': db[COL_OPTION_HISTORY].count_documents({}),
        'option_snapshots': db[COL_OPTION_SNAPSHOTS].count_documents({}),
        'risk_free': get_current_rf(),
        'ticker': live_mod.get_stats(),
        'backfill_running': _backfill_lock.locked(),
    }


# ---------- Live Market (برای tick.job.js) ----------
@app.get('/live-market')
def live_market():
    """Snapshot live کل بازار (سهام پایه)."""
    try:
        import algotik_tse as att
        import json
        df = att.get_live_market()
        if df is None or len(df) == 0:
            return {'count': 0, 'data': []}
        records = json.loads(df.to_json(orient='records', date_format='iso'))
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
    """Snapshot live یک نماد."""
    try:
        import algotik_tse as att
        import json
        df = att.get_live_market(symbol=symbol)
        if df is None or len(df) == 0:
            return {'count': 0, 'data': []}
        records = json.loads(df.to_json(orient='records', date_format='iso'))
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
        # 🆕 پاک‌سازی ورودی تاریخ (bidi + جداکننده)
        date_from = _clean_date(payload.get('dateFrom'))
        date_to   = _clean_date(payload.get('dateTo'))
        print(f'📅 backfill date range: {date_from} → {date_to}')   # لاگ برای دیباگ

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
            rf = get_current_rf()
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
                    df, err = opt_mod.fetch_market(sym)
                    if err or df is None or len(df) == 0:
                        stats['option_history']['errors'] += 1
                        job_mod.append_warning(job_id, f'{sym}: option market empty')
                    else:
                        import json
                        raw = json.loads(df.to_json(orient='records', date_format='iso'))
                        docs = opt_mod.analyze_records(raw, rf)
                        if docs:
                            written = opt_mod.write_history(docs)
                            stats['option_history']['contracts'] += written
                            stats['option_history']['with_iv'] += sum(1 for d in docs if d.get('ivApi'))
                except Exception as e:
                    stats['option_history']['errors'] += 1
                    job_mod.append_error(job_id, f'{sym} options: {e}')

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
        if payload.get('includeOptionMigration'):
            if job_mod.is_cancelled(job_id) or _shutdown_event.is_set():
                job_mod.finish_job(job_id, 'CANCELLED')
                return

            job_mod.set_phase(job_id, 'option_migration', {
                'current': 0, 'total': len(symbols),
                'status': 'RUNNING', 'stats': stats['option_migration'],
            })

            try:
                result = opt_mod.migrate_from_daily_algotik(
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


# ---------- Options Migration ----------
class MigrateOptionsIn(BaseModel):
    underlyings: Optional[List[str]] = None
    dryRun: bool = False

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
    """Global data range across all option data."""
    from pipeline import audit as audit_mod
    earliest = audit_mod._find_earliest_data_date()
    if not earliest:
        return {'from': None, 'to': None, 'days': 0}

    db = get_db()
    latest = db['option_daily_algotik'].find_one(
        {}, sort=[('date', -1)], projection={'date': 1}
    )
    from_dt = earliest
    to_dt = None
    if latest and latest.get('date'):
        try:
            to_dt = datetime.strptime(latest['date'], '%Y-%m-%d').replace(tzinfo=timezone.utc)
        except Exception:
            pass
    if not to_dt:
        to_dt = datetime.now(timezone.utc)

    return {
        'from': from_dt.strftime('%Y-%m-%d'),
        'to': to_dt.strftime('%Y-%m-%d'),
        'days': (to_dt - from_dt).days,
    }


@app.get('/data-range/{symbol}')
def symbol_data_range(symbol: str):
    """Per-symbol option data range."""
    from pipeline import audit as audit_mod
    start = audit_mod._find_symbol_option_start(symbol)
    if not start:
        return {'symbol': symbol, 'from': None, 'to': None, 'days': 0}

    db = get_db()
    latest = db['option_daily_algotik'].find_one(
        {'underlying': symbol}, sort=[('date', -1)], projection={'date': 1}
    )
    to_dt = datetime.now(timezone.utc)
    if latest and latest.get('date'):
        try:
            to_dt = datetime.strptime(latest['date'], '%Y-%m-%d').replace(tzinfo=timezone.utc)
        except Exception:
            pass

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