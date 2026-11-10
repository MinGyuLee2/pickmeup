#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec "$ROOT/scripts/with-env.sh" emulator -avd PickMeUp_Pleos_2_1 -no-snapshot -memory 4096 "$@"
