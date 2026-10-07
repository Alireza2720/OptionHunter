# OptionHunter

سیستم معاملات خودکار اختیار معامله روی بورس تهران.

## معماری (Phase 2)

TSETMC -> Collector (:5000) -> MongoDB -> OptionHunter (:3000) -> OptionStrategist (:3001)

سرور: deploy@185.239.0.243

## سرویس‌ها

- Collector (5000): دریافت داده TSETMC + ساخت زنجیره غنی‌شده
- OptionHunter (3000): بک‌تست، سیگنال، مدیریت سرمایه
- OptionStrategist (3001): استراتژی آپشن، شکار موقعیت
- MongoDB (27017): دیتابیس مشترک

## Endpointهای کلیدی

Collector:
- GET /health
- GET /chain/enriched
- GET /chain/enriched?model=heston
- GET /chain/enriched?fresh=1
- GET /chain/enriched/status

OptionHunter:
- GET /api/options-chain
- GET /api/options-chain?meta=1
- GET /api/options-chain/status
- GET /api/options/chain/:underlying

## استقرار روی سرور

cd ~/apps/OptionHunter
git pull
pm2 restart OptionHunter --update-env

برای collector:
sudo cp collector/service.py /opt/collector/service.py
sudo cp collector/pipeline/*.py /opt/collector/pipeline/
sudo systemctl restart collector

## تست سلامت

curl -s 'http://127.0.0.1:5000/chain/enriched/status'
curl -s 'http://127.0.0.1:3000/api/options-chain?meta=1' | head -c 200

## زمان‌بندی Jobs

- هر ۲ دقیقه: tick (فقط 9:00-12:35)
- 02:00: rolling performance
- 03:00: cleanup jobs
- 03:30: retention
- 12:32: EOD
- 13:00: drift + regime
- 13:15: daily backfill
- 13:30: gap detector

## نکات کلیدی Phase 2

1. Collector = منبع واحد داده (optionschool24 حذف شد)
2. کش مشترک: Collector 60s، OptionHunter 60s
3. Warm-up خودکار بعد از restart (3s)
4. Timeout: options-chain.js=180s، dataSource.js=120s
5. مدل قیمت: BSM (پیش‌فرض) یا Heston
6. درجه‌بندی آپشن: gradeOption() در core/options.js

## تنظیمات کلیدی

- OPTION_QUALITY_LEVEL: B (پیش‌فرض) | A+ / A / C / D
- PRICING_MODEL: bsm | heston
- TOTAL_CAPITAL
- RISK_PER_TRADE_PCT

## عیب‌یابی

sudo journalctl -u collector -n 50 --no-pager
sudo tail -50 /var/log/collector-error.log
pm2 logs OptionHunter --lines 50 --nostream
node backend/scripts/monitor.js --doctor --skip-heavy

## تاریخچه

Phase 2 (2026-10-07):
- مهاجرت از optionschool24 به TSETMC
- ماژول Heston
- endpoint /api/options-chain
- درجه‌بندی grade-aware آپشن
- warm-up cache
- افزایش timeoutها
- حذف optionsChain.setUrl که URL را override می‌کرد
- stage timing در dual-stage pipeline

Phase 1:
- زیرساخت بک‌تست
- تحلیل آماری
- Walk-forward
- مدیریت سرمایه
