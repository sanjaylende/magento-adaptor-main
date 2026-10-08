// Migration runner: applies migrations/*.sql in name order, once each, recorded in schema_migrations with a checksum
// (a changed, already-applied file is an error: write a new migration instead). Then syncs the EAV attribute
// definitions declared by the models into eav_entity_type / eav_attribute (idempotent).
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const logger = require("../utils/logger");
const { migrationPool } = require("./connection");

const DIR = path.join(__dirname, "..", "..", "migrations");

async function runMigrations() {
  const pool = migrationPool();
  await pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
  const applied = new Map((await pool.query("SELECT id, checksum FROM schema_migrations")).rows.map((r) => [r.id, r.checksum]));
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
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (id, checksum) VALUES ($1, $2)", [file, checksum]);
      await client.query("COMMIT");
      logger.info(`Applied migration ${file}`);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw new Error(`Migration ${file} failed: ${err.message}`);
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

module.exports = { runMigrations, syncEntityTypes };
