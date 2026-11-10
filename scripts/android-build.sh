#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/android"
exec "$ROOT/scripts/with-env.sh" ./gradlew assembleDebug "$@"
