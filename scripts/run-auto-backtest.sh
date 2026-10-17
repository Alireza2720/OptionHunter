#!/bin/bash
cd /home/deploy/apps/OptionHunter || exit 1
exec /bin/bash -lc 'exec node scripts/auto-backtest.js "$@"' _ "$@"