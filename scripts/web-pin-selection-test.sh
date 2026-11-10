#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
"$ROOT/scripts/with-env.sh" node_modules/typescript/bin/tsc web/src/WaitingPinSelection.ts --outDir .local/web-pin-selection-test --target ES2022 --module ES2022 --moduleResolution Bundler --skipLibCheck --strict
exec "$ROOT/scripts/with-env.sh" node --test web/tests/pin-selection.test.mjs
