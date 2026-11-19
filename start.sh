#!/usr/bin/env bash
# Build the dashboard (first run only) and start the DWAPAR observatory.
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -d dashboard/dist ]; then
  (cd dashboard && npm install --no-audit --no-fund && npm run build)
fi
cd engine
exec python3 -m dwapar serve "$@"
