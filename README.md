# 📚 کتابخانه‌ی تست‌های OptionHunter

همه‌ی تست‌ها جمع‌آوری شده. هر تست کامله، کار می‌کنه و مستقل قابل اجراست.

---

## 🗂 فهرست

| # | تست | کاربرد | زمان اجرا |
|---|-----|--------|----------|
| ۱ | سیستم جامع | بررسی کلی سرور | ~۳۰ ثانیه |
| ۲ | سرعت Endpointها | اندازه‌گیری latency | ~۲۰ ثانیه |
| ۳ | SWR Cache | بررسی cache بعد از بیکاری | ~۵۰ ثانیه |
| ۴ | رصد بک‌تست ساده | پیگیری زنده بک‌تست | زنده |
| ۵ | رصد بک‌تست دقیق | هر ۳۰s + هشدار restart | زنده |
| ۶ | CPU Hound | پیدا کردن مقصر مصرف CPU | ۲۴ ساعت |
| ۷ | عملکرد روز بازار | خلاصه‌ی کامل روز | ~۱۵ ثانیه |
| ۸ | فرمت تاریخ AlgoTik | تست فرمت درست ورودی | ~۳۰ ثانیه |
| ۹ | مانیتور PM2 | رصد دائم سرور | دائمی |

---

# ۱️⃣ تست سیستم جامع

**کاربرد:** بررسی کامل سرور — منابع، سرویس‌ها، ۲۰ endpoint، MongoDB
**زمان:** ~۳۰ ثانیه
**کی بزن:** بعد از هر deploy یا مشکل

```bash
cat > /tmp/ohtest.sh << 'ENDOFTEST'
#!/bin/bash
# ═══════════════════════════════════════════════════════════
# OptionHunter — Comprehensive System Test
# ═══════════════════════════════════════════════════════════
cd ~/apps/OptionHunter
set +e
TOKEN=$(grep ADMIN_TOKEN ~/apps/OptionHunter/.env | cut -d= -f2 | tr -d '"' | tr -d "'")
API="http://127.0.0.1:3000"
COLL="http://127.0.0.1:5000"

line() { printf '─%.0s' {1..70}; echo; }
title() { echo ""; line; echo "  $1"; line; }

title "۱) منابع سیستم"
top -bn1 | head -5 | tail -3
echo ""
echo "─── Memory ───"
free -m | head -3
echo ""
echo "─── Top processes ───"
ps -eo pid,pcpu,pmem,comm --sort=-pcpu | head -8

title "۲) PM2"
pm2 status
echo ""
pm2 jlist 2>/dev/null | python3 -c "
import sys, json
try:
    p = json.load(sys.stdin)
    for x in p:
        print(f\"  {x['name']:15} restarts={x['pm2_env'].get('restart_time',0):3}  mem={round(x['monit']['memory']/1048576)}M\")
except: pass
"

title "۳) Collector health"
curl -s --max-time 5 $COLL/health | python3 -m json.tool 2>/dev/null || echo "  ❌ no response"

title "۴) سرعت Endpointها"
test_ep() {
    local name="$1"; local url="$2"; local auth="$3"
    local result
    if [ -n "$auth" ]; then
        result=$(curl -s -o /dev/null -w "%{http_code} %{time_total}" --max-time 60 -H "x-admin-token: $TOKEN" "$url")
    else
        result=$(curl -s -o /dev/null -w "%{http_code} %{time_total}" --max-time 60 "$url")
    fi
    local code=$(echo $result | awk '{print $1}')
    local time=$(echo $result | awk '{print $2}')
    local icon="✅"
    [ "$code" != "200" ] && icon="❌"
    [ "$(echo "$time > 3" | bc -l 2>/dev/null)" = "1" ] && icon="🐌"
    [ "$(echo "$time > 1" | bc -l 2>/dev/null)" = "1" ] && [ "$icon" = "✅" ] && icon="🟡"
    printf "  %-35s %s  %6.3f s  HTTP %s\n" "$name" "$icon" "$time" "$code"
}
test_ep "/ping"                     "$API/ping"                     ""
test_ep "/"                         "$API/"                         ""
test_ep "/api/strategies"           "$API/api/strategies"           ""
test_ep "/api/timeframes"           "$API/api/timeframes"           ""
test_ep "/api/monitored-symbols"    "$API/api/monitored-symbols"    "auth"
test_ep "/api/strategy-configs"     "$API/api/strategy-configs"     "auth"
test_ep "/api/status"               "$API/api/status"               "auth"
test_ep "/api/algotik/status"       "$API/api/algotik/status"       "auth"
test_ep "/api/algotik/coverage"     "$API/api/algotik/coverage"     "auth"
test_ep "/api/algotik/quality"      "$API/api/algotik/quality"      "auth"
test_ep "/api/quotes"               "$API/api/quotes"               ""
test_ep "/api/dashboard/live"       "$API/api/dashboard/live"       "auth"
test_ep "/api/signal-history"       "$API/api/signal-history"       ""
test_ep "/api/options/positions"    "$API/api/options/positions"    "auth"
test_ep "/api/system/stats"         "$API/api/system/stats"         ""
test_ep "/api/jobs?limit=5"         "$API/api/jobs?limit=5"         ""

title "۵) Collector endpoints"
for ep in /health /status /coverage /risk-free /symbols; do
    result=$(curl -s -o /dev/null -w "%{http_code} %{time_total}" --max-time 30 "$COLL$ep")
    printf "  %-35s %s  %6.3f s\n" "$ep" "$(echo $result | awk '{print $1}')" "$(echo $result | awk '{print $2}')"
done

title "۶) استرس (۱۰ درخواست همزمان)"
START=$(date +%s.%N)
for i in $(seq 1 10); do curl -s -o /dev/null "$API/api/quotes" & done
wait
END=$(date +%s.%N)
echo "  کل: $(echo "$END - $START" | bc) ثانیه"

title "۷) MongoDB"
top -bn1 | grep mongod | head -1
echo "  Connections: $(ss -tan 2>/dev/null | grep -c ':27017')"

title "۸) Monitor log (last 5)"
tail -5 ~/apps/OptionHunter/logs/monitor.log 2>/dev/null || echo "  (no log)"

title "۹) خطاهای اخیر"
echo "─── Error log ───"
tail -10 ~/apps/OptionHunter/logs/error.log 2>/dev/null | tail -5 || echo "  (empty)"
echo ""
echo "─── Collector errors ───"
sudo tail -20 /var/log/collector.log 2>/dev/null | grep -iE "error|fail|exception" | tail -5 || echo "  (empty)"

title "۱۰) خلاصه"
IDLE=$(top -bn1 | grep '%Cpu' | awk '{print $8}' | tr -d '%')
FREE=$(free -m | awk 'NR==2 {print $4}')
SWAP=$(free -m | awk 'NR==3 {print $3}')
RESTARTS=$(pm2 jlist 2>/dev/null | python3 -c "
import sys, json
try:
    p = json.load(sys.stdin)
    for x in p:
        if x['name']=='OptionHunter': print(x['pm2_env'].get('restart_time',0))
except: print('?')
")
echo "  CPU idle     : ${IDLE}%"
echo "  RAM free     : ${FREE} MB"
echo "  Swap used    : ${SWAP} MB"
echo "  Node restarts: ${RESTARTS}"
echo ""
IDLE_INT=$(printf "%.0f" "$IDLE" 2>/dev/null || echo 0)
if [ "$IDLE_INT" -gt 70 ] && [ "$FREE" -gt 200 ]; then
    echo "  🎯 ✅ سرور سالم"
elif [ "$IDLE_INT" -gt 40 ] && [ "$FREE" -gt 100 ]; then
    echo "  🎯 🟡 قابل قبول"
else
    echo "  🎯 🔴 نیاز به بررسی"
fi
line
ENDOFTEST
chmod +x /tmp/ohtest.sh
/tmp/ohtest.sh 2>&1 | tee /tmp/ohtest-$(date +%Y%m%d).txt
```

---

# ۲️⃣ تست سرعت Endpointها

**کاربرد:** فقط اندازه‌گیری latency (بدون بررسی منابع)
**زمان:** ~۲۰ ثانیه
**کی بزن:** وقتی می‌خوای سریع ببینی کدوم endpoint کنده

```bash
cat > /tmp/speedtest.sh << 'ENDS'
#!/bin/bash
cd ~/apps/OptionHunter
TOKEN=$(grep ADMIN_TOKEN ~/apps/OptionHunter/.env | cut -d= -f2 | tr -d '"' | tr -d "'")
API="http://127.0.0.1:3000"

echo "═══ Speed Test ═══"
printf "  %-40s %s\n" "Endpoint" "Time (s)"
echo "  ────────────────────────────────────────"

test() {
    local r=$(curl -s -o /dev/null -w "%{time_total}" --max-time 60 -H "x-admin-token: $TOKEN" "$API$1")
    printf "  %-40s %s\n" "$1" "$r"
}

test "/ping"
test "/api/monitored-symbols"
test "/api/strategy-configs"
test "/api/status"
test "/api/algotik/status"
test "/api/algotik/coverage"
test "/api/algotik/quality"
test "/api/quotes"
test "/api/dashboard/live"
test "/api/jobs?limit=5&all=1"

echo ""
echo "✅ Done"
ENDS
chmod +x /tmp/speedtest.sh
/tmp/speedtest.sh
```

---

# ۳️⃣ تست SWR Cache (بعد از بیکاری)

**کاربرد:** شبیه‌سازی «اولین درخواست بعد از مدت طولانی»
**زمان:** ~۵۰ ثانیه
**کی بزن:** وقتی می‌خوای مطمئن شی cache درست کار می‌کنه

```bash
cat > /tmp/swrtest.sh << 'ENDS'
#!/bin/bash
cd ~/apps/OptionHunter
TOKEN=$(grep ADMIN_TOKEN ~/apps/OptionHunter/.env | cut -d= -f2 | tr -d '"' | tr -d "'")
API="http://127.0.0.1:3000"

line() { printf '─%.0s' {1..60}; echo; }

echo "═══ SWR Cache Test ═══"
line

hit() {
    local name="$1"; local url="$2"
    local t=$(curl -s -o /dev/null -w "%{time_total}" --max-time 60 -H "x-admin-token: $TOKEN" "$url")
    printf "  %-40s %6.3f s\n" "$name" "$t"
    echo "$t"
}

echo "─── coverage ───"
hit "1) fresh=1 (cache clear)" "$API/api/algotik/coverage?fresh=1"
hit "2) immediate (warm)"       "$API/api/algotik/coverage"

echo ""
echo "─── quality ───"
hit "1) fresh=1 (cache clear)" "$API/api/algotik/quality?fresh=1"
hit "2) immediate (warm)"       "$API/api/algotik/quality"

echo ""
echo "─── monitored-symbols ───"
hit "shared cache with coverage" "$API/api/monitored-symbols"

echo ""
echo "─── ۲۰ درخواست متوالی ───"
SLOWEST=0; TOTAL=0
for i in $(seq 1 20); do
    t=$(curl -s -o /dev/null -w "%{time_total}" --max-time 60 -H "x-admin-token: $TOKEN" "$API/api/algotik/coverage")
    TOTAL=$(echo "$TOTAL + $t" | bc)
    [ "$(echo "$t > $SLOWEST" | bc -l)" = "1" ] && SLOWEST=$t
done
echo "  کندترین : $SLOWEST"
echo "  میانگین  : $(echo "scale=4; $TOTAL / 20" | bc)"

line
echo "🎯 نتیجه: cold باید یک‌بار کند باشه، warm سریع"
ENDS
chmod +x /tmp/swrtest.sh
/tmp/swrtest.sh
```

---

# ۴️⃣ رصد زنده بک‌تست (ساده)

**کاربرد:** نمایش لحظه‌ای RAM/CPU/Status بک‌تست
**زمان:** زنده (Ctrl+C برای قطع)
**کی بزن:** وقتی بک‌تست در حال اجراست

```bash
cat > /tmp/btw.sh << 'ENDS'
#!/bin/bash
cd ~/apps/OptionHunter
TOKEN=$(grep ADMIN_TOKEN ~/apps/OptionHunter/.env | cut -d= -f2 | tr -d '"' | tr -d "'")
INTERVAL=${1:-15}

echo "═══ Backtest Watcher — ${INTERVAL}s ═══"
echo ""

while true; do
    clear
    TS=$(date '+%H:%M:%S')
    CPU=$(top -bn1 | grep '%Cpu' | awk '{print int(100 - $8)}')
    [ -z "$CPU" ] && CPU="?"

    MEM=$(free -m | awk 'NR==2 {print $3 "/" $4}')
    SWAP=$(free -m | awk 'NR==3 {print $3}')

    NODE=$(pm2 jlist 2>/dev/null | python3 -c "
import sys, json
try:
    p = json.load(sys.stdin)
    for x in p:
        if x['name']=='OptionHunter':
            m = round(x['monit']['memory']/1048576)
            c = x['monit']['cpu']
            r = x['pm2_env'].get('restart_time',0)
            warn = '⚠️' if m > 700 else '✅'
            print(f'{warn} RAM:{m}M CPU:{c}% RST:{r}')
            break
except: print('?')
" 2>/dev/null)

    JOB=$(curl -s --max-time 10 "http://127.0.0.1:3000/api/jobs?limit=3" -H "x-admin-token: $TOKEN" 2>/dev/null | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    for j in d.get('jobs', []):
        if j.get('status') in ('RUNNING','QUEUED','COMPUTING'):
            st = j['status']
            msg = (j.get('progress') or {}).get('message', '')[:55]
            print(f'{st} | {msg}')
            sys.exit(0)
    print('idle')
except: print('?')
" 2>/dev/null)

    echo "  ⏰ $TS"
    echo ""
    echo "  💻 System"
    echo "     CPU:       ${CPU}%"
    echo "     RAM used:  ${MEM}M"
    echo "     Swap:      ${SWAP}M"
    echo ""
    echo "  🟢 Node"
    echo "     $NODE"
    echo ""
    echo "  📊 Job"
    echo "     $JOB"
    echo ""
    echo "  (Ctrl+C to stop)"
    sleep $INTERVAL
done
ENDS
chmod +x /tmp/btw.sh

# استفاده:
# /tmp/btw.sh         # هر 15s
# /tmp/btw.sh 30      # هر 30s
/tmp/btw.sh 15
```

---

# ۵️⃣ رصد دقیق بک‌تست (با هشدار restart)

**کاربرد:** هر ۳۰s snapshot + هشدار فوری اگر restart خورد
**زمان:** زنده (Ctrl+C)
**کی بزن:** بک‌تست‌های طولانی و مهم

```bash
cat > /tmp/btcheck.sh << 'ENDS'
#!/bin/bash
cd ~/apps/OptionHunter
TOKEN=$(grep ADMIN_TOKEN ~/apps/OptionHunter/.env | cut -d= -f2 | tr -d '"' | tr -d "'")
LOG=/tmp/btcheck-$(date +%Y%m%d-%H%M%S).log
INTERVAL=30

INIT_RST=$(pm2 jlist 2>/dev/null | python3 -c "
import sys, json
try:
    p = json.load(sys.stdin)
    for x in p:
        if x['name']=='OptionHunter':
            print(x['pm2_env'].get('restart_time',0))
            break
except: print(0)
")

echo "═══════════════════════════════════════════════════════════" | tee -a $LOG
echo "  📊 Backtest Monitor — Started $(date '+%H:%M:%S')" | tee -a $LOG
echo "  Initial restarts: $INIT_RST" | tee -a $LOG
echo "  Log: $LOG" | tee -a $LOG
echo "═══════════════════════════════════════════════════════════" | tee -a $LOG
echo "" | tee -a $LOG

printf "  %-8s | %-5s | %-8s | %-6s | %-6s | %-5s | %s\n" \
    "TIME" "CPU" "NodeRAM" "RST" "RAMfree" "Swap" "JOB" | tee -a $LOG
echo "  ─────────┼───────┼──────────┼────────┼────────┼───────┼──────────────────────" | tee -a $LOG

while true; do
    TS=$(date '+%H:%M:%S')
    CPU=$(top -bn1 | grep '%Cpu' | awk '{print int(100 - $8)}')
    [ -z "$CPU" ] && CPU="?"

    NODE_INFO=$(pm2 jlist 2>/dev/null | python3 -c "
import sys, json
try:
    p = json.load(sys.stdin)
    for x in p:
        if x['name']=='OptionHunter':
            m = round(x['monit']['memory']/1048576)
            r = x['pm2_env'].get('restart_time',0)
            print(f'{m}|{r}')
            break
except: print('?|?')
")
    NODE_RAM=$(echo $NODE_INFO | cut -d'|' -f1)
    NODE_RST=$(echo $NODE_INFO | cut -d'|' -f2)

    RAM_FREE=$(free -m | awk 'NR==2 {print $4}')
    SWAP=$(free -m | awk 'NR==3 {print $3}')

    JOB=$(curl -s --max-time 10 "http://127.0.0.1:3000/api/jobs?limit=3" -H "x-admin-token: $TOKEN" 2>/dev/null | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    for j in d.get('jobs', []):
        st = j.get('status', '?')
        if st in ('RUNNING','QUEUED','COMPUTING'):
            msg = (j.get('progress') or {}).get('message', '')[:40]
            print(f'{st}: {msg}')
            sys.exit(0)
    print('(no active job)')
except: print('?')
" 2>/dev/null)

    printf "  %-8s | %4s%% | %6sM | %6s | %5sM | %4sM | %s\n" \
        "$TS" "$CPU" "$NODE_RAM" "$NODE_RST" "$RAM_FREE" "$SWAP" "$JOB" | tee -a $LOG

    # هشدارها
    if [ "$NODE_RST" != "$INIT_RST" ] && [ "$NODE_RST" != "?" ]; then
        echo "  ⚠️⚠️⚠️ RESTART! ($INIT_RST → $NODE_RST)" | tee -a $LOG
        echo "  ─── 20 خط آخر log ───" | tee -a $LOG
        pm2 logs OptionHunter --lines 20 --nostream 2>/dev/null | tail -20 | tee -a $LOG
        INIT_RST=$NODE_RST
    fi

    [ "$NODE_RAM" != "?" ] && [ "$NODE_RAM" -gt 750 ] && echo "  ⚠️ Node RAM: ${NODE_RAM}M" | tee -a $LOG
    [ "$RAM_FREE" -lt 100 ] && echo "  ⚠️ RAM کم: ${RAM_FREE}M" | tee -a $LOG
    [ "$SWAP" -gt 800 ] && echo "  ⚠️ Swap بالا: ${SWAP}M" | tee -a $LOG

    sleep $INTERVAL
done
ENDS
chmod +x /tmp/btcheck.sh
/tmp/btcheck.sh
```

---

# ۶️⃣ CPU Hound (پیدا کردن مقصر CPU)

**کاربرد:** ۲۴ ساعت عکس می‌گیره، دقیقاً کی CPU می‌خوره
**زمان:** ۲۴ ساعت در پس‌زمینه
**کی بزن:** وقتی می‌خوای بفهمی چرا CPU بالا می‌ره

```bash
# متوقف کردن نسخه‌ی قدیمی (اگه هست)
sudo pkill -f cpu-hound.sh 2>/dev/null

cat > /tmp/cpu-hound.sh << 'ENDS'
#!/bin/bash
LOG=/tmp/cpu-hound-$(date +%Y%m%d).log
ALERT_LOG=/tmp/cpu-alerts.log

cat > $LOG << 'EOH'
═══════════════════════════════════════════════════════════
  CPU Hound — Detailed Process Tracker
═══════════════════════════════════════════════════════════
EOH

while true; do
    TS=$(date '+%Y-%m-%d %H:%M:%S')
    TZ_TS=$(TZ='Asia/Tehran' date '+%H:%M')

    IDLE=$(top -bn1 | grep '%Cpu' | awk '{print $8}')
    [ -z "$IDLE" ] && IDLE="?"

    TOP5=$(ps -eo pid,pcpu,pmem,etime,cmd --sort=-pcpu | head -6 | tail -5)

    NODE_COUNT=$(pgrep -f "node " | wc -l)
    NODE_CPU_TOTAL=$(ps -eo pcpu,cmd | grep -E "^[0-9.]+ node" | awk '{sum+=$1} END {printf "%.0f", sum}')

    PY_COUNT=$(pgrep -f "python" | wc -l)
    PY_CPU_TOTAL=$(ps -eo pcpu,comm | grep python | awk '{sum+=$1} END {printf "%.0f", sum}')

    MONGO_CPU=$(ps -eo pcpu,comm | grep mongod | awk '{print $1}')
    [ -z "$MONGO_CPU" ] && MONGO_CPU="0"

    MONGO_CONN=$(ss -tan 2>/dev/null | grep -c ':27017')

    echo "" >> $LOG
    echo "─── $TS (Tehran: $TZ_TS) ───" >> $LOG
    echo "CPU idle: ${IDLE}%  | node: ${NODE_COUNT}x (${NODE_CPU_TOTAL}%)  | python: ${PY_COUNT}x (${PY_CPU_TOTAL}%)  | mongod: ${MONGO_CPU}%" >> $LOG
    echo "Mongo conn: $MONGO_CONN" >> $LOG
    echo "TOP 5:" >> $LOG
    echo "$TOP5" >> $LOG

    if [ "$IDLE" != "?" ] && [ "$(echo "$IDLE < 30" | bc -l 2>/dev/null)" = "1" ]; then
        echo "[$TS] ⚠️ CPU high (idle=$IDLE%)" >> $ALERT_LOG
        echo "--- top 3 ---" >> $ALERT_LOG
        ps -eo pid,pcpu,cmd --sort=-pcpu | head -4 >> $ALERT_LOG
        echo "" >> $ALERT_LOG
    fi

    if [ $(wc -l < $LOG) -gt 20000 ]; then
        tail -10000 $LOG > $LOG.tmp && mv $LOG.tmp $LOG
    fi

    sleep 60
done
ENDS
chmod +x /tmp/cpu-hound.sh
nohup /tmp/cpu-hound.sh > /dev/null 2>&1 &
echo "✅ Running. PID: $!"
echo ""
echo "برای دیدن نتیجه فردا:"
echo "  tail -300 /tmp/cpu-hound-*.log"
echo "  cat /tmp/cpu-alerts.log"
```

---

# ۷️⃣ عملکرد روز بازار

**کاربرد:** خلاصه‌ی کامل روز — تیک‌ها، سیگنال‌ها، پوزیشن‌ها، منابع
**زمان:** ~۱۵ ثانیه
**کی بزن:** آخر روز یا شب

```bash
cat > /tmp/marketcheck.sh << 'ENDS'
#!/bin/bash
# ═══════════════════════════════════════════════════════════
# Market Day Performance Check
# ═══════════════════════════════════════════════════════════
cd ~/apps/OptionHunter
TOKEN=$(grep ADMIN_TOKEN ~/apps/OptionHunter/.env | cut -d= -f2 | tr -d '"' | tr -d "'")
TODAY=$(TZ='Asia/Tehran' date +%Y-%m-%d)

line() { printf '─%.0s' {1..70}; echo; }
title() { echo ""; line; echo "  $1"; line; }

MONGO_URI=$(grep MONGO_URI ~/apps/OptionHunter/.env | cut -d= -f2 | tr -d '"' | tr -d "'")

title "۱) وضعیت فعلی"
TZ='Asia/Tehran' date '+%Y-%m-%d %H:%M:%S (%A)'
echo ""
top -bn1 | head -5 | tail -3
echo ""
pm2 status

title "۲) Ticker امروز"
curl -s --max-time 10 "http://127.0.0.1:5000/status" | python3 -m json.tool 2>/dev/null | grep -A6 '"ticker"' || echo "no response"

title "۳) Day Stats"
sudo docker exec mongodb mongosh "$MONGO_URI" --quiet --eval "
const today = '$TODAY';
const doc = db.meta.findOne({_id: 'daystats_' + today});
if (!doc) { print('  ⚠️ no daystats'); }
else {
  print('  Ticks OK:   ' + (doc.ticksOk || 0));
  print('  Ticks Fail: ' + (doc.ticksFail || 0));
  print('  Signals:    ' + (doc.signals || 0));
}
" 2>/dev/null || echo "  (mongosh unavailable)"

title "۴) سیگنال‌های امروز"
sudo docker exec mongodb mongosh "$MONGO_URI" --quiet --eval "
const today = new Date('$TODAY');
const tom = new Date(today.getTime() + 86400000);
const sigs = db.signal_history.find({createdAt: {\$gte: today, \$lt: tom}}).toArray();
print('  کل: ' + sigs.length);
const rejected = sigs.filter(s => s.rejected).length;
print('  رد شده: ' + rejected);
" 2>/dev/null || echo "  (mongosh unavailable)"

title "۵) Monitor log امروز"
MARKET_LOG="$HOME/apps/OptionHunter/logs/market-${TODAY}.log"
if [ -f "$MARKET_LOG" ]; then
    echo "  فایل: $MARKET_LOG ($(wc -l < $MARKET_LOG) خط)"
    python3 << PYEOF
import re
with open("$MARKET_LOG") as f:
    lines = f.read().splitlines()
samples = []
for line in lines:
    m = re.search(r'CPU:(\d+)% Node:(\d+)M\(([\d.]+)%\).*?Coll:(\d+)M.*?Mongo:([\d.]+)%c(\d+).*?RAM:(\d+)/(\d+)/(\d+)M.*?swap:(\d+).*?restarts:(\d+)', line)
    if m:
        samples.append({'cpu':int(m.group(1)),'node_ram':int(m.group(2)),'node_cpu':float(m.group(3)),
                       'coll_ram':int(m.group(4)),'mongo_cpu':float(m.group(5)),'mongo_conn':int(m.group(6)),
                       'ram_used':int(m.group(7)),'ram_free':int(m.group(8)),'swap':int(m.group(10)),'rst':int(m.group(11))})
if samples:
    def stats(k):
        v = sorted(s[k] for s in samples)
        return (min(v), round(sum(v)/len(v),1), v[int(len(v)*0.95)], max(v))
    print(f"  {'شاخص':<15}{'min':>8}{'avg':>8}{'p95':>8}{'max':>8}")
    for k, l in [('cpu','CPU%'),('mongo_cpu','Mongo%'),('node_ram','NodeRAM'),('node_cpu','NodeCPU'),
                 ('coll_ram','CollRAM'),('ram_free','RAMfree'),('swap','Swap')]:
        mn, av, p95, mx = stats(k)
        print(f"  {l:<15}{mn:>8}{av:>8}{p95:>8}{mx:>8}")
    print(f"  Restart delta: {samples[0]['rst']} → {samples[-1]['rst']}")
    print(f"  نمونه‌ها: {len(samples)}")
else:
    print('  ⚠️ نمونه‌ای parse نشد')
PYEOF
else
    echo "  ⚠️ market log نیست: $MARKET_LOG"
fi

title "۶) خطاهای اخیر"
echo "─── Backend ───"
tail -10 ~/apps/OptionHunter/logs/error.log 2>/dev/null | tail -5 || echo "  (empty)"
echo ""
echo "─── Collector ───"
sudo tail -20 /var/log/collector.log 2>/dev/null | grep -iE "error|fail|exception" | tail -5 || echo "  (empty)"

title "۷) MongoDB summary"
sudo docker exec mongodb mongosh "$MONGO_URI" --quiet --eval "
const today = new Date('$TODAY');
const tom = new Date(today.getTime() + 86400000);
print('  کندل 1m امروز:  ' + db.candles_base.countDocuments({time: {\$gte: today, \$lt: tom}}));
print('  تیک امروز:      ' + db.stock_ticks.countDocuments({time: {\$gte: today, \$lt: tom}}));
print('  snapshot امروز: ' + db.option_snapshots.countDocuments({timestamp: {\$gte: today, \$lt: tom}}));
" 2>/dev/null || echo "  (mongosh unavailable)"

line
echo "✅ Done"
ENDS
chmod +x /tmp/marketcheck.sh
/tmp/marketcheck.sh 2>&1 | tee /tmp/marketcheck-$(TZ='Asia/Tehran' date +%Y%m%d).txt
```

---

# ۸️⃣ تست فرمت تاریخ AlgoTik

**کاربرد:** بررسی اینکه `algotik_tse` کدوم فرمت رو قبول می‌کنه
**زمان:** ~۳۰ ثانیه
**کی بزن:** وقتی خطای تاریخ می‌گیری

```bash
cat > /tmp/test-algotik.sh << 'ENDS'
#!/bin/bash
cd ~/apps/OptionHunter
PY=/opt/collector/venv/bin/python

$PY << 'EOF'
import sys, traceback
print("═══ ۱) نسخه ═══")
import algotik_tse as att
print(f"  algotik_tse: {getattr(att, '__version__', 'unknown')}")

print("\n═══ ۲) تست فرمت‌های intraday ═══")
SYMBOL = 'فملی'
tests = [
    ("slash jalali",    "1405/04/09", "1405/07/08"),
    ("dash jalali",     "1405-04-09", "1405-07-08"),
    ("gregorian slash", "2026/06/09", "2026/09/29"),
    ("gregorian dash",  "2026-06-09", "2026-09-29"),
]
for name, s, e in tests:
    print(f"\n─── {name}: {s} → {e} ───")
    try:
        df = att.get_intraday(SYMBOL, interval='1min', start=s, end=e, progress=False)
        if df is None or len(df) == 0:
            print(f"  ⚠️ empty")
        else:
            print(f"  ✅ OK: {len(df)} rows | {df.index[0]} → {df.index[-1]}")
    except Exception as ex:
        print(f"  ❌ {type(ex).__name__}: {ex}")

print("\n═══ ۳) تست daily ═══")
for name, s, e in tests:
    print(f"\n─── {name} ───")
    try:
        df = att.get_history(SYMBOL, start=s, end=e, progress=False)
        if df is None or len(df) == 0:
            print(f"  ⚠️ empty")
        else:
            print(f"  ✅ OK: {len(df)} rows")
    except Exception as ex:
        print(f"  ❌ {type(ex).__name__}: {ex}")

print("\n═══ DONE ═══")
EOF
ENDS
chmod +x /tmp/test-algotik.sh
/tmp/test-algotik.sh
```

---

# ۹️⃣ مانیتور PM2 دائمی

**کاربرد:** این داخل خود پروژه‌ست و هر ۳۰s/۱۲۰s snapshot می‌گیره
**کی بزن:** همیشه روشن (از قبل تنظیم شده)

```bash
# چک کردن وضعیت
pm2 status OHMonitor

# دیدن لاگ‌ها
tail -20 ~/apps/OptionHunter/logs/monitor.log

# ری‌استارت (اگر لازم شد)
pm2 restart OHMonitor

# دیدن روزها
cat ~/apps/OptionHunter/logs/market-$(TZ='Asia/Tehran' date +%Y-%m-%d).log | tail -50
```

---

# 🎯 راهنمای سریع

| مشکل | تستی که باید بزنی |
|------|-------------------|
| سرور کنده | ۱، ۲ |
| بک‌تست طولانی | ۴، ۵ |
| خطای تاریخ | ۸ |
| CPU بالا | ۶، ۹ |
| بعد از deploy | ۱ |
| شب‌ها | ۷ |

## 💾 محل ذخیره‌ی نتایج

| فایل | محتوا |
|------|-------|
| `/tmp/ohtest-*.txt` | نتیجه‌ی تست جامع |
| `/tmp/btcheck-*.log` | لاگ رصد بک‌تست |
| `/tmp/cpu-hound-*.log` | لاگ ۲۴ ساعته CPU |
| `/tmp/cpu-alerts.log` | هشدارهای CPU |
| `/tmp/marketcheck-*.txt` | خلاصه‌ی روز |
| `~/apps/OptionHunter/logs/monitor.log` | مانیتور دائمی |
| `~/apps/OptionHunter/logs/market-*.log` | رصد ساعات بازار |

## 📌 alias برای deploy سریع

```bash
cat >> ~/.bashrc << 'EOF'

# OptionHunter aliases
deploy-collector() {
    sudo rm -rf /opt/collector/__pycache__ /opt/collector/pipeline/__pycache__
    sudo cp ~/apps/OptionHunter/collector/service.py /opt/collector/service.py
    sudo cp -rf ~/apps/OptionHunter/collector/pipeline/* /opt/collector/pipeline/
    sudo systemctl restart collector
    sleep 2
    systemctl is-active --quiet collector && echo "✅ Collector deployed" || echo "❌ Failed"
}
EOF
source ~/.bashrc
```

**بعدش فقط `deploy-collector` بزن.**