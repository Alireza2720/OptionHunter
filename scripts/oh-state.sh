#!/bin/bash
# scripts/oh-state.sh — compact system state for AI (one command)
cd /home/deploy/apps/OptionHunter || { echo "ERR:cd"; exit 1; }
echo "T=$(date -u +%H:%M)UTC"
echo "GIT=$(git log --oneline -1 | cut -c1-45)"
PM2LINE=$(pm2 jlist 2>/dev/null | python3 -c "import sys,json;d=json.load(sys.stdin);print('|'.join(f'{x[\"name\"]}:{x[\"pm2_env\"][\"status\"]}' for x in d))" 2>/dev/null)
echo "PM2=$PM2LINE"
COL=$(curl -s -m 3 http://127.0.0.1:5000/chain/enriched/status 2>/dev/null | head -c 120)
echo "COL=$COL"
PING=$(curl -s -m 3 http://127.0.0.1:3000/ping 2>/dev/null | head -c 80)
echo "PING=$PING"
[ -f scripts/oh-state-js.js ] && node scripts/oh-state-js.js 2>&1 | head -10
STALE=$(grep -c 'stale signal skipped' backend/core/signals.js 2>/dev/null || echo 0)
B8=$(grep -c 'Auto-trigger results compute' backend/services/backtest.service.js 2>/dev/null || echo 0)
B9=$(grep -c 'compute_enriched_chain(force=False)' /opt/collector/pipeline/option_greeks.py 2>/dev/null || echo 0)
PMD=$(grep -c 'pmd' /opt/collector/pipeline/tsetmc_client.py 2>/dev/null || echo 0)
echo "MARKERS=stale:$STALE,b8:$B8,b9:$B9,pmd:$PMD"
echo "END"