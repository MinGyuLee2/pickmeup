#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PICKMEUP_PG_BIN:-/opt/homebrew/opt/postgresql@14/bin}"
STATE="$ROOT/.local"
CACHE_KEY="$(bash "$ROOT/scripts/cache-key.sh")"
RUNTIME="$HOME/.cache/pickmeup"
DATA="${PICKMEUP_PG_DATA:-$RUNTIME/postgres-$CACHE_KEY}"
mkdir -p "$STATE" "$RUNTIME"
case "${1:-status}" in
  start)
    if [[ ! -f "$DATA/PG_VERSION" ]]; then
      if [[ -f "$STATE/db-password" || -f "$ROOT/.env" ]]; then
        echo 'Existing project settings found but its PostgreSQL cluster is missing. Restore the runtime cache key or set PICKMEUP_PG_DATA; refusing to replace credentials.' >&2
        exit 1
      fi
      if [[ -f "$STATE/postgres/PG_VERSION" ]]; then
        echo 'A legacy DB exists under .local/postgres. Stop and copy it into the local cache before starting; do not overwrite its credentials.' >&2
        exit 1
      fi
      umask 077
      "$ROOT/scripts/with-env.sh" node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))' > "$STATE/db-password"
      "$PG_BIN/initdb" -D "$DATA" --username=pickmeup --auth=scram-sha-256 --pwfile="$STATE/db-password" --encoding=UTF8 --locale=C >/dev/null
      cat >> "$DATA/postgresql.conf" <<EOF
listen_addresses = '127.0.0.1'
port = 55432
unix_socket_directories = '$RUNTIME'
EOF
    fi
    if ! "$PG_BIN/pg_ctl" -D "$DATA" status >/dev/null 2>&1; then
      "$PG_BIN/pg_ctl" -D "$DATA" -l "$RUNTIME/postgres-$CACHE_KEY.log" start
    fi
    export PGPASSWORD="$(cat "$STATE/db-password")"
    if ! "$PG_BIN/psql" -h 127.0.0.1 -p 55432 -U pickmeup -d postgres -Atc "SELECT 1 FROM pg_database WHERE datname='pickmeup'" | /usr/bin/grep -q 1; then
      "$PG_BIN/createdb" -h 127.0.0.1 -p 55432 -U pickmeup pickmeup
    fi
    if [[ ! -f "$ROOT/.env" ]]; then
      umask 077
      APP_KEY="$("$ROOT/scripts/with-env.sh" node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64"))')"
      printf 'HOST=127.0.0.1\nPORT=4310\nDATABASE_URL=postgresql://pickmeup:%s@127.0.0.1:55432/pickmeup\nNODE_ENV=development\nPUBLIC_ORIGIN=http://localhost:5173\nSMS_MODE=local\nAPP_SECRET=%s\n' "$PGPASSWORD" "$APP_KEY" > "$ROOT/.env"
    fi
    echo "픽미업 개발 DB: 127.0.0.1:55432/pickmeup"
    ;;
  stop) "$PG_BIN/pg_ctl" -D "$DATA" stop ;;
  status) "$PG_BIN/pg_ctl" -D "$DATA" status ;;
  *) echo "Usage: $0 {start|stop|status}"; exit 1 ;;
esac
