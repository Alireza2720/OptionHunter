# OptionHunter

سیستم معاملات خودکار اختیار معامله روی بورس تهران.

## معماری

```
TSETMC → Collector (:5000) → MongoDB → OptionHunter (:3000) → OptionStrategist (:3001)
                                                  ↓
                                          Frontend (index.html)
```

**سرور:** deploy@185.239.0.243

## سرویس‌ها

| سرویس | پورت | مسئولیت |
|---|---|---|
| Collector | 5000 | دریافت داده TSETMC + ساخت زنجیره غنی‌شده آپشن |
| OptionHunter | 3000 | بک‌تست، سیگنال، مدیریت سرمایه، زنجیره آپشن |
| OptionStrategist | 3001 | استراتژی آپشن، شکار موقعیت (سرویس جدا) |
| MongoDB | 27017 | دیتابیس مشترک |
| nginx | 80/443 | Reverse proxy |

## ساختار پوشه‌ها

```
OptionHunter/
├── backend/            ← Node.js API server
│   ├── api/            ← routes + middleware
│   ├── core/           ← منطق خالص (backtest, options, signals)
│   ├── services/       ← سرویس‌ها (data, config, backtest)
│   ├── infra/          ← اتصال‌ها (mongo, telegram, algotik)
│   ├── jobs/           ← cron jobs (tick, eod, backup)
│   ├── scripts/        ← ابزار (monitor.js = OHDoctor)
│   └── bootstrap.js    ← wiring تمام dependency ها
├── collector/          ← Python FastAPI (TSETMC scraper + enrichment)
│   ├── pipeline/       ← options, stocks, greeks, live
│   ├── option_reconstruction/  ← spread model + enricher
│   └── service.py      ← FastAPI app
├── frontend/           ← SPA تک‌فایلی (index.html)
└── scripts/            ← deploy scripts
```

## راه‌اندازی سریع

### Collector
```bash
sudo systemctl start collector
sudo systemctl status collector
sudo journalctl -u collector -f
```

### Backend
```bash
pm2 start ecosystem.config.js
pm2 status
pm2 logs OptionHunter
```

### Deploy
```bash
cd ~/apps/OptionHunter
git fetch origin main
git reset --hard origin/main
sudo cp collector/service.py /opt/collector/service.py
sudo cp collector/pipeline/*.py /opt/collector/pipeline/
sudo systemctl restart collector
pm2 restart OptionHunter
pm2 save
```

## Endpointهای کلیدی

### Collector (پورت 5000)

- `GET /health` — سلامت سرویس
- `GET /status` — آمار کلی دیتابیس
- `GET /coverage` — پوشش دیتا هر نماد (Mongo cache)
- `GET /chain/enriched` — زنجیره کامل آپشن (BSM)
- `GET /chain/enriched?model=heston` — با مدل Heston
- `GET /chain/enriched?fresh=1` — bypass cache
- `GET /chain/enriched/status` — metadata
- `GET /live-market` — snapshot زنده بازار سهام
- `GET /explain/:symbol` — بررسی داده آپشن یک نماد
- `GET /jobs?limit=30` — لیست jobها
- `POST /jobs/full-backfill` — backfill
- `POST /jobs/:id/cancel` — لغو
- `POST /jobs/:id/pause` — توقف موقت
- `POST /jobs/:id/resume` — ادامه
- `POST /enrich-now` — شروع غنی‌سازی
- `GET /data-range` — بازه داده کل
- `GET /risk-free` — نرخ بدون ریسک

### Backend (پورت 3000)

- `GET /ping`
- `GET /` — وضعیت کلی
- `GET /strategies.js` — کتابخانه استراتژی‌ها
- `GET /api/strategies`
- `GET /api/timeframes`
- `GET /api/monitored-symbols`
- `GET /api/strategy-configs`
- `GET /api/status` — state همه configها
- `GET /api/signal-history`
- `GET /api/quotes`
- `GET /api/options-chain` — proxy به collector
- `GET /api/options/chain/:underlying`
- `GET /api/options/positions`
- `GET /api/options/recommend/:configId`
- `GET /api/algotik/*` — proxy به collector
- `GET /api/system/stats`
- `GET /api/system/jobs`
- `GET /api/jobs?limit=50&all=1`
- `POST /api/jobs/backtest`
- `POST /api/jobs/backtest-compare`
- `POST /api/backtest/run`
- `GET /api/backtest/results/:jobId`
- `POST /api/backtest/apply`
- `GET /api/dashboard/live`
- `GET /api/regime/all`
- `GET /api/journal`
- `GET /api/portfolio/analysis`
- `GET /api/paper-trading/summary`
- `POST /api/doctor/run`
- `GET /api/doctor/status`
- `GET /api/reports/monthly/latest`

## Jobs زمان‌بندی‌شده

| Cron | Job | توضیح |
|---|---|---|
| هر ۲ دقیقه | tick.job | tick (فقط ۹:۰۰-۱۲:۳۵) |
| ۲:۰۰ | rolling perf | هر شب |
| ۳:۰۰ | cleanup jobs | هر شب |
| ۳:۳۰ | retention | هر شب |
| ۳:۴۵ | correlation | هر شب |
| ۱۲:۳۲ | eod | بعد از بازار |
| ۱۲:۳۵ | daily summary | بعد از بازار |
| ۱۳:۰۰ | regime refresh | |
| ۱۳:۰۵ | drift check | |
| ۱۳:۱۵ | daily backfill | |
| ۱۳:۳۰ | gap detector | |
| ۱۳:۴۰ / ۱۵:۴۰ / ۱۷:۴۰ | sector rank | |
| اول ماه ۱۰:۳۰ | monthly report | |
| هر ۲ ساعت | risk-free refresh | |
| هر ۵ دقیقه | health check | |
| هر ۵ دقیقه | tick freshness | |

## OHDoctor (سیستم دکتر)

`backend/scripts/monitor.js` — ۳۶ سکشن بررسی:

```bash
# حالت پیش‌فرض (خارج از ساعات بازار)
node backend/scripts/monitor.js --doctor --skip-heavy --send-report

# فقط بخش‌های خاص
node backend/scripts/monitor.js --doctor --sections=1,2,3,9

# حالت daemon (PM2)
node backend/scripts/monitor.js --daemon
```

بخش‌های کلیدی:
- **S1-S10**: env, structure, syntax, patterns, config, PM2, systemd, mongo, HTTP, collector
- **S11-S20**: cross-service, gaps, live tick, strategies, regime, journal, portfolio, pipeline, backtest, Bale
- **S21-S30**: performance, security, logs, backup, cron, SSL, disk, memory leak, integrity, signals
- **S31-S36**: failed jobs, network, positions, report, mechanisms, option debug

## Strategy Sweep

تست خودکار ۳۰ ترکیب پارامتر × هر استراتژی:

- Endpoint: `POST /api/sweep/run` (symbols + strategies + modes)
- امتیاز: `PF^0.75 × N^0.25`
- نتایج در `meta.strategy_sweep_latest`

## مدیریت سرمایه

- **Duplicate Guard** — یک پوزیشن به ازای هر نماد
- **Correlation Cluster** — سقف ۳۰٪ برای cluster همبسته
- **Sector Limit** — سقف ۴۰٪ هر صنعت
- **Kelly Sizing** — با نمونه ≥ ۳۰ معامله
- **Time-Decay** — کاهش تدریجی حجم بعد ۱۱:۳۰
- **Signal Filter** — whitelist pairهای تأییدشده
- **Regime Soft** — کاهش حجم یا رد در رژیم خطرناک

## نکات مهم

1. **Collector = منبع واحد داده** (optionschool24 حذف شد)
2. **coverage** با Mongo cache → پاسخ زیر ۰.۱s
3. **quality** با parallel aggregation → پاسخ زیر ۰.۱s
4. **jalalidatepicker** از jsdelivr (پایدارتر از unpkg)
5. **API_GUIDE.md** برای OptionStrategist

## عیب‌یابی

```bash
# Collector
sudo journalctl -u collector -n 50 --no-pager

# Backend
pm2 logs OptionHunter --lines 50 --nostream

# MongoDB
mongosh --eval "db.stats()"

# Doctor (خارج از ساعت بازار)
node backend/scripts/monitor.js --doctor --skip-heavy
```

## تاریخچه نسخه‌ها

### Phase 22-25 (1405/07/18)
- Combined-mode auto-config (3 buttons)
- Fix SyntaxError در دکمه‌های ترکیبی
- Restore 10 routes که در phase 20 حذف شده بودند
- Coverage/quality بهینه‌سازی (Mongo-direct cache + parallel agg)
- Pause/Resume برای Backfill و Enrichment
- Backfill symbol filter
- Dr. sections filter (`--sections=36`)
- README + API_GUIDE

### Phase 2 (1405/07/15)
- مهاجرت از optionschool24 به TSETMC
- ماژول Heston
- Grade-aware option sizing
- Warm-up cache

### Phase 1
- زیرساخت بک‌تست
- تحلیل آماری
- Walk-forward
- مدیریت سرمایه

## سرور

- **Host:** srv9202102683
- **IP:** 185.239.0.243
- **User:** deploy
- **RAM:** 2GB
- **Disk:** 38GB
- **OS:** Ubuntu 24.04 LTS