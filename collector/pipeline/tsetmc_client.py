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
    def market_watch(self, paper_types=(1, 2, 3, 5, 6)):
        """Live market snapshot.

        paper_types: (1,2,3) = stocks, (5,6) = options
        """
        parts = "&".join(
            "paperTypes[{}]={}".format(i, pt)
            for i, pt in enumerate(paper_types)
        )
        url = ("{}/ClosingPrice/GetMarketWatch?"
               "market=0&{}&withBestLimits=false&hEven=0&RefID=0").format(CDN, parts)
        d = self._json(url, timeout=30)
        return d.get("marketWatch", []) or []


# ─── Singleton ───
_client = None


def get_client():
    """Return a singleton TSETMCClient."""
    global _client
    if _client is None:
        _client = TSETMCClient()
    return _client


