#!/bin/bash
# migrate-to-tsetmc.sh — runs ON the server after git pull.
set -e

cd ~/apps/OptionHunter || { echo "❌ Not in OptionHunter"; exit 1; }

echo "════════════════════════════════════════════════════════════"
echo "  OptionHunter → TSETMC Server Migration"
echo "════════════════════════════════════════════════════════════"

# 1) Pull
echo "[1/8] Pulling latest..."
git fetch origin main
git reset --hard origin/main

# 2) DB backup
echo "[2/8] Backing up MongoDB..."
BACKUP_DIR="/var/backups/optionhunter"
mkdir -p "$BACKUP_DIR"
MONGO_URI=$(grep '^MONGO_URI=' .env | cut -d= -f2- | tr -d '"')
if command -v mongodump >/dev/null 2>&1; then
    mongodump --uri="$MONGO_URI" --out="$BACKUP_DIR/pre-tsetmc-$(date +%Y%m%d-%H%M%S)" --gzip
    echo "  ✅ DB backup done"
else
    echo "  ⚠️  mongodump missing — skipping DB backup"
fi

# 3) Python syntax check
echo "[3/8] Python syntax check..."
FAIL=0
for f in collector/pipeline/*.py collector/service.py collector/scripts/*.py; do
    if [ -f "$f" ]; then
        if ! python3 -m py_compile "$f"; then
            echo "  ❌ syntax error: $f"
            FAIL=1
        fi
    fi
done
if [ "$FAIL" = "1" ]; then
    echo "  🛑 Aborting — fix syntax errors first"
    exit 1
fi
echo "  ✅ All Python files valid"

# 4) Install deps
echo "[4/8] Installing deps..."
if [ -f /opt/collector/venv/bin/pip ]; then
    /opt/collector/venv/bin/pip install -q jdatetime 2>/dev/null || true
    echo "  ✅ venv updated"
fi

# 5) Sync collector
echo "[5/8] Syncing collector to /opt/collector..."
sudo mkdir -p /opt/collector/pipeline /opt/collector/scripts
sudo cp collector/pipeline/*.py /opt/collector/pipeline/
sudo cp collector/service.py /opt/collector/
sudo cp collector/scripts/*.py /opt/collector/scripts/ 2>/dev/null || true
echo "  ✅ Synced"

# 6) Patch service.py (rename old calls)
echo "[6/8] Patching service.py..."
sudo cp /opt/collector/service.py /opt/collector/service.py.bak-$(date +%s)
sudo sed -i 's/migrate_from_daily_algotik/migrate_from_tsetmc/g' /opt/collector/service.py
echo "  ✅ Patched"

# 7) Restart collector
echo "[7/8] Restarting collector..."
sudo systemctl restart collector
sleep 6
if systemctl is-active --quiet collector; then
    echo "  ✅ collector is active"
    curl -s http://127.0.0.1:5000/health | head -c 300 || true
    echo ""
else
    echo "  ❌ collector FAILED to start!"
    sudo journalctl -u collector -n 40 --no-pager
    exit 1
fi

# 8) Backfill (optional)
if [ "$1" = "--backfill" ]; then
    echo "[8/8] Starting backfill in background..."
    cd /opt/collector
    nohup /opt/collector/venv/bin/python scripts/backfill_tsetmc.py --full \
        > /tmp/backfill.log 2>&1 &
    echo "  ✅ Backfill started — PID $!"
    echo "  Monitor: tail -f /tmp/backfill.log"
else
    echo "[8/8] Skipping backfill (pass --backfill to run)"
fi

echo ""
echo "════════════════════════════════════════════════════════════"
echo "  ✅ Migration complete"
echo "════════════════════════════════════════════════════════════"
