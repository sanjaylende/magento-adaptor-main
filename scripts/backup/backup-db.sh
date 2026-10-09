#!/bin/bash
# Encrypted PostgreSQL backup with retention.
#   BACKUP_DIR            where backups go                         (default ./backups, mode 700)
#   BACKUP_KEY_FILE       file holding the encryption passphrase   (REQUIRED; keep it OFF this server too: store a copy in your password manager)
#   BACKUP_RETENTION_DAYS delete backups older than this           (default 14)
#   BACKUP_UPLOAD_CMD     optional command run with the new file as $1 (e.g. "aws s3 cp" to a bucket in ANOTHER account)
# Output: <dbname>-YYYYmmdd-HHMMSS.dump.enc (AES-256, PBKDF2) and a .sha256 next to it.
# Run daily from cron:  15 2 * * *  /opt/flipick-adapter/app/scripts/backup/backup-db.sh >> /var/log/flipick-adapter/backup.log 2>&1
set -o pipefail
. "$(dirname "$0")/_env.sh"
BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/backups}"
RETENTION="${BACKUP_RETENTION_DAYS:-14}"
[ -n "${BACKUP_KEY_FILE:-}" ] && [ -s "$BACKUP_KEY_FILE" ] || { echo "BACKUP_KEY_FILE must point to a non-empty passphrase file" >&2; exit 2; }
umask 077
mkdir -p "$BACKUP_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$BACKUP_DIR/$PGDATABASE-$STAMP.dump.enc"
START="$(date +%s)"
# custom format (compressed, restorable table by table); the dump goes straight into openssl, no plain file touches the disk
trap 'rm -f "$OUT.partial"' EXIT   # a failed run leaves nothing half-written behind
pg_dump --format=custom --compress=6 --no-owner --no-privileges | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass "file:$BACKUP_KEY_FILE" > "$OUT.partial"
mv "$OUT.partial" "$OUT"
( cd "$BACKUP_DIR" && sha256sum "$(basename "$OUT")" > "$(basename "$OUT").sha256" )
echo "$(date -u +%FT%TZ) backup ok: $OUT ($(wc -c < "$OUT") bytes, $(( $(date +%s) - START )) s)"
if [ -n "${BACKUP_UPLOAD_CMD:-}" ]; then $BACKUP_UPLOAD_CMD "$OUT" && echo "uploaded"; fi
# retention
find "$BACKUP_DIR" -name "$PGDATABASE-*.dump.enc*" -type f -mtime +"$RETENTION" -print -delete | sed 's/^/removed old backup: /'
