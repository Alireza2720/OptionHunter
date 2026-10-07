# -*- coding: utf-8 -*-
"""Raw TSETMC HTTP client — replaces algotik-tse.

Confirmed endpoints (verified Oct 2025):
  - cdn.tsetmc.com/api/Instrument/GetInstrumentSearch/{q}
  - cdn.tsetmc.com/api/Instrument/GetInstrumentInfo/{ins}
  - cdn.tsetmc.com/api/ClosingPrice/GetClosingPriceHistory/{ins}/{YYYYMMDD}
  - cdn.tsetmc.com/api/ClosingPrice/GetClosingPriceDailyList/{ins}/0
  - cdn.tsetmc.com/api/ClosingPrice/GetMarketWatch
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
        """Raw GET returning (status_code, body_text).

        Handles gzip-compressed responses transparently.
        TSETMC's old.tsetmc.com endpoints return gzip by default.
        """
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
                # Detect and decompress gzip (magic bytes 1f 8b)
                if len(raw) >= 2 and raw[0] == 0x1F and raw[1] == 0x8B:
                    try:
                        raw = gzip.decompress(raw)
                    except Exception as ge:
                        raise TSETMCError("gzip decompress failed: {}".format(ge)) from ge
                # Detect zlib/deflate (78 9c / 78 01 / 78 da)
                elif len(raw) >= 2 and raw[0] == 0x78 and raw[1] in (0x01, 0x9C, 0xDA):
                    try:
                        import zlib
                        raw = zlib.decompress(raw)
                    except Exception:
                        pass  # not fatal, try as-is
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
        """Search instruments by ticker (exact or partial).

        NOTE: query is URL-encoded — TSETMC requires %-escaped path for
        non-ASCII (Persian) strings.
        """
        q = urllib.parse.quote(str(query or ""), safe="")
        d = self._json("{}/Instrument/GetInstrumentSearch/{}".format(CDN, q))
        return d.get("instrumentSearch", []) or []

    def instrument_info(self, ins_code):
        """Get metadata for an instrument by insCode."""
        d = self._json("{}/Instrument/GetInstrumentInfo/{}".format(CDN, ins_code))
        return d.get("instrumentInfo", {}) or {}

    # ─── Historical intraday (THE key endpoint) ───
    def ohlcv_intraday(self, ins_code, date_yyyymmdd):
        """Return raw snapshots for one day.

        Each snapshot has: {hEven, pDrCotVal, qTotTran5J, zTotTran, ...}

        Note: For OPTIONS, this is SPARSE (only a few snapshots/day).
        For STOCKS, it's dense (~1000+ snapshots/day).
        """
        url = "{}/ClosingPrice/GetClosingPriceHistory/{}/{}".format(
            CDN, ins_code, date_yyyymmdd
        )
        d = self._json(url)
        return d.get("closingPriceHistory", []) or []

    # ─── Historical daily ───
    def ohlcv_full(self, ins_code, top=999999):
        """Full OHLCV history (all trading days, includes non-traded with A=1).

        Returns list of dicts with keys:
            date, open, low, high, close, yesterday, value, volume, trades
        """
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
        """Alternative daily endpoint (JSON)."""
        url = "{}/ClosingPrice/GetClosingPriceDailyList/{}/0".format(CDN, ins_code)
        d = self._json(url)
        return d.get("closingPriceDaily", []) or []

    # ─── ClientType ───
    def client_type(self, ins_code):
        """Historical retail/institutional flow per day.

        Format: date,buy_I_Cnt,buy_N_Cnt,sell_I_Cnt,sell_N_Cnt,
                buy_I_Vol,sell_I_Vol,buy_N_Vol,sell_N_Vol,
                buy_I_Val,sell_I_Val,buy_N_Val,sell_N_Val
        """
        url = "{}/data/ClientType.aspx?i={}".format(OLD, ins_code)
        st, body = self._get(url, timeout=20)
        if st != 200 or not body.strip() or body.lstrip().startswith("<"):
            return []
        rows = []
        for line in body.split(";"):
            line = line.strip()
            if not line:
                continue
            p = line.split(",")
            if len(p) < 13:
                continue
            try:
                rows.append({
                    "date": p[0],
                    "buy_I_Count": int(float(p[1])),
                    "buy_N_Count": int(float(p[2])),
                    "sell_I_Count": int(float(p[3])),
                    "sell_N_Count": int(float(p[4])),
                    "buy_I_Volume": float(p[5]),
                    "sell_I_Volume": float(p[6]),
                    "buy_N_Volume": float(p[7]),
                    "sell_N_Volume": float(p[8]),
                    "buy_I_Value": float(p[9]),
                    "sell_I_Value": float(p[10]),
                    "buy_N_Value": float(p[11]),
                    "sell_N_Value": float(p[12]),
                })
            except (ValueError, IndexError):
                continue
        return rows

    # ─── Live market ───
    def market_watch(self, paper_types=(1, 2, 3, 5, 6), with_best_limits=False):
        """Live market snapshot.

        paper_types: (1,2,3) = stocks, (5,6) = options
        with_best_limits: include 5-level best bid/ask (adds bestLimits array)

        Primary source: cdn.tsetmc.com (JSON).
        Fallback: old.tsetmc.com/tsev2/data/MarketWatchInit.aspx
                  (gzipped, pipe-delimited — used when cdn returns 403).
        """
        parts = "&".join(
            "paperTypes[{}]={}".format(i, pt)
            for i, pt in enumerate(paper_types)
        )
        bl = "true" if with_best_limits else "false"
        url = ("{}/ClosingPrice/GetMarketWatch?"
               "market=0&{}&withBestLimits={}&hEven=0&RefID=0").format(CDN, parts, bl)

        # Try modern API first
        try:
            d = self._json(url, timeout=15)
            mw = d.get("marketWatch", []) or []
            if mw:
                return mw
        except TSETMCError:
            pass

        # Fallback to legacy endpoint (some IPs get 403 on the modern one)
        return self._legacy_market_watch(paper_types, with_best_limits)

    def _legacy_market_watch(self, paper_types, with_best_limits=False):
        """Fallback parser for old.tsetmc.com/tsev2/data/MarketWatchInit.aspx.

        Response is gzipped; format has 5 sections split by '@':
          [0] index info (21 bytes)
          [1] market overview (215 bytes)
          [2] contracts list (the main payload — this is what we need)
          [3] order-book limits
          [4] trailing counter

        Each contract row in section[2] is ';'-delimited; fields are
        comma-separated. See field mapping below (verified 2026-10).
        """
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

        # ✅ section[2] is the contracts list (NOT section[3])
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
                # Ticker must be Persian (starts with Arabic block)
                if len(ticker) < 1:
                    continue
                cp = ord(ticker[0])
                if cp < 0x0600 or cp > 0x06FF:
                    continue

                is_option = ticker[0] in ('ض', 'ط')
                if is_option and not want_options:
                    continue
                if not is_option and not want_stocks:
                    continue

                # Verified field mapping for section[2] (2026-10):
                #   [0] insCode      [1] ISIN         [2] ticker
                #   [3] lVal30       [4] hEven        [5] pClosing
                #   [6] pDrCotVal    [7] pmax         [8] zTotTran
                #   [9] qTotTran5J   [10] qTotTran    [11] pd1 (bid)
                #   [12] po1 (ask)   [13] py (yday)   [14..] extras
                last_price = _f(fields, 6)
                close_px = _f(fields, 5)
                yday = _f(fields, 13)
                bid = _f(fields, 11)
                ask = _f(fields, 12)

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
                    'pmax': _f(fields, 7),
                    'zTotTran': _f(fields, 8),
                    'qTotTran5J': _f(fields, 9),
                    'qTotTran': _f(fields, 10),
                    'pd1': bid,
                    'po1': ask,
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


