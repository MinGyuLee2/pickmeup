#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
"$ROOT/scripts/with-env.sh" node_modules/typescript/bin/tsc web/src/api.ts web/src/WaitingPointState.ts --outDir .local/web-api-test --target ES2022 --module ES2022 --moduleResolution Bundler --skipLibCheck --strict
exec "$ROOT/scripts/with-env.sh" node --test web/tests/api.test.mjs web/tests/waiting-point-state.test.mjs
