#!/bin/sh
set -e

# XRK-AGT Linux/macOS 启动（先确保本机 Redis 可连，再经 app.js 引导）
ROOT=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
ENSURE="$ROOT/scripts/ensure-redis.mjs"
if [ ! -f "$ENSURE" ]; then
  echo "[XRK-AGT] missing scripts/ensure-redis.mjs" >&2
  exit 1
fi
node "$ENSURE"
exec node --experimental-strip-types --no-warnings --no-deprecation app.js "$@"
