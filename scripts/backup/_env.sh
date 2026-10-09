# Shared by backup-db.sh and restore-test.sh: turns DATABASE_ADMIN_URL (from the environment or .env) into libpq variables, so the
# password is passed in the environment of the tool and never on its command line.
set -eu
APP_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
if [ -z "${DATABASE_ADMIN_URL:-}" ] && [ -f "$APP_DIR/.env" ]; then
  DATABASE_ADMIN_URL="$(grep -E '^DATABASE_ADMIN_URL=' "$APP_DIR/.env" | head -1 | cut -d= -f2- || true)"
fi
DATABASE_ADMIN_URL="${DATABASE_ADMIN_URL:-postgresql://adapter_owner:adapter_owner_local@127.0.0.1:5434/magento_adapter}"
eval "$(node -e '
  const u = new URL(process.argv[1]);
  const q = (s) => "\x27" + String(s).replace(/\x27/g, "\x27\\x27\x27") + "\x27";
  console.log("export PGHOST=" + q(u.hostname) + " PGPORT=" + q(u.port || 5432) + " PGUSER=" + q(decodeURIComponent(u.username)) + " PGPASSWORD=" + q(decodeURIComponent(u.password)) + " PGDATABASE=" + q(u.pathname.slice(1)));
' "$DATABASE_ADMIN_URL")"
[ "${DB_SSL:-}" = "require" ] && export PGSSLMODE=verify-full || true
