// Reads the structure of the adapter's schema from the PostgreSQL catalogs as sorted, comparable strings (tables with their row-level security
// flags, columns, indexes, constraints, sequences, functions, policies). The schema name and the application role name are taken out of
// every string, so the same migrations give the same result in any schema / with any role names. Read-only. Used by scripts/db/manifest.js
// (writes db/structure.manifest.json) and scripts/db/verify.js (compares a live database with it).
const HISTORY_TABLE = "schema_migrations";

async function readStructure(client, schema, appRole) {
  // schema comes from configuration and is validated to ^[a-z_][a-z0-9_]{0,62}$ (src/config); the role name only goes through a plain replace.
  const schemaRe = new RegExp('"?' + String(schema).replace(/[^a-z0-9_]/gi, "") + '"?\\.', "g");
  const norm = (s) => {
    let out = String(s).replace(schemaRe, "").replace(/\s+/g, " ").trim();
    if (appRole) out = out.split('"' + appRole + '"').join("{app}").split(appRole).join("{app}");
    return out;
  };
  const list = async (sql, params) => (await client.query(sql, params)).rows.map((r) => norm(r.x)).sort();

  return {
    tables: await list(
      "SELECT c.relname || ' rls=' || c.relrowsecurity || ' force=' || c.relforcerowsecurity AS x FROM pg_class c " +
      "WHERE c.relnamespace = $1::regnamespace AND c.relkind = 'r' AND c.relname <> $2", [schema, HISTORY_TABLE]),
    columns: await list(
      "SELECT table_name || '.' || column_name || ' ' || data_type || ' null=' || is_nullable || ' default=' || coalesce(column_default, '') || ' identity=' || is_identity AS x " +
      "FROM information_schema.columns WHERE table_schema = $1 AND table_name <> $2", [schema, HISTORY_TABLE]),
    indexes: await list(
      "SELECT indexdef AS x FROM pg_indexes WHERE schemaname = $1 AND tablename <> $2", [schema, HISTORY_TABLE]),
    constraints: await list(
      "SELECT conrelid::regclass::text || ' ' || conname || ' ' || pg_get_constraintdef(oid) AS x FROM pg_constraint " +
      "WHERE connamespace = $1::regnamespace AND conrelid::regclass::text NOT LIKE '%' || $2", [schema, HISTORY_TABLE]),
    sequences: await list("SELECT sequencename AS x FROM pg_sequences WHERE schemaname = $1", [schema]),
    functions: await list(
      "SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS x FROM pg_proc p WHERE p.pronamespace = $1::regnamespace", [schema]),
    policies: await list(
      "SELECT tablename || ' ' || policyname || ' ' || cmd || ' ' || permissive || ' roles=' || roles::text || ' using=' || coalesce(qual, '') || ' check=' || coalesce(with_check, '') AS x " +
      "FROM pg_policies WHERE schemaname = $1", [schema]),
  };
}

// { section: { missing: [..], extra: [..] } } for every section that differs; empty object when identical.
function diffStructure(expected, actual) {
  const out = {};
  for (const section of Object.keys(expected)) {
    const a = new Set(actual[section] || []);
    const e = new Set(expected[section]);
    const missing = expected[section].filter((x) => !a.has(x));
    const extra = (actual[section] || []).filter((x) => !e.has(x));
    if (missing.length || extra.length) out[section] = { missing, extra };
  }
  return out;
}

module.exports = { readStructure, diffStructure, HISTORY_TABLE };
