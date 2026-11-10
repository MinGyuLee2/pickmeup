#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
"$ROOT/scripts/with-env.sh" java -version
"$ROOT/scripts/with-env.sh" node --version
"$ROOT/scripts/with-env.sh" adb version
"$ROOT/scripts/with-env.sh" emulator -accel-check
"$ROOT/scripts/with-env.sh" emulator -list-avds
"$ROOT/scripts/db.sh" status
curl --fail --silent --show-error --max-time 5 http://127.0.0.1:4310/health
echo
