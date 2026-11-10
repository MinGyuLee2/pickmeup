#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
case "${1:-check}" in
  check)
    exec "$ROOT/scripts/with-env.sh" node --env-file=.env --env-file=.local/solapi.env --env-file=.local/public-demo.env scripts/solapi-check.mjs
    ;;
  api)
    exec "$ROOT/scripts/with-env.sh" node --env-file=.env --env-file=.local/solapi.env --env-file=.local/public-demo.env --env-file-if-exists=.local/web-push.env --env-file-if-exists=.local/kakao-route.env api/dist/index.js
    ;;
  worker)
    exec "$ROOT/scripts/with-env.sh" node --env-file=.env --env-file=.local/solapi.env --env-file=.local/public-demo.env api/dist/worker.js
    ;;
  push)
    exec "$ROOT/scripts/with-env.sh" node --env-file=.env --env-file=.local/public-demo.env --env-file=.local/web-push.env api/dist/push-runner.js
    ;;
  web)
    exec "$ROOT/scripts/with-env.sh" node --env-file=.local/public-demo.env node_modules/vite/bin/vite.js preview web --config web/vite.config.ts
    ;;
  tunnel)
    exec "$ROOT/scripts/with-env.sh" node --env-file=.local/ngrok.env scripts/ngrok-demo.mjs
    ;;
  *) echo "Usage: $0 {check|api|worker|push|web|tunnel}";exit 1 ;;
esac
