#!/usr/bin/env node
// db:verify - reports drift between a live database and what the code expects. Read-only; never prints passwords or URLs.
//   npm run db:verify                          schema, migrations, structure, roles, grants, isolation from other schemas
//   npm run db:verify -- --expect-empty-install   also: no row anywhere except the plan catalogue (a clean install)
// Checks (owner role from DATABASE_ADMIN_URL, service role from DATABASE_URL, schema from DB_SCHEMA):
//   1. the schema exists and is owned by the owner role
//   2. every migration is applied, none changed after being applied (npm run db:status shows the list)
//   3. tables, columns, indexes, constraints, sequences, functions, row-level-security flags and policies equal db/structure.manifest.json
//      (written from the reference schema by npm run db:manifest -- --write)
//   4. both roles: no superuser / createdb / createrole / replication / bypassrls; search_path defaults to the schema
//   5. the service role: USAGE but not CREATE on the schema, SELECT/INSERT/UPDATE/DELETE on every table, USAGE+SELECT on every sequence
//   6. isolation: neither role can read any object, or create anything, in any OTHER schema (public, shopify_adapter, ...); skipped for
//      the legacy layout (DB_SCHEMA=public)
// Exit code 1 when anything fails.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const config = require("../../src/config");
const { migrationPool, close } = require("../../src/db/connection");
const { migrationStatus } = require("../../src/db/migrate");
const { readStructure, diffStructure, HISTORY_TABLE } = require("../../src/db/structure");

const MANIFEST = path.join(__dirname, "..", "..", "db", "structure.manifest.json");
const SEEDED = new Set(["plans", "plan_prices", "plan_video_rates"]); // filled by migration 006 (the plan catalogue)
const quoteIdent = (n) => '"' + String(n).replace(/"/g, '""') + '"';
const expectEmpty = process.argv.includes("--expect-empty-install");

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log((ok ? "PASS  " : "FAIL  ") + name + (detail ? "  [" + detail + "]" : ""));
}
const short = (list, n = 6) => list.slice(0, n).join("; ") + (list.length > n ? "; ... (" + list.length + " in all)" : "");

async function main() {
  const schema = config.database.schema;
  const appRole = decodeURIComponent(new URL(config.database.url).username);
  const client = await migrationPool().connect();
  try {
    const { rows: [me] } = await client.query("SELECT current_user AS u, current_database() AS d");
    console.log("database " + me.d + ", schema " + schema + ", owner role " + me.u + ", service role " + appRole + "\n");

    // 1
    const { rows: [ns] } = await client.query("SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = $1", [schema]);
    check("schema exists", !!ns, ns ? "" : "run npm run db:bootstrap, then npm run db:migrate");
    if (!ns) return;
    check("schema is owned by the owner role", ns.owner === me.u, "owner is " + ns.owner);

    // 2
    const st = await migrationStatus();
    check("every migration is applied", st.pending.length === 0, st.pending.length ? "pending: " + short(st.pending) : st.applied.length + " applied");
    check("no migration was changed after it was applied", st.changed.length === 0, st.changed.join(", "));
    check("no migration is applied that this code does not know", st.unknown.length === 0, st.unknown.join(", "));

    // 3
    if (!fs.existsSync(MANIFEST)) {
      check("structure manifest present", false, "db/structure.manifest.json is missing: npm run db:manifest -- --write");
    } else {
      const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
      const live = await readStructure(client, schema, appRole);
      const drift = diffStructure(manifest.structure, live);
      for (const section of Object.keys(manifest.structure)) {
        const d = drift[section];
        check("structure: " + section + " (" + manifest.structure[section].length + ")", !d,
          d ? "missing: " + (short(d.missing) || "none") + " | unexpected: " + (short(d.extra) || "none") : "");
      }
    }

    // 4
    for (const [label, role] of [["owner role", me.u], ["service role", appRole]]) {
      const { rows: [r] } = await client.query(
        "SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = $1", [role]);
      if (!r) { check(label + " exists", false, role); continue; }
      const bad = Object.entries(r).filter(([, v]) => v).map(([k]) => k);
      check(label + " has no extra powers (superuser, createdb, createrole, replication, bypassrls)", bad.length === 0, bad.join(", "));
      const { rows: [sp] } = await client.query(
        "SELECT EXISTS (SELECT 1 FROM pg_db_role_setting s JOIN pg_roles r ON r.oid = s.setrole WHERE r.rolname = $1 " +
        "AND (s.setdatabase = 0 OR s.setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database())) AND $2 = ANY (s.setconfig)) AS ok",
        [role, "search_path=" + schema]);
      check(label + " defaults to search_path=" + schema, sp.ok);
    }

    // 5
    const { rows: [sp] } = await client.query("SELECT has_schema_privilege($1, $2, 'USAGE') AS u, has_schema_privilege($1, $2, 'CREATE') AS c", [appRole, schema]);
    check("service role can use the schema", sp.u);
    check("service role cannot create objects in the schema", !sp.c);
    const noDml = (await client.query(
      "SELECT c.relname FROM pg_class c WHERE c.relnamespace = $1::regnamespace AND c.relkind = 'r' AND c.relname <> $3 AND NOT (" +
      "has_table_privilege($2, c.oid, 'SELECT') AND has_table_privilege($2, c.oid, 'INSERT') AND has_table_privilege($2, c.oid, 'UPDATE') AND has_table_privilege($2, c.oid, 'DELETE'))",
      [schema, appRole, HISTORY_TABLE])).rows.map((r) => r.relname);
    check("service role has SELECT/INSERT/UPDATE/DELETE on every table", noDml.length === 0, short(noDml));
    const noSeq = (await client.query(
      "SELECT c.relname FROM pg_class c WHERE c.relnamespace = $1::regnamespace AND c.relkind = 'S' AND NOT (has_sequence_privilege($2, c.oid, 'USAGE') AND has_sequence_privilege($2, c.oid, 'SELECT'))",
      [schema, appRole])).rows.map((r) => r.relname);
    check("service role has USAGE+SELECT on every sequence", noSeq.length === 0, short(noSeq));
    const { rows: [hist] } = await client.query("SELECT to_regclass($1) AS t", [quoteIdent(schema) + "." + HISTORY_TABLE]);
    if (hist.t) {
      const { rows: [h] } = await client.query("SELECT has_table_privilege($1, $2::regclass, 'INSERT') OR has_table_privilege($1, $2::regclass, 'UPDATE') OR has_table_privilege($1, $2::regclass, 'DELETE') AS w", [appRole, quoteIdent(schema) + "." + HISTORY_TABLE]);
      check("service role cannot change the migration history", !h.w);
    }

    // 6
    if (schema === "public") {
      console.log("SKIP  isolation from other schemas (legacy layout, DB_SCHEMA=public)");
    } else {
      for (const [label, role] of [["service role", appRole], ["owner role", me.u]]) {
        const readable = (await client.query(
          "SELECT n.nspname || '.' || c.relname AS o FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace " +
          "WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname <> $1 " +
          "AND c.relkind IN ('r', 'v', 'm', 'p', 'S') AND has_table_privilege($2, c.oid, 'SELECT') ORDER BY 1 LIMIT 6", [schema, role])).rows.map((r) => r.o);
        check(label + " cannot read objects of other schemas", readable.length === 0, readable.join(", "));
        const creatable = (await client.query(
          "SELECT nspname FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname <> 'information_schema' AND nspname <> $1 AND has_schema_privilege($2, oid, 'CREATE')", [schema, role])).rows.map((r) => r.nspname);
        check(label + " cannot create objects in other schemas", creatable.length === 0, creatable.join(", "));
        const usable = (await client.query(
          "SELECT nspname FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname NOT IN ('information_schema', 'public') AND nspname <> $1 AND has_schema_privilege($2, oid, 'USAGE')", [schema, role])).rows.map((r) => r.nspname);
        check(label + " has no access to other application schemas", usable.length === 0, usable.join(", "));
      }
    }

    // optional: a clean install holds no rows except the plan catalogue
    if (expectEmpty) {
      await client.query("SELECT set_config('app.bypass', 'on', false)"); // forced row-level security: this one session sees every tenant
      const tables = (await client.query("SELECT c.relname FROM pg_class c WHERE c.relnamespace = $1::regnamespace AND c.relkind = 'r' AND c.relname <> $2 ORDER BY 1", [schema, HISTORY_TABLE])).rows.map((r) => r.relname);
      const filled = [];
      const catalogue = [];
      for (const t of tables) {
        const { rows: [c] } = await client.query("SELECT count(*)::int AS n FROM " + quoteIdent(schema) + "." + quoteIdent(t));
        if (c.n && SEEDED.has(t)) catalogue.push(t + "=" + c.n);
        else if (c.n) filled.push(t + "=" + c.n);
      }
      check("clean install: no rows outside the plan catalogue (" + tables.length + " tables)", filled.length === 0, filled.join(", ") || "plan catalogue: " + catalogue.join(", "));
    }
  } finally {
    client.release();
  }
}

main()
  .then(() => { console.log("\n" + (failures ? failures + " check(s) FAILED" : "All checks passed")); return close(); })
  .then(() => process.exit(failures ? 1 : 0), (err) => { console.error("db:verify could not run:", err.message); process.exit(2); });
