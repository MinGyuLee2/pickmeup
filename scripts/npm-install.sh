#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# macOS File Provider-backed Documents can stall synchronous module reads.
# Keep reproducible dependencies in a local cache and link only node_modules.
CACHE_KEY="$(bash "$ROOT/scripts/cache-key.sh")"
CACHE="$HOME/.cache/pickmeup/npm-$CACHE_KEY"
mkdir -p "$CACHE/api" "$CACHE/web"
cp "$ROOT/package.json" "$ROOT/package-lock.json" "$CACHE/"
cp "$ROOT/api/package.json" "$CACHE/api/package.json"
cp "$ROOT/web/package.json" "$CACHE/web/package.json"
"$ROOT/scripts/with-env.sh" npm ci --prefix "$CACHE"
ln -sfn "$ROOT/api" "$CACHE/node_modules/@pickmeup/api"
ln -sfn "$ROOT/web" "$CACHE/node_modules/@pickmeup/web"
if [ -d "$ROOT/node_modules" ] && [ ! -L "$ROOT/node_modules" ]; then
  echo 'Existing node_modules is a directory. Move it under .local before using this cache installer.' >&2
  exit 1
fi
ln -sfn "$CACHE/node_modules" "$ROOT/node_modules"
echo 'Dependencies installed in local cache; workspace node_modules linked.'
