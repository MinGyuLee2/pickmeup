#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
"$ROOT/scripts/android-build.sh" "$@"
"$ROOT/scripts/with-env.sh" adb -e install -r "$ROOT/android/app/build/outputs/apk/debug/app-debug.apk"
exec "$ROOT/scripts/with-env.sh" adb -e shell am start -n io.pickmeup.automotive/.MainActivity
