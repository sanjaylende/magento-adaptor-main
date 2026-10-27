#!/usr/bin/env node
// One-time (and repeatable) database provisioning for the shared-database layout: the adapter's own schema in an existing PostgreSQL
// database, plus two dedicated least-privilege roles. Run by a database administrator, never by the running service.
//
//   DATABASE_SUPERUSER_URL=postgresql://postgres:***@127.0.0.1:5432/ltx_1jnl  node scripts/db/provision.js
//
// Reads the rest from the same environment / .env the adapter uses: DATABASE_URL (the service role: user, password, database),
// DATABASE_ADMIN_URL (the owner role that runs migrations) and DB_SCHEMA (default magento_adapter). It creates:
//   * the owner role   - LOGIN, no superuser / createdb / createrole / replication / bypassrls; owns the schema and its tables
//   * the service role - same restrictions; may only use the schema (USAGE) and, through default privileges set by migration 000,
//                        SELECT/INSERT/UPDATE/DELETE on its tables and USAGE/SELECT on its sequences; row-level security applies to it
//   * the schema, owned by the owner role, closed to everyone else (REVOKE ALL FROM PUBLIC)
//   * search_path = <schema> as the default of both roles (the connection option in src/db/connection.js sets it as well)
// Nothing in any other schema ("public", "shopify_adapter", "automotive_aftermarket", ...) is read, granted, altered or created.
// Idempotent: existing roles keep their password unless --rotate-passwords is given. Passwords never reach the output.
const { Client } = require("pg");

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;
const ident = (client, name) => {
  if (!IDENT.test(name)) throw new Error(`"${name}" is not a plain lower-case identifier`);
  return client.escapeIdentifier(name);
};

// PostgreSQL extensions the schema needs: none today (the migrations contain no CREATE EXTENSION and use no extension type or function).
// If one is ever added here it is created only when missing and only if the administrator role may; otherwise the instruction is printed.
const REQUIRED_EXTENSIONS = [];

async function ensureExtensions(client, log) {
  if (!REQUIRED_EXTENSIONS.length) { log("no PostgreSQL extensions are required"); return; }
  for (const name of REQUIRED_EXTENSIONS) {
    const { rowCount } = await client.query("SELECT 1 FROM pg_extension WHERE extname = $1", [name]);
    if (rowCount) { log(`extension ${name} is present`); continue; }
    try {
      await client.query(`CREATE EXTENSION IF NOT EXISTS ${ident(client, name)}`);
      log(`created extension ${name}`);
    } catch (err) {
      log(`extension ${name} is missing and this administrator role could not create it (${err.message}). Ask a superuser to run: CREATE EXTENSION ${name};`);
    }
  }
}

function parseUrl(url, label) {
  let u;
  try { u = new URL(url); } catch { throw new Error(`${label} is not a valid URL`); }
  return { host: u.hostname, port: Number(u.port || 5432), user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database: u.pathname.replace(/^\//, "") };
}

// options: { superuserUrl, ownerUrl, appUrl, schema, rotatePasswords, ssl, log }
async function provision({ superuserUrl, ownerUrl, appUrl, schema = "magento_adapter", rotatePasswords = false, ssl = false, log = () => {} }) {
  const owner = parseUrl(ownerUrl, "DATABASE_ADMIN_URL");
  const app = parseUrl(appUrl, "DATABASE_URL");
  const target = parseUrl(superuserUrl, "DATABASE_SUPERUSER_URL");
  if (owner.database !== app.database) throw new Error("DATABASE_URL and DATABASE_ADMIN_URL must name the same database");
  if (owner.user === app.user) throw new Error("the owner role and the service role must be two different roles");
  if (!owner.password || !app.password) throw new Error("both role URLs need a password");
  if (schema === "public") throw new Error("provisioning is for a dedicated schema; for the legacy layout (schema public) use docker/db-init");
  const database = owner.database;

  const client = new Client({ host: target.host, port: target.port, user: target.user, password: target.password, database, ssl });
  await client.connect();
  try {
    const { rows: [me] } = await client.query("SELECT rolsuper OR rolcreaterole AS can FROM pg_roles WHERE rolname = current_user");
    if (!me.can) throw new Error("DATABASE_SUPERUSER_URL must be a role that may create roles (a superuser or CREATEROLE)");
    const S = ident(client, schema), O = ident(client, owner.user), A = ident(client, app.user), D = ident(client, database);

    for (const role of [owner, app]) {
      const R = ident(client, role.user);
      const { rowCount } = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role.user]);
      if (!rowCount) {
        await client.query(`CREATE ROLE ${R} LOGIN PASSWORD ${client.escapeLiteral(role.password)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
        log(`created role ${role.user}`);
      } else {
        // Whatever it was before, it ends up with no extra powers; the password is only touched on request.
        await client.query(`ALTER ROLE ${R} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
        if (rotatePasswords) await client.query(`ALTER ROLE ${R} PASSWORD ${client.escapeLiteral(role.password)}`);
        log(`role ${role.user} exists: restrictions enforced${rotatePasswords ? ", password rotated" : ", password kept"}`);
      }
      await client.query(`GRANT CONNECT ON DATABASE ${D} TO ${R}`);
      await client.query(`ALTER ROLE ${R} IN DATABASE ${D} SET search_path = ${S}`);
    }

    const { rows: [existing] } = await client.query("SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = $1", [schema]);
    if (!existing) {
      await client.query(`CREATE SCHEMA ${S} AUTHORIZATION ${O}`);
      log(`created schema ${schema} owned by ${owner.user}`);
    } else if (existing.owner !== owner.user) {
      throw new Error(`schema ${schema} already exists and is owned by ${existing.owner}, not ${owner.user}: refusing to change it`);
    } else {
      log(`schema ${schema} exists (owner ${owner.user})`);
    }
    await client.query(`REVOKE ALL ON SCHEMA ${S} FROM PUBLIC`);
    await client.query(`GRANT USAGE ON SCHEMA ${S} TO ${A}`);
    log("privileges set: owner owns the schema; service role has USAGE only (tables/sequences come with migration 000)");
    await ensureExtensions(client, log);
  } finally {
    await client.end();
  }
}

module.exports = { provision, parseUrl };

if (require.main === module) {
  require("dotenv").config();
  const env = process.env;
  const config = require("../../src/config");
  provision({
    superuserUrl: env.DATABASE_SUPERUSER_URL,
    ownerUrl: config.database.adminUrl,
    appUrl: config.database.url,
    schema: config.database.schema,
    rotatePasswords: process.argv.includes("--rotate-passwords"),
    ssl: config.database.sslMode === "disable" ? false : { rejectUnauthorized: config.database.sslMode === "require" },
    log: (m) => console.log(m),
  }).then(() => console.log("Provisioning finished."), (err) => { console.error("Provisioning failed:", err.message); process.exit(1); });
}
