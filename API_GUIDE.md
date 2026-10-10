# API Guide — OptionHunter + Collector

راهنمای کامل API برای اتصال OptionStrategist.

**آخرین بروزرسانی:** 1405/07/18  
**Server:** `https://api.optionhunter.ir`  
**Local:** `http://127.0.0.1:3000` (backend) / `http://127.0.0.1:5000` (collector)

---

## فهرست

1. [معماری کلی](#معماری-کلی)
2. [Authentication](#authentication)
3. [Collector API (پورت 5000)](#collector-api-پورت-5000)
4. [Backend API (پورت 3000)](#backend-api-پورت-3000)
5. [فرمت داده](#فرمت-داده)
6. [جریان‌های معمول](#جریان‌های-معمول)
7. [مثال‌ها](#مثال‌ها)
8. [Error Codes](#error-codes)
9. [نکات مهم](#نکات-مهم)

---

## معماری کلی

```
                 ┌───────────────────┐
                 │   TSETMC (خارجی)  │
                 └─────────┬─────────┘
                           │
                           ▼
┌──────────────────┐   ┌───────────────┐
│ OptionStrategist │   │   Collector   │  :5000
│     :3001        │◄──┤   (FastAPI)   │
└────────┬─────────┘   └───────┬───────┘
         │                     │
         │                     ▼
         │             ┌───────────────┐
         └────────────►│    MongoDB    │  :27017
                       └───────┬───────┘
                               ▲
                               │
                       ┌───────┴───────┐
                       │  OptionHunter │  :3000
                       │   (Node.js)   │
                       └───────────────┘
```

**OptionStrategist می‌تواند:**
- مستقیم به **Collector** وصل شود (زنجیره آپشن، داده خام)
- یا به **Backend** وصل شود (proxy، signalها، configها)
- یا مستقیم به **MongoDB** (فقط خواندن از کلکسیون‌های مشترک)

---

## Authentication

اکثر endpointها عمومی هستند. بعضی از نوشتن‌ها نیاز به هدر دارند:

```
x-admin-token: <ADMIN_TOKEN>
```

مقدار `ADMIN_TOKEN` در `~/apps/OptionHunter/.env` است.

**Endpointهای محافظت‌شده در Backend:**
- تمام `POST`/`PUT`/`DELETE` (به‌جز ping، health، read-only)

**Endpointهای Collector:** همه باز هستند (روی `127.0.0.1` bind شده، از بیرون دسترسی نیست).

---

## Collector API (پورت 5000)

### Health & Status

#### GET /health

```json
{
  "status": "ok",
  "mongo": "connected",
  "time": "2026-10-10T17:33:25.746080+00:00",
  "ticker": true,
  "backfill_running": false,
  "shutdown": false
}
```

#### GET /status

```json
{
  "symbols_total": 23,
  "symbols_enabled": 23,
  "candles_base": 5759000,
  "candles_daily": 87642,
  "option_history": 371467,
  "option_snapshots": 820454,
  "risk_free": 0.42,
  "ticker": { "running": true, "ticks": 1145, "errors": 0 },
  "backfill_running": false
}
```

### Coverage

#### GET /coverage

پوشش دیتا هر نماد (Mongo cached، زیر ۱ ثانیه).

```json
{
  "symbols": [
    {
      "symbol": "اهرم",
      "stock_base": {
        "count": 240419,
        "from": "2021-12-20T03:07:00",
        "to": "2026-10-10T02:41:00"
      },
      "stock_ticks": { "count": 5855 },
      "stock_daily": { "count": 2169 },
      "candles_tf": { "15m": 19472, "30m": 10558, "1h": 6210 },
      "options": {
        "count": 32908,
        "with_iv": 4814,
        "from": "2026-07-22T09:00:00",
        "to": "2026-10-10T09:00:00"
      }
    }
  ]
}
```

### Option Chain (زنجیره آپشن)

#### GET /chain/enriched

زنجیره کامل آپشن، فرمت سازگار با optionschool24.

**Query params:**
- `fresh=1` — bypass cache
- `meta=1` — wrap در object با metadata
- `model=bsm|heston` — pricing model (default: bsm)

**Response (array):**

```json
[
  {
    "name": "ضهرم7050",
    "fname": "اختيارخ اهرم-7050-1405/08/15",
    "co": "77302768362401109",
    "basis_name": "اهرم",
    "type": 1,
    "basis": 79500,
    "emal": 7050,
    "to_date": "2026-11-05",
    "day_left": 26,
    "days_left_actual": 26,
    "close": 1234,
    "b_price": "1230/5000",
    "s_price": "1240/8000",
    "b_volume": 5000,
    "s_volume": 8000,
    "black_sholes": 1236.5,
    "imp": 0.62,
    "sigma": 0.45,
    "delta": 0.52,
    "gamma": 0.00012,
    "theta": -25.4,
    "vega": 152.3,
    "Tvolume": 150000,
    "Tcount": 340,
    "op": 25000,
    "isCall": true,
    "size": 1000,
    "value": 2400,
    "status_text": "سود",
    "source": "tsetmc_enriched",
    "pricingModel": "bsm"
  }
]
```

**نکات مهم در مورد فیلدها:**

| فیلد | توضیح |
|---|---|
| `name` | نماد قرارداد (کلید یکتا) |
| `basis_name` | نام نماد پایه (نرمال‌شده) |
| `basis` | قیمت لحظه‌ای سهم پایه |
| `emal` | Strike (اعمال) |
| `to_date` | تاریخ سررسید (میلادی YYYY-MM-DD) |
| `day_left` | روز تا سررسید (تقویمی) |
| `days_left_actual` | روز کاری تا سررسید |
| `close` | آخرین قیمت معامله |
| `b_price` / `s_price` | بهترین bid/ask به شکل `قیمت/حجم` |
| `b_volume` / `s_volume` | حجم bid/ask |
| `black_sholes` | قیمت نظری BSM |
| `imp` | IV (کسری، مثلاً 0.62 = 62%) |
| `sigma` | HV 30 روزه |
| `delta` / `gamma` / `theta` / `vega` | Greeks |
| `op` | Open Interest |
| `Tvolume` | حجم معاملات امروز |
| `Tcount` | تعداد معاملات امروز |
| `isCall` | true = Call، false = Put |
| `size` | ضریب قرارداد (معمولاً 1000) |
| `dataQuality` | `real` / `enriched` / `missing_price` |

#### GET /chain/enriched?meta=1

```json
{
  "count": 342,
  "data": [ /* همان آرایه بالا */ ],
  "meta": {
    "count": 342,
    "computeMs": 1234,
    "at": "2026-10-10T17:33:00Z",
    "source": "tsetmc_enriched",
    "pricingModel": "bsm"
  }
}
```

#### GET /chain/enriched/status

```json
{
  "ready": true,
  "count": 342,
  "computeMs": 1234,
  "at": "2026-10-10T17:33:00Z"
}
```

### Live Market

#### GET /live-market

Snapshot زنده بازار سهام.

```json
{
  "count": 342,
  "at": "2026-10-10T17:33:00Z",
  "data": [
    {
      "Symbol": "اهرم",
      "Last": 79500,
      "Close": 79200,
      "pl": 79500,
      "Open": 79000,
      "MaxAllowed": 82500,
      "MinAllowed": 76200,
      "Volume": 1520000,
      "TradeCount": 3400
    }
  ]
}
```

#### GET /live-market/:symbol

فقط یک نماد.

### Data Range & Explain

#### GET /data-range

```json
{
  "from": "2017-05-22",
  "to": "2026-10-10",
  "days": 3428
}
```

#### GET /data-range/:symbol

بازه یک نماد خاص.

#### GET /explain/:symbol

تفصیل داده آپشن یک نماد — برای debug.

```json
{
  "symbol": "اهرم",
  "sources": {
    "option_history": {
      "count": 32908,
      "with_bid_ask": 32748,
      "with_iv": 4814,
      "from": "2026-07-22T09:00:00",
      "to": "2026-10-10T09:00:00",
      "sources": ["live_snapshot", "algotik_snapshot", "tsetmc_live", "tsetmc_historical"],
      "qualities": ["enriched", "real"]
    },
    "option_daily_algotik": { "count": 1663 },
    "option_history_synth": { "count": 15134 }
  },
  "contracts_count": 84,
  "sample_contracts": ["ضهرم7050", "ضهرم7051", "ضهرم7052"]
}
```

### Risk-Free

#### GET /risk-free

```json
{ "rate": 0.42 }
```

### Jobs

#### GET /jobs?limit=30

لیست jobها با payload و progress.

```json
[
  {
    "_id": "064ae3f7-cf0d-4b50-a267-54a58d983d73",
    "type": "full-backfill",
    "payload": {
      "symbols": ["اهرم"],
      "dateFrom": "1400-01-01",
      "dateTo": "1405-07-18",
      "includeStockIntraday": true,
      "includeStockDaily": true,
      "includeOptionHistory": true,
      "includeOptionSnapshot": true,
      "includeOptionMigration": true,
      "includeAggregate": true
    },
    "status": "RUNNING",
    "phase": "stock_intraday",
    "phases": {
      "stock_intraday": {
        "current": 3,
        "total": 23,
        "current_symbol": "دارونو",
        "status": "RUNNING",
        "stats": { "symbols_done": 3, "candles": 1330, "errors": 0 }
      },
      "stock_daily": { "current": 0, "total": 23, "status": "PENDING" },
      "option_history": { "current": 0, "total": 23, "status": "PENDING" },
      "option_snapshot": { "current": 0, "total": 23, "status": "PENDING" },
      "option_migration": { "current": 0, "total": 23, "status": "PENDING" },
      "aggregate": { "current": 0, "total": 23, "status": "PENDING" }
    },
    "errors": [],
    "created_at": "2026-10-10T18:18:25.579000",
    "started_at": "2026-10-10T18:18:25.587000"
  }
]
```

#### GET /jobs/:id

یک job.

#### GET /jobs/:id/raw

job با payload کامل (برای debug).

#### POST /jobs/full-backfill

```json
{
  "symbols": ["اهرم", "خودرو"],
  "dateFrom": "1405-01-01",
  "dateTo": "1405-07-18",
  "includeStockIntraday": true,
  "includeStockDaily": true,
  "includeOptionHistory": true,
  "includeOptionSnapshot": false,
  "includeOptionMigration": false,
  "includeAggregate": true
}
```

#### POST /jobs/:id/cancel

لغو یک job.

#### POST /jobs/:id/pause

توقف موقت (فقط برای collector jobs).

#### POST /jobs/:id/resume

ادامه از همان‌جا.

#### POST /enrich-now

شروع غنی‌سازی bid/ask.

```json
{
  "symbol": null,
  "build_model_first": true
}
```

---

## Backend API (پورت 3000)

### Ping & Root

#### GET /ping

```json
{ "pong": true, "time": "2026-10-10T17:33:00.000Z" }
```

#### GET /

```json
{
  "status": "ok",
  "version": "v10.0-clean",
  "startedAt": "2026-10-10T15:00:00Z",
  "adminRequired": true,
  "telegramConfigured": true,
  "collectorOnline": true,
  "marketOpenNow": false,
  "holidayToday": false,
  "health": { "consecutiveFailures": 0, "lastTickAt": "..." },
  "pendingOutbox": 0
}
```

### Options Chain Proxy

#### GET /api/options-chain

Proxy به collector. Query params: `fresh=1`, `meta=1`, `model=bsm|heston`.

#### GET /api/options-chain?meta=1

با metadata.

#### GET /api/options-chain/status

#### GET /api/options/chain/:underlying

زنجیره یک نماد با محاسبه spread/IV/greeks.

```json
{
  "underlying": "اهرم",
  "matchedNames": ["اهرم"],
  "S": 79500,
  "hv": 0.45,
  "chainAgeSec": 45,
  "rows": [
    {
      "symbol": "ضهرم7050",
      "strike": 7050,
      "expiry": "2026-11-05",
      "daysLeft": 26,
      "bid": 1230,
      "ask": 1240,
      "last": 1234,
      "spreadPct": 0.81,
      "iv": 0.62,
      "delta": 0.52,
      "oi": 25000,
      "reject": []
    }
  ]
}
```

### Options Settings & Positions

- `GET /api/options/settings`
- `PUT /api/options/settings`
- `GET /api/options/positions`
- `DELETE /api/options/positions/:id`
- `GET /api/options/recommend/:configId`

### Monitored Symbols

#### GET /api/monitored-symbols

```json
[
  {
    "_id": "...",
    "symbol": "اهرم",
    "name": "اهرم",
    "enabled": true,
    "collectEnabled": true,
    "addedAt": "2026-01-01T00:00:00Z"
  }
]
```

- `POST /api/monitored-symbols` — افزودن
- `PUT /api/monitored-symbols/:id`
- `DELETE /api/monitored-symbols/:id`
- `POST /api/monitored-symbols/sync-from-configs`
- `POST /api/monitored-symbols/bulk-collect`

### Strategies & Configs

- `GET /strategies.js` — کتابخانه کامل
- `GET /api/strategies` — لیست با پارامترهای پیش‌فرض
- `GET /api/strategy-configs`
- `POST /api/strategy-configs`
- `PUT /api/strategy-configs/:id`
- `DELETE /api/strategy-configs/:id`
- `POST /api/strategy-configs/bulk-update`
- `POST /api/strategy-configs/bulk-delete`

#### GET /api/status

State تمام configها (signals_state).

```json
[
  {
    "configId": "...",
    "symbol": "اهرم",
    "strategyId": "smc_unicorn",
    "position": "LONG",
    "price": 79500,
    "indicators": { "atr": 1500, "stop": 76500 },
    "htfTrend": "صعودی",
    "updatedAt": "..."
  }
]
```

### Signals

#### GET /api/signal-history?limit=100

```json
[
  {
    "configId": "...",
    "symbol": "اهرم",
    "strategyId": "smc_unicorn",
    "strategyName": "SMC Unicorn",
    "timeframe": "1h",
    "signalType": "BUY",
    "price": 79500,
    "time": 1728560400,
    "reason": "SMC [FVG] | 1/3",
    "htfTrend": "صعودی",
    "inWindow": true,
    "confluence": 2,
    "signalScore": { "score": 0.72, "level": "mid" },
    "role": "leader",
    "createdAt": "..."
  }
]
```

- `DELETE /api/signal-history` — پاک کردن کل
- `GET /api/signal-history/rejected?limit=100` — سیگنال‌های رد شده

#### GET /api/quotes

آخرین quoteها.

```json
{
  "اهرم": { "price": 79500, "queue": null, "at": "..." },
  "خودرو": { "price": 2410, "queue": "buy", "at": "..." }
}
```

### Backtest

#### POST /api/backtest/run

اجرای orchestrator.

```json
{
  "mode": "option",
  "symbols": ["اهرم", "خودرو"],
  "strategies": [{ "id": "smc_unicorn" }, { "id": "ob_sweep" }],
  "panels": {
    "analysis": { "enabled": true, "minTrades": 5, "iterations": 10000 },
    "portfolio": { "enabled": true, "capital": 100000000, "riskPct": 1.5 },
    "wf": { "enabled": true, "windows": 4, "numTrials": 234 },
    "regime": { "enabled": true }
  },
  "dateFrom": 1700000000,
  "dateTo": 1728560000,
  "optionType": "call",
  "qualityLevel": "B"
}
```

Response: `{ "jobId": "...", "status": "QUEUED" }`

#### GET /api/backtest/results/:jobId

```json
{
  "_id": "...",
  "type": "backtest-compare",
  "status": "DONE",
  "result": {
    "mode": "option",
    "summary": { "total": 4, "valid": 3, "insufficient": 1, "errors": 0 },
    "details": [
      {
        "symbol": "اهرم",
        "strategyId": "smc_unicorn",
        "stockStats": { "count": 45, "winRate": 55.6, "profitFactor": 1.8 },
        "optionStats": { "count": 30, "winRate": 60, "profitFactor": 2.1 },
        "trades": []
      }
    ],
    "portfolio": {
      "acceptedTrades": 12,
      "stats": {
        "totalReturnPct": 45.2,
        "maxDD": 8.5,
        "profitFactor": 2.3,
        "sharpe": 1.6
      }
    },
    "analysis": { "totalAnalyzed": 4, "passing": 2, "results": [] },
    "wf": { "totalTrades": 30, "overall": { "consistencyPct": 75, "avgPF": 1.8 } }
  }
}
```

#### POST /api/backtest/recompute/:jobId

محاسبه مجدد.

#### POST /api/backtest/apply

اعمال انتخاب‌ها.

```json
{
  "jobId": "...",
  "selections": [
    {
      "symbol": "اهرم",
      "pairs": [
        { "strategyId": "smc_unicorn", "role": "leader" },
        { "strategyId": "ob_sweep", "role": "confirmer" }
      ]
    }
  ]
}
```

#### POST /api/jobs/backtest

بک‌تست تک config.

#### POST /api/jobs/backtest-compare

مقایسه‌ای.

#### POST /api/jobs/auto-config

تنظیم خودکار.

#### GET /api/jobs/:id/download

دانلود نتیجه JSON.

### System

#### GET /api/system/stats

```json
{
  "ram": { "totalMB": 1968, "usedMB": 1238, "freeMB": 730, "usedPct": 63 },
  "cpu": { "loadAvg": [0.64, 1.22, 1.91], "cores": 1, "usedPct": 10 },
  "disk": { "totalGB": 37.7, "usedGB": 13.3, "freeGB": 24.4, "usedPct": 35 },
  "processes": [
    { "name": "OptionHunter", "type": "node", "status": "online", "memoryMB": 105 },
    { "name": "collector", "type": "python", "status": "online", "memoryMB": 179 }
  ],
  "database": { "sizeMB": 1080, "objects": 8415002, "collections": 39 },
  "uptime": 3600,
  "serverStartedAt": "..."
}
```

- `GET /api/system/jobs` — jobهای backend + collector
- `GET /api/logs?limit=200&source=memory|db`
- `POST /api/telegram/test`
- `POST /api/backup/run`

### Regime & Portfolio

- `GET /api/regime/all`
- `GET /api/regime/:symbol`
- `GET /api/regime/strategy-map`
- `POST /api/regime/refresh`
- `GET /api/portfolio`
- `GET /api/portfolio/analysis`
- `GET /api/portfolio/correlation`
- `POST /api/portfolio/correlation/refresh`
- `POST /api/portfolio/simulate/:jobId`

### Dashboard & Journal

#### GET /api/dashboard/live

```json
{
  "at": "2026-10-10T17:33:00Z",
  "capital": { "total": 10000000, "exposure": 3500000, "cash": 6500000, "exposurePct": 35 },
  "openPositions": { "count": 3, "positions": [] },
  "today": { "opened": 0, "closed": 2, "signals": 5, "rejected": 1 },
  "last30d": { "trades": 45, "winRate": 58, "pf": 2.1 },
  "drift": { "backtestPF": 2.5, "livePF": 2.1, "ratio": 0.84, "severity": "ok" }
}
```

- `GET /api/journal?limit=200`
- `GET /api/journal/:id`
- `POST /api/journal/sync`

### Paper Trading

- `GET /api/paper-trading/summary`
- `GET /api/paper-trading/trades`
- `GET /api/paper-trading/report`
- `POST /api/paper-trading/sync`

### Reports

- `GET /api/reports/monthly/latest`
- `POST /api/reports/monthly/generate`

### Doctor (OHDoctor)

#### POST /api/doctor/run

```json
{
  "skipHeavy": true,
  "skipPipeline": true,
  "skipBacktest": true,
  "sendReport": true,
  "sections": [1, 2, 3, 36]
}
```

Response: `{ "jobId": "...", "pid": 1234, "outputFile": "ohdoctor-..." }`

- `GET /api/doctor/status`
- `GET /api/doctor/tail?limit=200&file=...`
- `GET /api/doctor/list`
- `GET /api/doctor/file/:name`
- `POST /api/doctor/kill`

---

## فرمت داده

### Contract Symbol Format

```
ض<underlying><strike>
ضهرم7050  → Call on اهرم، strike 7050
طهرم7050  → Put on اهرم، strike 7050
```

### dataQuality

| مقدار | معنی |
|---|---|
| `real` | bid/ask واقعی از TSETMC |
| `enriched` | bid/ask از مدل اسپرد (pessimistic) |
| `missing_price` | هیچ قیمتی نیست |
| `synthetic_daily` | قدیمی، نیاز به rebuild |

### Option Type

- `isCall: true` → Call (کال)
- `isCall: false` → Put (پوت)

### Signal Types

- `BUY` — سیگنال خرید
- `EXIT_LONG` — سیگنال خروج

### Regime

- **macro:** `bull` | `bear` | `range` | `unknown`
- **vol:** `high` | `normal` | `low` | `unknown`

---

## جریان‌های معمول

### Scenario 1: گرفتن زنجیره و انتخاب قرارداد بهینه

```
1. GET http://127.0.0.1:5000/chain/enriched?fresh=1
2. فیلتر روی basis_name == "اهرم"
3. فقط isCall == true و ask > 0 و bid > 0
4. daysLeft بین 7 تا 60
5. delta نزدیک 0.55
6. مرتب‌سازی بر اساس OI یا volume
7. انتخاب اولین
```

### Scenario 2: نرخ بدون ریسک

```
GET http://127.0.0.1:5000/risk-free
{ "rate": 0.42 }
```

### Scenario 3: تحلیل داده یک نماد

```
GET http://127.0.0.1:5000/explain/اهرم
```

### Scenario 4: دریافت سیگنال‌ها

```
GET http://127.0.0.1:3000/api/signal-history?limit=50
```

### Scenario 5: زنجیره با cache (سریع‌تر)

```
GET http://127.0.0.1:3000/api/options-chain?meta=1
```

---

## مثال‌ها

### curl: زنجیره کامل

```bash
curl -s 'http://127.0.0.1:5000/chain/enriched?meta=1' | jq '.count'
```

### curl: فیلتر Call اهرم

```bash
curl -s 'http://127.0.0.1:5000/chain/enriched' | \
  jq '[.[] | select(.basis_name == "اهرم" and .isCall == true and .ask > 0)]'
```

### curl: نرخ بدون ریسک

```bash
curl -s 'http://127.0.0.1:5000/risk-free'
```

### curl: coverage

```bash
curl -s 'http://127.0.0.1:5000/coverage' | jq '.symbols[] | {symbol, options: .options.count}'
```

### curl: monitored symbols

```bash
curl -s 'http://127.0.0.1:3000/api/monitored-symbols' | jq '.[].symbol'
```

### curl: quotes

```bash
curl -s 'http://127.0.0.1:3000/api/quotes' | jq
```

### JavaScript: انتخاب بهترین Call

```javascript
async function pickBestCall(underlying, targetDelta = 0.55) {
  const res = await fetch('http://127.0.0.1:5000/chain/enriched?fresh=1');
  const chain = await res.json();
  const candidates = chain.filter(c =>
    c.basis_name === underlying &&
    c.isCall === true &&
    c.ask > 0 && c.bid > 0 &&
    c.daysLeft >= 7 && c.daysLeft <= 60
  );
  if (!candidates.length) return null;
  return candidates.sort((a, b) =>
    Math.abs(a.delta - targetDelta) - Math.abs(b.delta - targetDelta)
  )[0];
}
```

### Python: اتصال از OptionStrategist

```python
import httpx

COLLECTOR = "http://127.0.0.1:5000"
BACKEND = "http://127.0.0.1:3000"

def get_chain(underlying=None, fresh=False):
    url = f"{COLLECTOR}/chain/enriched"
    if fresh:
        url += "?fresh=1"
    r = httpx.get(url, timeout=60)
    r.raise_for_status()
    chain = r.json()
    if underlying:
        chain = [c for c in chain if c["basis_name"] == underlying]
    return chain

def get_risk_free():
    return httpx.get(f"{COLLECTOR}/risk-free").json()["rate"]

def get_live_market(symbol=None):
    url = f"{COLLECTOR}/live-market"
    if symbol:
        url += f"/{symbol}"
    return httpx.get(url).json()["data"]
```

---

## Error Codes

| Status | Meaning |
|---|---|
| 200 | موفق |
| 400 | درخواست نامعتبر |
| 401 | توکن ادمین نامعتبر |
| 404 | مسیر یا منبع یافت نشد |
| 429 | Rate limit |
| 500 | خطای داخلی سرور |
| 503 | سرویس موقتاً در دسترس نیست |

---

## Rate Limits

- `/api/backtest/*`, `/api/jobs/*`, `/api/pipeline/*` → ۱۰ درخواست در دقیقه
- سایر POST/PUT/DELETE → ۳۰ درخواست در دقیقه
- GET → ۳۰۰ درخواست در دقیقه
- **localhost bypass می‌شود**

---

## نکات مهم

1. همیشه از `?fresh=1` در زمان معاملات استفاده کن (cache ۶۰s دارد)
2. روی `ask > 0 && bid > 0` فیلتر بگذار — بدون bid/ask معامله معنی ندارد
3. **delta هدف = 0.55** برای انتخاب ATM
4. **daysLeft بین 7 تا 60** برای جلوگیری از theta سنگین
5. قبل از هر معامله `risk-free` را از collector بگیر (کش روزانه)
6. `/explain/:symbol` برای چک کردن داده یک نماد — مفید برای debug
7. از `/coverage` برای پوشش کلی استفاده کن، نه برای هر نماد جدا
8. اگه collector offline بود، fallback به `/api/options-chain` در backend
9. **زمان‌ها به UTC هستند** — Tehran = UTC+3:30
10. **فرمت فارسی:** از `normalize_fa` استفاده کن (unify ی/ي و ک/ك)

---

**آخرین بروزرسانی:** 1405/07/18