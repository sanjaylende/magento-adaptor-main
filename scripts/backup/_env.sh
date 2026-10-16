# Shared by backup-db.sh and restore-test.sh: turns DATABASE_ADMIN_URL (from the environment or .env) into libpq variables, so the
# password is passed in the environment of the tool and never on its command line.
set -eu
APP_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
if [ -z "${DATABASE_ADMIN_URL:-}" ] && [ -f "$APP_DIR/.env" ]; then
  DATABASE_ADMIN_URL="$(grep -E '^DATABASE_ADMIN_URL=' "$APP_DIR/.env" | head -1 | cut -d= -f2- || true)"
fi
DATABASE_ADMIN_URL="${DATABASE_ADMIN_URL:-postgresql://magento_adapter_owner:magento_adapter_owner_local@127.0.0.1:5432/ltx_1jnl}"
# The adapter's data is its own schema inside a database shared with other applications: only that schema is dumped.
if [ -z "${DB_SCHEMA:-}" ] && [ -f "$APP_DIR/.env" ]; then
  DB_SCHEMA="$(grep -E '^DB_SCHEMA=' "$APP_DIR/.env" | head -1 | cut -d= -f2- || true)"
fi
DB_SCHEMA="${DB_SCHEMA:-magento_adapter}"
if [ "$DB_SCHEMA" = "public" ]; then PG_SCHEMA_ARGS=""
# The owner role has no BYPASSRLS and row-level security is forced on the tenant tables, so a plain dump is refused. The backup session asks for
# the same "see every tenant" setting as the staff console (app.bypass), and pg_dump evaluates the policies instead of refusing.
else PG_SCHEMA_ARGS="--schema=$DB_SCHEMA --enable-row-security"; export PGOPTIONS="-c search_path=$DB_SCHEMA -c app.bypass=on"; fi
eval "$(node -e '
  const u = new URL(process.argv[1]);
  const q = (s) => "\x27" + String(s).replace(/\x27/g, "\x27\\x27\x27") + "\x27";
  console.log("export PGHOST=" + q(u.hostname) + " PGPORT=" + q(u.port || 5432) + " PGUSER=" + q(decodeURIComponent(u.username)) + " PGPASSWORD=" + q(decodeURIComponent(u.password)) + " PGDATABASE=" + q(u.pathname.slice(1)));
' "$DATABASE_ADMIN_URL")"
[ "${DB_SSL:-}" = "require" ] && export PGSSLMODE=verify-full || true
