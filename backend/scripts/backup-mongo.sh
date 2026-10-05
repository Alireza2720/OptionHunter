#!/bin/bash
# MongoDB backup — run daily via cron or pm2
set -e

BACKUP_DIR="${BACKUP_DIR:-/var/backups/optionhunter}"
KEEP_DAYS="${KEEP_DAYS:-7}"
DATE=$(date +%Y%m%d-%H%M%S)

mkdir -p "$BACKUP_DIR"

# Read MONGO_URI from .env
cd ~/apps/OptionHunter 2>/dev/null || cd /home/deploy/apps/OptionHunter
if [ -f .env ]; then
    MONGO_URI=$(grep '^MONGO_URI=' .env | cut -d= -f2- | tr -d '"' | tr -d "'")
fi

if [ -z "$MONGO_URI" ]; then
    echo "ERROR: MONGO_URI not found"
    exit 1
fi

OUT="$BACKUP_DIR/mongo-$DATE"
echo "Backing up to: $OUT"

if command -v mongodump >/dev/null 2>&1; then
    mongodump --uri="$MONGO_URI" --out="$OUT" --gzip
    echo "Backup done: $OUT"
else
    # Fallback: use docker exec if mongo runs in docker
    docker exec mongodb mongodump --uri="$MONGO_URI" --archive --gzip > "$OUT.archive.gz" 2>/dev/null || {
        echo "ERROR: neither mongodump nor docker mongodb available"
        exit 1
    }
    echo "Backup (docker) done: $OUT.archive.gz"
fi

# Cleanup old backups
find "$BACKUP_DIR" -maxdepth 1 -mtime +$KEEP_DAYS -exec rm -rf {} + 2>/dev/null || true
echo "Cleaned backups older than $KEEP_DAYS days"
