// A scratch database on the shared PostgreSQL server for tests: dropped and created fresh, with the adapter's own schema and TEST-ONLY roles
// (so the real roles of the adapter are never touched). Needs an administrator URL for the server (a superuser or a role with CREATEDB and
// CREATEROLE): TEST_DATABASE_SUPERUSER_URL in the environment or in the git-ignored .env.test. In CI that is the service container's superuser.
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env.test"), quiet: true });
const { Client } = require("pg");
const { provision } = require("../scripts/db/provision");

const SUPERUSER = process.env.TEST_DATABASE_SUPERUSER_URL || "postgresql://postgres:postgres@127.0.0.1:5432/postgres";
const OWNER = { user: "magento_adapter_test_owner", password: "test-owner-password-not-a-secret" };
const APP = { user: "magento_adapter_test_app", password: "test-app-password-not-a-secret" };
const SCHEMA = "magento_adapter";

function withDatabase(url, database) {
  const u = new URL(url);
  u.pathname = "/" + database;
  return u.toString();
}
const roleUrl = (r, database) => { const u = new URL(SUPERUSER); u.username = r.user; u.password = r.password; u.pathname = "/" + database; return u.toString(); };

// Drops and creates `database`, provisions the schema and the two test roles in it, and returns the URLs the adapter must use.
async function createScratchDatabase(database) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(database)) throw new Error("bad scratch database name");
  const admin = new Client({ connectionString: withDatabase(SUPERUSER, "postgres") });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${database}`);
  } finally {
    await admin.end();
  }
  const urls = { databaseUrl: roleUrl(APP, database), adminUrl: roleUrl(OWNER, database), schema: SCHEMA, appRole: APP.user, ownerRole: OWNER.user };
  await provision({ superuserUrl: withDatabase(SUPERUSER, database), ownerUrl: urls.adminUrl, appUrl: urls.databaseUrl, schema: SCHEMA });
  return urls;
}

// The environment variables the adapter needs to use the scratch database.
const envFor = (database) => ({ DATABASE_URL: roleUrl(APP, database), DATABASE_ADMIN_URL: roleUrl(OWNER, database), DB_SCHEMA: SCHEMA, DB_SSL: "disable" });

module.exports = { createScratchDatabase, envFor, SUPERUSER, SCHEMA };
