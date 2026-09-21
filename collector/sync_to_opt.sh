#!/bin/bash
# Sync collector files from repo to /opt/collector
set -e
SRC="/home/deploy/apps/OptionHunter/collector"
DST="/opt/collector"

echo "syncing $SRC → $DST"
sudo mkdir -p "$DST/pipeline"
sudo cp "$SRC/service.py" "$DST/service.py"
sudo cp "$SRC/requirements.txt" "$DST/requirements.txt"
sudo cp -f "$SRC/wipe_data.py" "$DST/wipe_data.py" 2>/dev/null || true
sudo cp -f "$SRC/wipe_keep_recent.py" "$DST/wipe_keep_recent.py" 2>/dev/null || true
sudo cp -rf "$SRC/pipeline/"* "$DST/pipeline/"
echo "✅ synced"
