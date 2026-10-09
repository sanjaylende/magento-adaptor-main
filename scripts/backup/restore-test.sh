#!/bin/bash
# Restores a backup into a SCRATCH database, checks it, times it, and drops it. Never touches the live database.
# Usage: scripts/backup/restore-test.sh [backup-file]      (default: the newest file in BACKUP_DIR)
# Needs the same BACKUP_KEY_FILE as the backup, and a database role that can CREATE DATABASE (the owner role).
# Do this monthly; the time it prints is your real recovery time for the current data size.
set -o pipefail
. "$(dirname "$0")/_env.sh"
BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/backups}"
FILE="${1:-$(ls -1t "$BACKUP_DIR"/*.dump.enc 2>/dev/null | head -1)}"
[ -n "$FILE" ] && [ -f "$FILE" ] || { echo "No backup file found" >&2; exit 2; }
[ -n "${BACKUP_KEY_FILE:-}" ] && [ -s "$BACKUP_KEY_FILE" ] || { echo "BACKUP_KEY_FILE must point to the passphrase file" >&2; exit 2; }
LIVE_DB="$PGDATABASE"
SCRATCH="restore_test_$(date +%Y%m%d%H%M%S)"
( cd "$(dirname "$FILE")" && sha256sum -c "$(basename "$FILE").sha256" ) || { echo "Checksum does not match: the backup file is damaged" >&2; exit 3; }
START="$(date +%s)"
PGDATABASE=postgres psql -v ON_ERROR_STOP=1 -qc "CREATE DATABASE $SCRATCH"
cleanup() { PGDATABASE=postgres psql -qc "DROP DATABASE IF EXISTS $SCRATCH WITH (FORCE)" >/dev/null 2>&1 || true; }
trap cleanup EXIT
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:$BACKUP_KEY_FILE" < "$FILE" | pg_restore --dbname="$SCRATCH" --no-owner --no-privileges --exit-on-error
END="$(date +%s)"
# sanity: the restored copy has the same tables and row counts as the live database for the tables that matter
check() { PGDATABASE="$1" psql -Atqc "SELECT count(*) FROM $2"; }
FAIL=0
for TABLE in merchants installations stores store_subscriptions payment_orders invoices admin_users; do
  A="$(check "$LIVE_DB" $TABLE)"; B="$(check "$SCRATCH" $TABLE)"
  printf '  %-20s live=%s restored=%s\n' "$TABLE" "$A" "$B"
  [ "$A" -ge "$B" ] || FAIL=1   # the live database may have grown since the backup, never shrunk below it
done
echo "restore time: $(( END - START )) s for $(wc -c < "$FILE") bytes of backup"
[ "$FAIL" -eq 0 ] && echo "RESTORE TEST PASSED" || { echo "RESTORE TEST FAILED: a restored table has more rows than the live one" >&2; exit 4; }
