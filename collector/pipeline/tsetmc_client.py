# -*- coding: utf-8 -*-
"""Raw TSETMC HTTP client — replaces algotik-tse.

Confirmed endpoints (verified Oct 2025):
  - cdn.tsetmc.com/api/Instrument/GetInstrumentSearch/{q}
  - cdn.tsetmc.com/api/Instrument/GetInstrumentInfo/{ins}
  - cdn.tsetmc.com/api/ClosingPrice/GetClosingPriceHistory/{ins}/{YYYYMMDD}
  - cdn.tsetmc.com/api/ClosingPrice/GetClosingPriceDailyList/{ins}/0
  - cdn.tsetmc.com/api/ClosingPrice/GetMarketWatch
  - cdn.tsetmc.com/api/BestLimits/{ins}
  - cdn.tsetmc.com/api/ClientType/GetClientType/{ins}/1/0
  - old.tsetmc.com/tsev2/data/InstTradeHistory.aspx?i={ins}&A=1
  - old.tsetmc.com/tsev2/data/ClientType.aspx?i={ins}
"""
import time
import json
import ssl
import gzip
import urllib.request
import urllib.error
import urllib.parse


UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")

CDN = "https://cdn.tsetmc.com/api"
OLD = "https://old.tsetmc.com/tsev2"


class TSETMCError(Exception):
    """Raised when TSETMC request fails."""
    pass


class TSETMCClient:
    """Minimal HTTP client for TSETMC public endpoints.

    Rate-limited to 300ms between requests (safe for TSETMC).
    Uses urllib (no external deps).
    """

    MIN_INTERVAL = 0.30
    TIMEOUT = 25

    def __init__(self):
        self._last_request = 0.0
        self._ctx = ssl.create_default_context()
        self._ctx.check_hostname = False
        self._ctx.verify_mode = ssl.CERT_NONE

    def _wait(self):
        dt = time.time() - self._last_request
        if dt < self.MIN_INTERVAL:
            time.sleep(self.MIN_INTERVAL - dt)
        self._last_request = time.time()

    def _get(self, url, timeout=None):
        """Raw GET returning (status_code, body_text)."""
        self._wait()
        req = urllib.request.Request(url, headers={
            "User-Agent": UA,
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "fa-IR,fa;q=0.9",
            "Accept-Encoding": "gzip, deflate",
        })
        try:
            with urllib.request.urlopen(
                req, timeout=timeout or self.TIMEOUT, context=self._ctx
            ) as r:
                raw = r.read()
                if len(raw) >= 2 and raw[0] == 0x1F and raw[1] == 0x8B:
                    try:
                        raw = gzip.decompress(raw)
                    except Exception as ge:
                        raise TSETMCError("gzip decompress failed: {}".format(ge)) from ge
                elif len(raw) >= 2 and raw[0] == 0x78 and raw[1] in (0x01, 0x9C, 0xDA):
                    try:
                        import zlib
                        raw = zlib.decompress(raw)
                    except Exception:
                        pass
                body = raw.decode("utf-8", errors="ignore")
                return r.status, body
        except urllib.error.HTTPError as e:
            return e.code, ""
        except Exception as e:
            raise TSETMCError(str(e)) from e

    def _json(self, url, timeout=None):
        st, body = self._get(url, timeout)
        if st != 200 or not body.strip():
            raise TSETMCError("HTTP {} or empty: {}".format(st, url))
        try:
            return json.loads(body)
        except json.JSONDecodeError as e:
            raise TSETMCError("Invalid JSON: {}".format(e)) from e

    # ─── Search / metadata ───
    def search(self, query):
        q = urllib.parse.quote(str(query or ""), safe="")
        d = self._json("{}/Instrument/GetInstrumentSearch/{}".format(CDN, q))
        return d.get("instrumentSearch", []) or []

    def instrument_info(self, ins_code):
        d = self._json("{}/Instrument/GetInstrumentInfo/{}".format(CDN, ins_code))
        return d.get("instrumentInfo", {}) or {}

    # ─── Historical intraday ───
    def ohlcv_intraday(self, ins_code, date_yyyymmdd):
        url = "{}/ClosingPrice/GetClosingPriceHistory/{}/{}".format(
            CDN, ins_code, date_yyyymmdd
        )
        d = self._json(url)
        return d.get("closingPriceHistory", []) or []

    # ─── Historical daily (legacy) ───
    def ohlcv_full(self, ins_code, top=999999):
        url = "{}/data/InstTradeHistory.aspx?i={}&Top={}&A=1".format(
            OLD, ins_code, top
        )
        st, body = self._get(url, timeout=30)
        if st != 200 or not body.strip() or body.lstrip().startswith("<"):
            return []
        rows = []
        for line in body.split(";"):
            line = line.strip()
            if not line:
                continue
            parts = line.split("@")
            if len(parts) < 10:
                continue
            try:
                rows.append({
                    "date": parts[0],
                    "open": float(parts[1]),
                    "low": float(parts[2]),
                    "high": float(parts[3]),
                    "close": float(parts[4]),
                    "yesterday": float(parts[5]),
                    "value": float(parts[7]),
                    "volume": float(parts[8]),
                    "trades": float(parts[9]),
                })
            except (ValueError, IndexError):
                continue
        return rows

    def ohlcv_daily_json(self, ins_code):
        url = "{}/ClosingPrice/GetClosingPriceDailyList/{}/0".format(CDN, ins_code)
        d = self._json(url)
        return d.get("closingPriceDaily", []) or []

    # ─── ClientType (NEW) ───
    def client_type(self, ins_code):
        """Historical retail/institutional flow per day.

        CDN JSON format returns a single dict (not a list) for current day.
        """
        url = "{}/ClientType/GetClientType/{}/1/0".format(CDN, ins_code)
        d = self._json(url)
        ct = d.get("clientType")
        if not ct:
            return []
        rows_raw = ct if isinstance(ct, list) else [ct]
        out = []
        for r in rows_raw:
            d_even = r.get("dEven") or r.get("date")
            iso = None
            if d_even:
                s = str(int(d_even)) if str(d_even).isdigit() else str(d_even)
                if len(s) == 8:
                    iso = "{}-{}-{}".format(s[:4], s[4:6], s[6:8])
                else:
                    iso = s
            out.append({
                "date": iso,
                "dEven": int(d_even) if d_even and str(d_even).isdigit() else None,
                "buy_I_Volume": float(r.get("buy_I_Volume") or 0),
                "buy_N_Volume": float(r.get("buy_N_Volume") or 0),
                "buy_DDD_Volume": float(r.get("buy_DDD_Volume") or 0),
                "buy_CountI": float(r.get("buy_CountI") or 0),
                "buy_CountN": float(r.get("buy_CountN") or 0),
                "buy_CountDDD": float(r.get("buy_CountDDD") or 0),
                "sell_I_Volume": float(r.get("sell_I_Volume") or 0),
                "sell_N_Volume": float(r.get("sell_N_Volume") or 0),
                "sell_CountI": float(r.get("sell_CountI") or 0),
                "sell_CountN": float(r.get("sell_CountN") or 0),
            })
        return out

    # ─── BestLimits (NEW) — 5-level order book ───
    def best_limits(self, ins_code):
        """Get 5-level order book with real volumes."""
        url = "{}/BestLimits/{}".format(CDN, ins_code)
        d = self._json(url)
        limits = d.get("bestLimits", []) or []
        out = []
        for i, lvl in enumerate(limits, 1):
            out.append({
                "level": i,
                "bid": float(lvl.get("pMeDem") or 0),
                "bid_vol": float(lvl.get("qTitMeDem") or 0),
                "bid_orders": float(lvl.get("zOrdMeDem") or 0),
                "ask": float(lvl.get("pMeOf") or 0),
                "ask_vol": float(lvl.get("qTitMeOf") or 0),
                "ask_orders": float(lvl.get("zOrdMeOf") or 0),
            })
        return out

    # ─── ClosingPrice history (NEW) ───
    def closing_price_history(self, ins_code):
        """Daily close history for one instrument (up to 53 days)."""
        url = "{}/ClosingPrice/GetClosingPriceDailyList/{}/0".format(CDN, ins_code)
        d = self._json(url)
        return d.get("closingPriceDaily", []) or []

    # ─── Live market ───
    def market_watch(self, paper_types=(1, 2, 3, 5, 6), with_best_limits=False):
        parts = "&".join(
            "paperTypes[{}]={}".format(i, pt)
            for i, pt in enumerate(paper_types)
        )
        bl = "true" if with_best_limits else "false"
        url = ("{}/ClosingPrice/GetMarketWatch?"
               "market=0&{}&withBestLimits={}&hEven=0&RefID=0").format(CDN, parts, bl)
        try:
            d = self._json(url, timeout=15)
            mw = d.get("marketWatch", []) or []
            if mw:
                return mw
        except TSETMCError:
            pass
        return self._legacy_market_watch(paper_types, with_best_limits)

    def _legacy_market_watch(self, paper_types, with_best_limits=False):
        url = "{}/data/MarketWatchInit.aspx?h=0&r=0".format(OLD)
        try:
            st, body = self._get(url, timeout=30)
        except TSETMCError:
            return []
        if st != 200 or not body.strip():
            return []
        sections = body.split('@')
        if len(sections) < 3:
            return []
        contracts_section = sections[2]
        want_stocks = any(pt in paper_types for pt in (1, 2, 3))
        want_options = any(pt in paper_types for pt in (5, 6))

        def _f(fields, idx, default=0.0):
            try:
                v = fields[idx].strip()
                return float(v) if v else default
            except (ValueError, IndexError):
                return default

        out = []
        for row_str in contracts_section.split(';'):
            row_str = row_str.strip()
            if not row_str:
                continue
            fields = row_str.split(',')
            if len(fields) < 14:
                continue
            try:
                ins_code = fields[0].strip()
                ticker = fields[2].strip() if len(fields) > 2 else ''
                if not ins_code or not ticker:
                    continue
                cp = ord(ticker[0])
                if cp < 0x0600 or cp > 0x06FF:
                    continue
                is_option = ticker[0] in ('ض', 'ط')
                if is_option and not want_options:
                    continue
                if not is_option and not want_stocks:
                    continue
                last_price = _f(fields, 6)
                close_px = _f(fields, 5)
                yday = _f(fields, 7)
                bid = _f(fields, 11)
                ask = _f(fields, 12)
                pmin = _f(fields, 13)
                pmax = _f(fields, 22)
                days_left_actual = _f(fields, 25)
                row = {
                    'insCode': ins_code,
                    'lva': ticker,
                    'lVal18AFC': ticker,
                    'lVal30': fields[3].strip() if len(fields) > 3 else '',
                    'pDrCotVal': last_price,
                    'last': last_price,
                    'pcl': close_px,
                    'pClosing': close_px,
                    'py': yday,
                    'yesterday': yday,
                    'pmin': pmin,
                    'pmax': pmax,
                    'zTotTran': _f(fields, 8),
                    'qTotTran5J': _f(fields, 9),
                    'qTotTran': _f(fields, 10),
                    'pd1': bid,
                    'po1': ask,
                    'days_left_actual': days_left_actual,
                    'size': _f(fields, 21) or 1000,
                    'op': 0,
                }
                if with_best_limits:
                    row['bestLimits'] = [{
                        'bd': bid, 'od': ask, 'bq': 0, 'oq': 0,
                    }]
                out.append(row)
            except Exception:
                continue
        return out


# ─── Singleton ───
_client = None


def get_client():
    """Return a singleton TSETMCClient."""
    global _client
    if _client is None:
        _client = TSETMCClient()
    return _client