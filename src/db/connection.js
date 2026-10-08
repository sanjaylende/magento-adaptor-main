// PostgreSQL access with tenant context.
//
// Every query runs under an ambient context (AsyncLocalStorage): { storeId } for a request acting for one store, or
// { bypass: true } for staff, gateway callbacks and scheduled jobs. Before each statement the context is written to the
// session settings app.store_id / app.bypass, which the row-level security policies (migration 007) read. A query with
// no context sees no tenant rows at all.
const { AsyncLocalStorage } = require("async_hooks");
const { Pool, types } = require("pg");
const config = require("../config");

types.setTypeParser(20, (v) => Number(v));        // BIGINT -> number (ids and minor-unit money stay well below 2^53)
types.setTypeParser(1700, (v) => Number(v));      // NUMERIC -> number

const als = new AsyncLocalStorage();
let appPool = null;
let adminPool = null;

const ssl = () => (config.database.ssl ? { rejectUnauthorized: false } : false);

function pool() {
  if (!appPool) appPool = new Pool({ connectionString: config.database.url, ssl: ssl(), max: 10 });
  return appPool;
}

function migrationPool() {
  if (!adminPool) adminPool = new Pool({ connectionString: config.database.adminUrl, ssl: ssl(), max: 2 });
  return adminPool;
}

async function applyContext(client, ctx) {
  await client.query("SELECT set_config('app.store_id', $1, false), set_config('app.bypass', $2, false)", [
    ctx.storeId ? String(ctx.storeId) : "",
    ctx.bypass ? "on" : "",
  ]);
}

// Runs a single statement (or reuses the open transaction's connection).
async function query(sql, params = []) {
  const ctx = als.getStore() || {};
  if (ctx.client) return ctx.client.query(sql, params);
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
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
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
