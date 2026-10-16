#!/usr/bin/env node
// Moves the adapter's data from a database of its own (the old layout: schema "public" of the docker PostgreSQL on 5434) into the
// adapter's schema of the shared database, then proves the copy is exact. Repeatable and documented; the SOURCE is only read.
//
//   SOURCE_DATABASE_URL=postgresql://adapter_owner:***@127.0.0.1:5434/magento_adapter  node scripts/db/move-data.js
//   node scripts/db/move-data.js --verify-only        # just compare (row counts, checksums, sequences) and report
//
// The target is what the adapter itself is configured with: DATABASE_ADMIN_URL (the owner role) and DB_SCHEMA. Run scripts/db/provision.js
// first, and stop the adapter while the copy runs. What it does:
//   1. applies the migrations to the target (schema, tables, indexes, constraints, policies, functions; the migration history stays in
//      the new schema, it is not copied),
//   2. refuses to copy into a target that already holds rows (no overwrite, no TRUNCATE, nothing is deleted anywhere),
//   3. copies every table in foreign-key order inside ONE transaction, from ONE consistent snapshot of the source, with primary keys
//      preserved (a self-referencing foreign key is filled in a second pass),
//   4. sets every sequence to the source's value, and 5. compares row counts and an md5 checksum of every row, table by table.
const { Client } = require("pg");
require("dotenv").config();
const config = require("../../src/config");

const quote = (n) => `"${String(n).replace(/"/g, '""')}"`;
const BATCH_BYTES = 3 * 1024 * 1024;
const verifyOnly = process.argv.includes("--verify-only");
// Tables the migrations themselves fill (migrations/006_seed_plans.sql). They hold rows in a fresh schema, so the copy upserts them by
// primary key (the source values win); any other non-empty table still stops the move. Rows only present in the target show up as a
// checksum MISMATCH in the verification, nothing is deleted.
const SEEDED_BY_MIGRATIONS = new Set(["plans", "plan_prices", "plan_video_rates"]);

function clientFor(url, label) {
  let u;
  try { u = new URL(url); } catch { throw new Error(`${label} is not a valid URL`); }
  return new Client({
    host: u.hostname, port: Number(u.port || 5432), user: decodeURIComponent(u.username), password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, ""), options: "-c timezone=UTC", application_name: "magento-adapter-move",
    ssl: config.database.sslMode === "disable" || /^(127\.0\.0\.1|localhost)$/.test(u.hostname) ? false : { rejectUnauthorized: config.database.sslMode === "require" },
  });
}

async function tableInfo(c, schema) {
  const tables = (await c.query("SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind = 'r' AND c.relname <> 'schema_migrations' ORDER BY 1", [schema])).rows.map((r) => r.name);
  const pk = {};
  for (const r of (await c.query(
    `SELECT c.relname AS t, a.attname AS col FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY (i.indkey) WHERE i.indisprimary AND n.nspname = $1 ORDER BY c.relname, array_position(i.indkey::int2[], a.attnum)`, [schema])).rows) (pk[r.t] ||= []).push(r.col);
  const fks = (await c.query(
    `SELECT cl.relname AS child, pr.relname AS parent, ARRAY(SELECT a.attname FROM unnest(k.conkey) WITH ORDINALITY u(n, o) JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.n ORDER BY u.o) AS cols
       FROM pg_constraint k JOIN pg_class cl ON cl.oid = k.conrelid JOIN pg_class pr ON pr.oid = k.confrelid JOIN pg_namespace n ON n.oid = cl.relnamespace
      WHERE k.contype = 'f' AND n.nspname = $1`, [schema])).rows;
  const seqs = (await c.query("SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind = 'S' ORDER BY 1", [schema])).rows.map((r) => r.name);
  return { tables, pk, fks, seqs };
}

// Parents before children (self references do not count; they are handled per table).
function copyOrder(tables, fks) {
  const deps = new Map(tables.map((t) => [t, new Set()]));
  for (const f of fks) if (f.child !== f.parent && deps.has(f.child) && deps.has(f.parent)) deps.get(f.child).add(f.parent);
  const order = [];
  while (order.length < tables.length) {
    const ready = tables.filter((t) => !order.includes(t) && [...deps.get(t)].every((p) => order.includes(p)));
    if (!ready.length) throw new Error("foreign keys form a cycle between tables; cannot order the copy");
    order.push(...ready);
  }
  return order;
}

// The ordering is by the key as text under the C collation: the old and the new server may use different collations.
async function fingerprint(c, schema, table, pkCols) {
  const orderBy = pkCols.map(quote).join(", ");
  const { rows: [r] } = await c.query(`SELECT count(*)::int AS n, coalesce(md5(string_agg(x.r, E'\\n' ORDER BY x.k COLLATE "C")), '') AS sum FROM (SELECT to_jsonb(t)::text AS r, row(${orderBy})::text AS k FROM ${quote(schema)}.${quote(table)} t) x`);
  return r;
}

async function main() {
  const sourceUrl = process.env.SOURCE_DATABASE_URL;
  if (!sourceUrl) throw new Error("SOURCE_DATABASE_URL is required (the old adapter database, read only)");
  const sourceSchema = process.env.SOURCE_DB_SCHEMA || "public";
  const targetSchema = config.database.schema;
  if (targetSchema === "public") throw new Error("the target schema is public: set DB_SCHEMA to the adapter's own schema first");

  const src = clientFor(sourceUrl, "SOURCE_DATABASE_URL");
  const dst = clientFor(config.database.adminUrl, "DATABASE_ADMIN_URL");
  await src.connect();
  await dst.connect();
  try {
    // One consistent, read-only snapshot of the source.
    await src.query("BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ");
    const S = await tableInfo(src, sourceSchema);

    if (!verifyOnly) {
      const { runMigrations } = require("../../src/db/migrate");
      await runMigrations();
      console.log(`target ${targetSchema}: migrations applied`);
    }
    const T = await tableInfo(dst, targetSchema);
    const missing = S.tables.filter((t) => !T.tables.includes(t)), extra = T.tables.filter((t) => !S.tables.includes(t));
    if (missing.length || extra.length) throw new Error(`table sets differ (missing in target: ${missing.join(", ") || "none"}; only in target: ${extra.join(", ") || "none"})`);

    if (!verifyOnly) {
      for (const t of S.tables) {
        const { rows: [{ n }] } = await dst.query(`SELECT count(*)::int AS n FROM (SELECT 1 FROM ${quote(targetSchema)}.${quote(t)} LIMIT 1) x`);
        if (n && !SEEDED_BY_MIGRATIONS.has(t)) throw new Error(`target table ${targetSchema}.${t} already holds rows: refusing to copy into a non-empty schema (nothing was changed)`);
      }
      const order = copyOrder(S.tables, S.fks);
      await dst.query("BEGIN");
      // The tables have forced row-level security; this one session is allowed to see and write every tenant (like the staff console).
      await dst.query("SELECT set_config('app.bypass', 'on', true)");
      for (const table of order) {
        const pk = S.pk[table] || [];
        if (!pk.length) throw new Error(`table ${table} has no primary key; cannot copy it deterministically`);
        const selfCols = [...new Set(S.fks.filter((f) => f.child === table && f.parent === table).flatMap((f) => f.cols))];
        const cursor = `copy_${table}`.slice(0, 60);
        await src.query(`DECLARE ${quote(cursor)} NO SCROLL CURSOR FOR SELECT to_jsonb(t) AS r FROM ${quote(sourceSchema)}.${quote(table)} t ORDER BY ${pk.map(quote).join(", ")}`);
        let copied = 0, buffer = [], size = 0;
        const flush = async () => {
          if (!buffer.length) return;
          const rows = buffer; buffer = []; size = 0;
          const stripped = rows.map((r) => { const c = { ...r }; for (const col of selfCols) c[col] = null; return c; });
          let upsert = "";
          if (SEEDED_BY_MIGRATIONS.has(table)) {
            const cols = Object.keys(rows[0]).filter((col) => !pk.includes(col));
            upsert = ` ON CONFLICT (${pk.map(quote).join(", ")}) DO ` + (cols.length ? "UPDATE SET " + cols.map((col) => `${quote(col)} = EXCLUDED.${quote(col)}`).join(", ") : "NOTHING");
          }
          await dst.query(`INSERT INTO ${quote(targetSchema)}.${quote(table)} SELECT * FROM jsonb_populate_recordset(NULL::${quote(targetSchema)}.${quote(table)}, $1::jsonb)` + upsert, [JSON.stringify(stripped)]);
          if (selfCols.length) {
            const keyed = rows.filter((r) => selfCols.some((col) => r[col] !== null && r[col] !== undefined));
            if (keyed.length) {
              const sets = selfCols.map((col) => `${quote(col)} = s.${quote(col)}`).join(", ");
              const join = pk.map((col) => `t.${quote(col)} = s.${quote(col)}`).join(" AND ");
              const defs = [...new Set([...pk, ...selfCols])].map((col) => `${quote(col)} bigint`).join(", ");
              await dst.query(`UPDATE ${quote(targetSchema)}.${quote(table)} t SET ${sets} FROM jsonb_to_recordset($1::jsonb) AS s(${defs}) WHERE ${join}`, [JSON.stringify(keyed)]);
            }
          }
          copied += rows.length;
        };
        for (;;) {
          const { rows } = await src.query(`FETCH 100 FROM ${quote(cursor)}`);
          if (!rows.length) break;
          for (const { r } of rows) { buffer.push(r); size += JSON.stringify(r).length; if (size > BATCH_BYTES) await flush(); }
        }
        await flush();
        await src.query(`CLOSE ${quote(cursor)}`);
        console.log(`copied ${table}: ${copied} row(s)`);
      }
      for (const seq of S.seqs) {
        const { rows: [v] } = await src.query(`SELECT last_value::text AS last, is_called FROM ${quote(sourceSchema)}.${quote(seq)}`);
        if (!T.seqs.includes(seq)) throw new Error(`sequence ${seq} is missing in the target`);
        await dst.query("SELECT setval($1, $2::bigint, $3)", [`${quote(targetSchema)}.${quote(seq)}`, v.last, v.is_called]);
      }
      await dst.query("COMMIT");
      console.log("transaction committed");
    }

    // ---- verification (always)
    await dst.query("BEGIN READ ONLY");
    await dst.query("SELECT set_config('app.bypass', 'on', true)");
    let bad = 0;
    const lines = [];
    for (const table of S.tables) {
      const a = await fingerprint(src, sourceSchema, table, S.pk[table]);
      const b = await fingerprint(dst, targetSchema, table, S.pk[table]);
      const same = a.n === b.n && a.sum === b.sum;
      if (!same) bad++;
      lines.push({ table, source_rows: a.n, target_rows: b.n, checksum_source: a.sum.slice(0, 10), checksum_target: b.sum.slice(0, 10), result: same ? "OK" : "MISMATCH" });
    }
    for (const seq of S.seqs) {
      const { rows: [a] } = await src.query(`SELECT last_value::text AS v, is_called AS c FROM ${quote(sourceSchema)}.${quote(seq)}`);
      const { rows: [b] } = await dst.query(`SELECT last_value::text AS v, is_called AS c FROM ${quote(targetSchema)}.${quote(seq)}`);
      const same = a.v === b.v && a.c === b.c;
      if (!same) bad++;
      lines.push({ table: `sequence ${seq}`, source_rows: a.v, target_rows: b.v, checksum_source: String(a.c), checksum_target: String(b.c), result: same ? "OK" : "MISMATCH" });
    }
    await dst.query("ROLLBACK");
    console.table(lines);
    if (bad) throw new Error(`${bad} table(s)/sequence(s) differ between source and target`);
    console.log(`Verified: ${S.tables.length} tables and ${S.seqs.length} sequences are identical in source and target.`);
  } catch (err) {
    await dst.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    await src.query("ROLLBACK").catch(() => {});
    await src.end();
    await dst.end();
    await require("../../src/db/connection").close();
  }
}

main().then(() => process.exit(0), (err) => { console.error("FAILED:", err.message); process.exit(1); });
