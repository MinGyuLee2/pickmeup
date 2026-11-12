#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
exec "$ROOT/scripts/with-env.sh" node --env-file=.env --env-file-if-exists=.local/public-demo.env --env-file-if-exists=.local/filming-demo/sms.env scripts/filming-demo.mjs "${@:-status}"
