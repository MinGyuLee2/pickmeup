#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
case "${1:-}" in
  api) exec "$ROOT/scripts/with-env.sh" npm run dev:api ;;
  web) exec "$ROOT/scripts/with-env.sh" npm run dev:web ;;
  worker) exec "$ROOT/scripts/with-env.sh" npm run dev:worker ;;
  *) echo "Usage: $0 {api|web|worker}"; exit 1 ;;
esac
