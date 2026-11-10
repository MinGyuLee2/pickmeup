#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ "$#" -ne 1 ]; then
  echo "Usage: $0 https://YOUR_PUBLIC_HOST/api"
  echo "Set signing and approved Gleo caller environment variables first; see docs/DEPLOYMENT.md."
  exit 1
fi
: "${PICKMEUP_GLEO_CALLER_PACKAGE:?Set the approved Gleo caller package}"
: "${PICKMEUP_GLEO_CALLER_SHA256:?Set the approved Gleo caller fingerprint}"
cd "$ROOT/android"
"$ROOT/scripts/with-env.sh" ./gradlew verifyReleaseConfiguration stageReleaseApk lintRelease \
  "-PpickmeupApiBaseUrl=$1" \
  "-PpickmeupGleoCallerPackage=$PICKMEUP_GLEO_CALLER_PACKAGE" \
  "-PpickmeupGleoCallerSha256=$PICKMEUP_GLEO_CALLER_SHA256"

APK="$ROOT/android/app/build/outputs/apk/release/app-release.apk"
"$ROOT/scripts/with-env.sh" bash -c 'exec "$ANDROID_HOME/build-tools/35.0.0/apksigner" verify --verbose "$1"' bash "$APK"
echo "Signed release APK: $APK"
