# 🎯 OptionHunter

سیستم معاملات خودکار اختیار معامله روی بورس تهران.

**سرور**: deploy@185.239.0.243
**Node**: v22.23.3 | **PM2**: 2 processes | **MongoDB**: docker:27017

---

## 🏗 معماری

Collector (Python :5000) → MongoDB → Backend (Node :3000) → Frontend (HTML)

---

## 🚀 نصب سریع

```bash
# NVM + Node 22
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc
nvm install 22
nvm alias default 22
npm install -g pm2

# پروژه
git clone https://github.com/Alireza2720/OptionHunter.git ~/apps/OptionHunter
cd ~/apps/OptionHunter && npm install

# MongoDB
docker run -d --name mongodb --restart=always -p 127.0.0.1:27017:27017 mongo:7

# PM2 startup
sudo env PATH=$PATH:$(which node | xargs dirname) pm2 startup systemd -u deploy --hp /home/deploy
pm2 start ecosystem.config.js && pm2 save
🔑 .env نمونه
text
MONGO_URI=mongodb://optionhunter:PASS@127.0.0.1:27017/trading_bot?authSource=trading_bot
ALGOTIK_URL=http://127.0.0.1:5000
PORT=3000
HOST=127.0.0.1
NODE_ENV=production
ADMIN_TOKEN=<strong-token>
TELEGRAM_BOT_TOKEN=<bale-token>
TELEGRAM_CHAT_ID=<chat-id>
TELEGRAM_API_BASE=https://tapi.bale.ai
OPTIONS_API_URL=https://s3.optionschool24.com/last?type=3
ENTRY_START=09:30
ENTRY_END=12:00
🎓 تجربیات ۲۰۲۶-۱۰-۰۳
۱. آپدیت Node 18 → 22
Node 18 EOL شده بود

بعد از nvm install 22: npm install -g pm2 && pm2 update

pm2 startup دوباره اجرا شود

۲. Candle Cache TTL
مشکل: CPU 92٪، tick 152s

علت: cache هر ۳min پاک می‌شد

راه‌حل: CANDLE_TTL_MS = 30 * 60 * 1000 در data.service.js

۳. Rotation Pattern
javascript
const TOTAL_BUDGET_MS = 20000;
const startPointer = global.__evalAllPointer % N;
for (let i = 0; i < N; i++) {
    const idx = (startPointer + i) % N;
    if (Date.now() - startedAt > TOTAL_BUDGET_MS) break;
    await evaluateOne(_all[idx]);
}
global.__evalAllPointer = (startPointer + processed) % N;
۴. cron 6-field
*/120 معتبر نیست (فیلد ثانیه 0-59)

هر ۱۲۰s: 0 */2 * * * *

۵. TradeCount
algotik-tse جدید: s.TradeCount نه s.tno

باگ تشخیص تعطیلی از همین بود

۶. Intl Singleton
new Intl.DateTimeFormat() مکرر گران است

راه‌حل: _TEHRAN_FMT یک بار ساخته شود

۷. Backup
~/backup-oh.sh + cron 0 2 * * *

۸. OHDoctor
backend/scripts/monitor.js

--daemon برای PM2، --doctor برای تشخیص

۳۴ بخش پوشش

۹. نکات کد
LIVE_CANDLE_LIMIT = 1000 در signals.js

tick timeout: 90s، interval: 120s

s.TradeCount || s.tno || s.Volume

🔧 عیب‌یابی سریع
bash
pm2 status
curl http://127.0.0.1:3000/ping
pm2 logs OptionHunter --lines 50 --nostream
node backend/scripts/monitor.js --doctor --skip-heavy
pm2 restart OptionHunter
⏰ زمان‌بندی Jobs
روزها: شنبه-چهارشنبه

ساعت	Job
هر ۱۰s	tick (فقط 9-12:35)
02:00	rolling performance
03:00	cleanup jobs
03:30	retention
12:32	EOD
13:00	drift + regime
13:15	daily backfill
13:30	gap detector
پنجره‌های امن OHDoctor: 14:45-15:45، 15:50-18:45، 18:50-02:00

📝 یادداشت AI چت بعدی
وضعیت 2026-10-03
✅ سرور پایدار، CPU 15٪

✅ Node v22.23.3

✅ 69 config، OHDoctor: 0 issues

✅ tick interval 120s، duration 30s

کارهای باقی‌مانده
13 config مرده

23 نماد با شکاف

Math.min/max spread (5 مورد)

نکات مهم کد
TOTAL_BUDGET_MS = 20000 — signals.js

0 */2 * * * * — tick.job.js

CANDLE_TTL_MS = 30*60*1000 — data.service.js

LIVE_CANDLE_LIMIT = 1000 — signals.js

_TEHRAN_FMT — singleton

global.__evalAllPointer — rotation

s.TradeCount || s.tno || s.Volume — active count

قوانین کار
قبل از تغییر: backup

بعد از تغییر: node --check

قبل از push: git status

text

---

### مرحله ۲ — ذخیره

**Save As:**
- **File name:** `README.md`
- **Save as type:** `All Files (*.*)`
- **Encoding:** `UTF-8` (پایین پنجره‌ی Save)
- **Location:** `C:\Users\Alireza\Desktop\OptionHunter\`

**روی Save کلیک کن. اگر گفت overwrite، Yes بزن.**

---

### مرحله ۳ — در PowerShell

```powershell
cd C:\Users\Alireza\Desktop\OptionHunter
git status
git add README.md
git commit -m "docs: rewrite README with setup guide + lessons"
git push
مرحله ۴ — تأیید
powershell
git log -1 --oneline
باید ببینی:

text
abc1234 docs: rewrite README with setup guide + lessons