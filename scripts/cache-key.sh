#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE="$ROOT/.local"
mkdir -p "$STATE"
# Keep the original runtime identity when the checkout moves. In particular,
# a new absolute path must not select an empty PostgreSQL cluster.
KEY_FILE="$STATE/runtime-cache-key"
if [[ ! -f "$KEY_FILE" ]]; then
  KEY="$("$ROOT/scripts/with-env.sh" node -e 'process.stdout.write(require("node:crypto").createHash("sha256").update(process.argv[1].normalize("NFC")).digest("hex").slice(0,12))' "$ROOT")"
  (umask 077; printf '%s\n' "$KEY" > "$KEY_FILE")
fi
KEY="$(cat "$KEY_FILE")"
if [[ ! "$KEY" =~ ^[a-f0-9]{12}$ ]]; then
  echo 'Invalid .local/runtime-cache-key; preserve the existing runtime identity.' >&2
  exit 1
fi
printf '%s\n' "$KEY"
