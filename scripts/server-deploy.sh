#!/bin/bash
# server-deploy.sh — pull + restart + verify
cd ~/apps/OptionHunter || { echo "FAIL: not in OptionHunter"; exit 1; }

echo "=== [1/6] git pull ==="
git fetch origin main
git reset --hard origin/main

echo "=== [2/6] Python syntax check ==="
FAIL=0
for f in collector/option_reconstruction/*.py collector/scripts/enrich_options.py; do
    if [ -f "$f" ]; then
        python3 -m py_compile "$f" 2>/dev/null || { echo "  FAIL: $f"; FAIL=1; }
    fi
done
if [ "$FAIL" = "1" ]; then
    echo "ABORT: syntax errors"
    exit 1
fi
echo "  OK"

echo "=== [3/6] Sync collector ==="
sudo mkdir -p /opt/collector/option_reconstruction
sudo cp -r collector/option_reconstruction/* /opt/collector/option_reconstruction/
sudo cp collector/scripts/enrich_options.py /opt/collector/scripts/
echo "  OK"

echo "=== [4/6] Restart backend (PM2) ==="
pm2 restart OptionHunter
echo "  OK"

echo "=== [5/6] Restart collector ==="
sudo systemctl restart collector
sleep 6
if systemctl is-active --quiet collector; then
    echo "  OK"
else
    echo "  FAIL: collector"
    sudo journalctl -u collector -n 30 --no-pager
    exit 1
fi

echo "=== [6/6] Health check ==="
curl -s --max-time 5 http://127.0.0.1:5000/health || echo 'health unavailable'
echo ""
curl -s --max-time 5 http://127.0.0.1:3000/ping || echo 'ping unavailable'
echo ""
echo "=== DONE ==="

