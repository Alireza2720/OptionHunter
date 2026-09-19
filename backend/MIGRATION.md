# Migration Guide: v9 → v10

این سند مراحل مهاجرت از معماری قدیم به معماری جدید (v10.0-clean) رو توضیح می‌ده.

## ۱. فایل‌هایی که باید حذف شن

بعد از اینکه سرور جدید بالا اومد و تست شد:

```bash
cd backend
rm db.js
rm log.js
rm algotik_client.js
rm option.js
rm backtest_service.js
rm tsetmc.js