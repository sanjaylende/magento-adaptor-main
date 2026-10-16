// Migration runner: applies migrations/*.sql in name order, once each, recorded in schema_migrations with a checksum
// (a changed, already-applied file is an error: write a new migration instead). Then syncs the EAV attribute
// definitions declared by the models into eav_entity_type / eav_attribute (idempotent).
//
// Everything lives in the adapter's own schema (config.database.schema, default "magento_adapter"), which is the search_path of the
// connection, so the migration files stay plain unqualified SQL. The migration history (schema_migrations) is in that schema too. Two
// rewrites are applied to the SQL text before it runs (the checksum is always of the file as written, so old and new installs agree):
//   * "IN SCHEMA public"  ->  the adapter schema (the files were written when the adapter had a database of its own)
//   * the role name "adapter_app"  ->  the role the service connects as (DATABASE_URL's user)
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const logger = require("../utils/logger");
const config = require("../config");
const { migrationPool } = require("./connection");

const DIR = path.join(__dirname, "..", "..", "migrations");

const quoteIdent = (name) => `"${String(name).replace(/"/g, '""')}"`;

// The role the running service connects as: the user of DATABASE_URL.
function appRoleName() {
  try { return decodeURIComponent(new URL(config.database.url).username) || "adapter_app"; } catch { return "adapter_app"; }
}

// The SQL a migration file runs, with the adapter's schema and application role substituted (see the header).
function renderSql(sql, schema = config.database.schema, appRole = appRoleName()) {
  return sql
    .replace(/\bIN SCHEMA public\b/gi, `IN SCHEMA ${quoteIdent(schema)}`)
    .replace(/\badapter_app\b/g, quoteIdent(appRole));
}

// One run at a time per schema: two instances starting together (or a deploy step and a starting service) queue on this PostgreSQL advisory
// lock instead of racing; the second one then finds everything applied. Session-level, so it is released if the process dies.
const LOCK_CLASS = 0x464c4d47;
async function runMigrations() {
  const pool = migrationPool();
  const lockKey = crypto.createHash("sha256").update(config.database.schema).digest().readInt32BE(0);
  const lockClient = await pool.connect();
  try {
    await lockClient.query("SELECT pg_advisory_lock($1, $2)", [LOCK_CLASS, lockKey]);
    await applyMigrations();
  } finally {
    await lockClient.query("SELECT pg_advisory_unlock($1, $2)", [LOCK_CLASS, lockKey]).catch(() => {});
    lockClient.release();
  }
}

async function applyMigrations() {
  const pool = migrationPool();
  const schema = config.database.schema;
  if (schema !== "public") {
    // Created (once) by the runner because the migration history has to live somewhere; checked first because CREATE SCHEMA IF NOT EXISTS
    // needs CREATE on the database even when the schema exists, and the owner role is deliberately not given that.
    const { rowCount } = await pool.query("SELECT 1 FROM pg_namespace WHERE nspname = $1", [schema]);
    if (!rowCount) await pool.query("CREATE SCHEMA " + quoteIdent(schema));
  }
  // The history table's name is built from the validated, quoted schema name (configuration, never request data).
  const history = quoteIdent(schema) + ".schema_migrations";
  await pool.query("CREATE TABLE IF NOT EXISTS " + history + " (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
  const applied = new Map((await pool.query("SELECT id, checksum FROM " + history)).rows.map((r) => [r.id, r.checksum]));
  for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = fs.readFileSync(path.join(DIR, file), "utf8");
    const checksum = crypto.createHash("sha256").update(sql).digest("hex");
    if (applied.has(file)) {
      if (applied.get(file) !== checksum) throw new Error(`Migration ${file} was changed after it was applied`);
      continue;
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(renderSql(sql));
      await client.query("INSERT INTO " + history + " (id, checksum) VALUES ($1, $2)", [file, checksum]);
      await client.query("COMMIT");
      logger.info(`Applied migration ${file}`);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw new Error(`Migration ${file} failed: ${err.message}`, { cause: err });
    } finally {
      client.release();
    }
  }
}

async function syncEntityTypes(models) {
  const pool = migrationPool();
  for (const model of models) {
    await pool.query("INSERT INTO eav_entity_type (code, label) VALUES ($1, $2) ON CONFLICT (code) DO NOTHING", [model.entityType, model.label]);
    const { rows: [type] } = await pool.query("SELECT entity_type_id FROM eav_entity_type WHERE code = $1", [model.entityType]);
    for (const [code, def] of Object.entries(model.attributes)) {
      await pool.query(
        "INSERT INTO eav_attribute (entity_type_id, code, backend_type, frontend_type) VALUES ($1, $2, $3, $4) ON CONFLICT (entity_type_id, code) DO NOTHING",
        [type.entity_type_id, code, def.backend, def.frontend]
      );
    }
  }
}

// Read-only: which migration files are applied, pending, or changed after they were applied (the history table is in the adapter's schema).
async function migrationStatus() {
  const pool = migrationPool();
  const schema = config.database.schema;
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
  const history = quoteIdent(schema) + ".schema_migrations";
  const hasHistory = (await pool.query("SELECT to_regclass($1) AS t", [history])).rows[0].t !== null;
  const rows = hasHistory ? (await pool.query("SELECT id, checksum, applied_at FROM " + history + " ORDER BY id")).rows : [];
  const applied = new Map(rows.map((r) => [r.id, r]));
  const changed = [];
  const pending = [];
  for (const file of files) {
    const row = applied.get(file);
    if (!row) { pending.push(file); continue; }
    const checksum = crypto.createHash("sha256").update(fs.readFileSync(path.join(DIR, file), "utf8")).digest("hex");
    if (row.checksum !== checksum) changed.push(file);
  }
  return {
    schema,
    historyTable: hasHistory,
    files,
    applied: rows.map((r) => ({ id: r.id, appliedAt: r.applied_at })),
    pending,
    changed,
    unknown: rows.map((r) => r.id).filter((id) => !files.includes(id)), // applied by a newer build of the code
  };
}

// For RUN_MIGRATIONS_ON_START=false: the service does not migrate, but it must not run on a database that is behind (or that was changed).
async function assertMigrated() {
  const status = await migrationStatus();
  if (status.pending.length || status.changed.length) {
    const why = [status.pending.length ? `pending: ${status.pending.join(", ")}` : "", status.changed.length ? `changed after being applied: ${status.changed.join(", ")}` : ""].filter(Boolean).join("; ");
    throw new Error(`The database schema "${status.schema}" is not up to date (${why}). Run "npm run db:migrate" (or start with RUN_MIGRATIONS_ON_START=true).`);
  }
  return status;
}

module.exports = { runMigrations, syncEntityTypes, renderSql, migrationStatus, assertMigrated };
