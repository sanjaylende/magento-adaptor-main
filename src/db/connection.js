// PostgreSQL access with tenant context.
//
// Every query runs under an ambient context (AsyncLocalStorage): { storeId } for a request acting for one store, or
// { bypass: true } for staff, gateway callbacks and scheduled jobs. Before each statement the context is written to the
// session settings app.store_id / app.bypass, which the row-level security policies (migration 007) read. A query with
// no context sees no tenant rows at all.
const { AsyncLocalStorage } = require("async_hooks");
const { Pool, types } = require("pg");
const config = require("../config");
const logger = require("../utils/logger");

types.setTypeParser(20, (v) => Number(v));        // BIGINT -> number (ids and minor-unit money stay well below 2^53)
types.setTypeParser(1700, (v) => Number(v));      // NUMERIC -> number

const als = new AsyncLocalStorage();
let appPool = null;
let adminPool = null;

function ssl() {
  const { sslMode, sslCaFile } = config.database;
  if (sslMode === "disable") return false;
  if (sslMode === "no-verify") {
    logger.warn("DB_SSL=no-verify: the database connection is encrypted but the server certificate is NOT verified");
    // Reviewed: explicit opt-in for local testing only; production start-up refuses DB_SSL=no-verify (src/config/safety.js).
    // nosemgrep: problem-based-packs.insecure-transport.js-node.bypass-tls-verification.bypass-tls-verification
    return { rejectUnauthorized: false };
  }
  return { rejectUnauthorized: true, ...(sslCaFile ? { ca: require("fs").readFileSync(sslCaFile, "utf8") } : {}) };
}

// Settings common to both pools. The schema is a connection STARTUP option (-c search_path=...), so it is in force from the first
// statement of every connection the pool ever opens: there is no moment at which a pooled connection could resolve a name in "public".
function poolSettings(connectionString) {
  return {
    connectionString,
    ssl: ssl(),
    options: `-c search_path=${config.database.schema}`,
    application_name: "magento-adapter",
    connectionTimeoutMillis: 15000,
  };
}

function pool() {
  if (!appPool) {
    appPool = new Pool({ ...poolSettings(config.database.url), max: config.database.poolMax, idleTimeoutMillis: config.database.idleTimeoutMs });
    // An idle connection dropped by the server (restart, failover) emits "error"; unhandled it would kill the process.
    appPool.on("error", (err) => logger.error("PostgreSQL pool error (idle client)", { error: err }));
  }
  return appPool;
}

function migrationPool() {
  if (!adminPool) {
    adminPool = new Pool({ ...poolSettings(config.database.adminUrl), max: 2, idleTimeoutMillis: 10000 });
    adminPool.on("error", (err) => logger.error("PostgreSQL admin pool error (idle client)", { error: err }));
  }
  return adminPool;
}

// The settings are session-level, so a pooled connection keeps them until they are changed. The context a connection currently carries is
// remembered on it, and a statement for the same tenant skips the extra round trip. ANY change is written, including a change to "no
// tenant" (a statement outside every context must see no tenant rows), so a connection can never serve the wrong tenant.
async function applyContext(client, ctx) {
  const storeId = ctx.storeId ? String(ctx.storeId) : "";
  const bypass = ctx.bypass ? "on" : "";
  const key = storeId + "|" + bypass;
  if (client.tenantContextKey === key) return;
  client.tenantContextKey = undefined; // unknown until the statement below has succeeded
  await client.query("SELECT set_config('app.store_id', $1, false), set_config('app.bypass', $2, false)", [storeId, bypass]);
  client.tenantContextKey = key;
}

// One connection runs one statement at a time. pg 8 warns when a second one is started before the first has finished (and pg 9 refuses), which
// is what Promise.all over queries of one transaction does. Statements of a transaction are therefore queued here, in the order they were started.
function onClient(client, sql, params) {
  const run = (client.flipickQueue || Promise.resolve()).then(() => client.query(sql, params));
  client.flipickQueue = run.catch(() => {});
  return run;
}

// Runs a single statement (or reuses the open transaction's connection).
async function query(sql, params = []) {
  const ctx = als.getStore() || {};
  if (ctx.client) return onClient(ctx.client, sql, params);
  const client = await pool().connect();
  try {
    await applyContext(client, ctx);
    return await client.query(sql, params);
  } finally {
    client.release();
  }
}

// Runs fn inside one transaction on one connection. Nested calls join the outer transaction.
async function tx(fn) {
  const ctx = als.getStore() || {};
  if (ctx.client) return fn();
  const client = await pool().connect();
  try {
    await applyContext(client, ctx);
    await client.query("BEGIN");
    const result = await als.run({ ...ctx, client }, fn);
    await onClient(client, "COMMIT");
    return result;
  } catch (err) {
    await onClient(client, "ROLLBACK").catch((rollbackErr) => logger.warn("ROLLBACK failed", { error: rollbackErr.message }));
    throw err;
  } finally {
    client.release();
  }
}

// Context helpers. The context survives into work started from the callback, including background work that outlives
// the HTTP response (the video render loop).
const withStore = (storeId, fn) => als.run({ storeId }, fn);
const asSystem = (fn) => als.run({ bypass: true }, fn);
const currentStoreId = () => (als.getStore() || {}).storeId || null;

async function close() {
  await Promise.all([appPool && appPool.end(), adminPool && adminPool.end()]);
  appPool = adminPool = null;
}

module.exports = { query, tx, withStore, asSystem, currentStoreId, migrationPool, close };
