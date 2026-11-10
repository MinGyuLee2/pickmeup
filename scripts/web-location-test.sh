#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
"$ROOT/scripts/with-env.sh" node_modules/typescript/bin/tsc web/src/RecipientLocationSession.ts --outDir .local/web-location-test --target ES2022 --module ES2022 --moduleResolution Bundler --skipLibCheck --strict
exec "$ROOT/scripts/with-env.sh" node --test web/tests/recipient-location-session.test.mjs
