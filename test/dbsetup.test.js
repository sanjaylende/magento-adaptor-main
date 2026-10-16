// Database set-up from zero, with the real command-line scripts (npm run db:bootstrap / db:migrate / db:status / db:verify) on a scratch
// database of the shared PostgreSQL server (test-only roles, see test/scratchDatabase.js): concurrent migrations, idempotency, drift and
// tamper detection, the start-up guard, and isolation from other schemas. The scratch database is dropped at the end.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("node:child_process");
const { Client } = require("pg");
const { createScratchDatabase, envFor, SUPERUSER } = require("./scratchDatabase");

const ROOT = path.join(__dirname, "..");
const DB = "magento_adapter_dbsetup_test";
const SCHEMA = "magento_adapter";
const FILES = fs.readdirSync(path.join(ROOT, "migrations")).filter((f) => f.endsWith(".sql")).sort();

const urlFor = (database, user, password) => { const u = new URL(SUPERUSER); u.pathname = "/" + database; if (user) { u.username = user; u.password = password; } return u.toString(); };
const childEnv = (extra = {}) => ({ ...process.env, ...envFor(DB), NODE_ENV: "test", LOG_TO_FILE: "false", ...extra });
const run = (script, args = [], extra = {}) => spawnSync(process.execPath, [path.join(ROOT, script), ...args], { cwd: ROOT, encoding: "utf8", env: childEnv(extra) });
const out = (r) => (r.stdout || "") + (r.stderr || "");
const runAsync = (script) => new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(ROOT, script)], { cwd: ROOT, env: childEnv() });
  let text = "";
  child.stdout.on("data", (d) => { text += d; });
  child.stderr.on("data", (d) => { text += d; });
  child.on("close", (code) => resolve({ code, text }));
});
async function superuser(sql) {
  const c = new Client({ connectionString: urlFor(DB) });
  await c.connect();
  try { return await c.query(sql); } finally { await c.end(); }
}
async function asRole(env, sql) { // runs one statement as the service or the owner role of the scratch database
  const c = new Client({ connectionString: env, options: "-c search_path=" + SCHEMA });
  await c.connect();
  try { return await c.query(sql); } finally { await c.end(); }
}

before(async () => { await createScratchDatabase(DB); });
after(async () => {
  const c = new Client({ connectionString: urlFor("postgres") });
  await c.connect();
  await c.query("DROP DATABASE IF EXISTS " + DB + " WITH (FORCE)"); // the scratch database of this test only
  await c.end();
});

test("RUN_MIGRATIONS_ON_START: on by default, off only for false / 0 / no / off", () => {
  const read = (v) => spawnSync(process.execPath, ["-e", "process.stdout.write(String(require('./src/config').database.runMigrationsOnStart))"],
    { cwd: ROOT, encoding: "utf8", env: { ...childEnv(), ...(v === undefined ? {} : { RUN_MIGRATIONS_ON_START: v }) } }).stdout;
  if (process.env.RUN_MIGRATIONS_ON_START !== undefined) delete process.env.RUN_MIGRATIONS_ON_START;
  assert.equal(read(undefined), "true");
  for (const v of ["true", "1", "yes", ""]) assert.equal(read(v), "true", "value " + JSON.stringify(v));
  for (const v of ["false", "0", "no", "off", "FALSE"]) assert.equal(read(v), "false", "value " + JSON.stringify(v));
});

test("a bootstrapped but not yet migrated schema: everything is pending and db:verify fails", () => {
  const s = run("scripts/db/status.js", ["--exit-code"]);
  assert.equal(s.status, 1);
  assert.match(out(s), new RegExp("0 applied, " + FILES.length + " pending"));
  assert.match(out(s), /not created yet/);
  assert.equal(run("scripts/db/verify.js").status, 1);
});

test("three instances starting at once: each migration is applied exactly once, nothing fails (advisory lock)", async () => {
  const results = await Promise.all([runAsync("scripts/db/migrate.js"), runAsync("scripts/db/migrate.js"), runAsync("scripts/db/migrate.js")]);
  for (const r of results) assert.equal(r.code, 0, r.text.slice(-400));
  const applied = results.map((r) => (r.text.match(/Applied migration/g) || []).length).reduce((a, b) => a + b, 0);
  assert.equal(applied, FILES.length, "every migration applied once across the three runs");
  const { rows } = await superuser("SELECT count(*)::int AS n FROM " + SCHEMA + ".schema_migrations");
  assert.equal(rows[0].n, FILES.length);
});

test("running migrate again changes nothing and fails nowhere", () => {
  const r = run("scripts/db/migrate.js");
  assert.equal(r.status, 0, out(r).slice(-300));
  assert.doesNotMatch(out(r), /Applied migration/);
  assert.equal(run("scripts/db/status.js", ["--exit-code"]).status, 0);
});

test("db:bootstrap is idempotent: run twice, the roles keep working, no extension is required", () => {
  const env = { DATABASE_SUPERUSER_URL: urlFor(DB) };
  for (let i = 0; i < 2; i++) {
    const r = run("scripts/db/provision.js", [], env);
    assert.equal(r.status, 0, out(r).slice(-300));
    assert.match(out(r), /no PostgreSQL extensions are required/);
    assert.match(out(r), /password kept/);
  }
});

test("db:verify passes on a fresh install, which holds no rows except the plan catalogue", () => {
  const r = run("scripts/db/verify.js", ["--expect-empty-install"]);
  assert.equal(r.status, 0, out(r));
  assert.match(out(r), /All checks passed/);
  assert.match(out(r), /clean install: no rows outside the plan catalogue/);
});

test("the migration history is not writable by the service role (migration 012)", async () => {
  await assert.rejects(() => asRole(envFor(DB).DATABASE_URL, "DELETE FROM schema_migrations"), /permission denied/);
  await assert.rejects(() => asRole(envFor(DB).DATABASE_URL, "SELECT 1 FROM schema_migrations"), /permission denied/);
});

test("db:verify reports drift in the structure, and passes again once it is gone", async () => {
  await superuser("ALTER TABLE " + SCHEMA + ".plans ADD COLUMN zz_drift int");
  const bad = run("scripts/db/verify.js");
  assert.equal(bad.status, 1);
  assert.match(out(bad), /FAIL {2}structure: columns/);
  assert.match(out(bad), /zz_drift/);
  await superuser("ALTER TABLE " + SCHEMA + ".plans DROP COLUMN zz_drift");
  assert.equal(run("scripts/db/verify.js").status, 0);
});

test("db:verify reports a missing grant of the service role", async () => {
  await superuser("REVOKE DELETE ON TABLE " + SCHEMA + ".plans FROM " + envFor(DB).DATABASE_URL.split("//")[1].split(":")[0]);
  const bad = run("scripts/db/verify.js");
  assert.equal(bad.status, 1);
  assert.match(out(bad), /FAIL {2}service role has SELECT\/INSERT\/UPDATE\/DELETE on every table/);
  assert.equal(run("scripts/db/migrate.js").status, 0); // migrations do not repair grants: that is db:bootstrap's job (default privileges) and a deliberate act
  await superuser("GRANT DELETE ON TABLE " + SCHEMA + ".plans TO " + envFor(DB).DATABASE_URL.split("//")[1].split(":")[0]);
  assert.equal(run("scripts/db/verify.js").status, 0);
});

test("neither role can read or create anything in another schema; the service role cannot write its own schema's structure", async () => {
  await superuser("CREATE SCHEMA zz_other; CREATE TABLE zz_other.secret (v text); INSERT INTO zz_other.secret VALUES ('x')");
  const env = envFor(DB);
  for (const url of [env.DATABASE_URL, env.DATABASE_ADMIN_URL]) {
    await assert.rejects(() => asRole(url, "SELECT * FROM zz_other.secret"), /permission denied/);
    await assert.rejects(() => asRole(url, "CREATE TABLE zz_other.t (x int)"), /permission denied/);
    await assert.rejects(() => asRole(url, "CREATE TABLE public.zz_probe (x int)"), /permission denied/);
  }
  await assert.rejects(() => asRole(env.DATABASE_URL, "CREATE TABLE zz_probe (x int)"), /permission denied/);
  await assert.rejects(() => asRole(env.DATABASE_URL, "DROP TABLE plans"), /must be owner|permission denied/);
  assert.equal(run("scripts/db/verify.js").status, 0);
  await superuser("DROP SCHEMA zz_other CASCADE");
});

test("a migration file edited after it was applied is refused, and db:status shows it", async () => {
  const original = (await superuser("SELECT checksum FROM " + SCHEMA + ".schema_migrations WHERE id = '001_tenancy.sql'")).rows[0].checksum;
  await superuser("UPDATE " + SCHEMA + ".schema_migrations SET checksum = 'edited' WHERE id = '001_tenancy.sql'");
  const m = run("scripts/db/migrate.js");
  assert.equal(m.status, 1);
  assert.match(out(m), /001_tenancy\.sql was changed after it was applied/);
  assert.match(out(run("scripts/db/status.js")), /CHANGED {2}001_tenancy\.sql/);
  await superuser("UPDATE " + SCHEMA + ".schema_migrations SET checksum = '" + original + "' WHERE id = '001_tenancy.sql'");
  assert.equal(run("scripts/db/migrate.js").status, 0);
});

test("RUN_MIGRATIONS_ON_START=false: the service refuses a database that is behind, and accepts it once migrated", async () => {
  const last = FILES[FILES.length - 1];
  await superuser("DELETE FROM " + SCHEMA + ".schema_migrations WHERE id = '" + last + "'"); // the scratch database of this test: simulates a database behind the code
  const probe = () => spawnSync(process.execPath, ["-e", "require('./src/db/migrate').assertMigrated().then(()=>{console.log('UP-TO-DATE');return require('./src/db/connection').close()}).then(()=>process.exit(0),(e)=>{console.log(e.message);process.exit(3)})"],
    { cwd: ROOT, encoding: "utf8", env: childEnv({ RUN_MIGRATIONS_ON_START: "false" }) });
  const behind = probe();
  assert.equal(behind.status, 3);
  assert.match(out(behind), new RegExp("not up to date \\(pending: " + last.replace(".", "\\.")));
  assert.equal(run("scripts/db/migrate.js").status, 0);
  assert.match(out(probe()), /UP-TO-DATE/);
});
