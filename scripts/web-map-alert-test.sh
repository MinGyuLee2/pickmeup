#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
"$ROOT/scripts/with-env.sh" node_modules/typescript/bin/tsc web/src/MapViewport.ts web/src/ArrivalNotice.ts web/src/ForegroundArrival.ts web/src/PlannedRouteLine.ts --outDir .local/web-map-alert-test --target ES2022 --module ES2022 --moduleResolution Bundler --skipLibCheck --strict
exec "$ROOT/scripts/with-env.sh" node --test web/tests/map-arrival.test.mjs web/tests/arrival-worker.test.mjs web/tests/foreground-arrival.test.mjs web/tests/planned-route.test.mjs web/tests/vehicle-viewport.test.mjs
