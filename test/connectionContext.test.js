// Tenant context on pooled connections: row-level security reads app.store_id / app.bypass from the session, so the context must be
// right for EVERY statement. A connection that already carries the right context is not told again (saves a round trip per statement);
// any change of tenant, including a change to "no tenant", is always written.
const test = require("node:test");
const assert = require("node:assert/strict");

function loadConnection() {
  const log = []; // every statement sent: { client, sql, params }
  const free = [];
  let clients = 0;
  class FakeClient {
    constructor() { this.id = ++clients; }
    async query(sql, params) { log.push({ client: this.id, sql: String(sql), params }); return { rows: [], rowCount: 0 }; }
    release() { free.push(this); }
  }
  class FakePool {
    on() {}
    async connect() { return free.pop() || new FakeClient(); }
    async end() {}
  }
  const pgPath = require.resolve("pg");
  const connPath = require.resolve("../src/db/connection");
  const oldPg = require.cache[pgPath];
  require.cache[pgPath] = { id: pgPath, filename: pgPath, loaded: true, exports: { Pool: FakePool, types: { setTypeParser() {} } } };
  delete require.cache[connPath];
  const db = require("../src/db/connection");
  const restore = () => { delete require.cache[connPath]; if (oldPg) require.cache[pgPath] = oldPg; else delete require.cache[pgPath]; };
  const contexts = () => log.filter((l) => /set_config/.test(l.sql)).map((l) => l.params);
  return { db, log, contexts, restore };
}

test("the same tenant on the same connection sets the context once", async () => {
  const { db, log, contexts, restore } = loadConnection();
  await db.withStore(5, async () => { await db.query("SELECT 1"); await db.query("SELECT 2"); await db.query("SELECT 3"); });
  restore();
  assert.deepEqual(contexts(), [["5", ""]]);
  assert.equal(log.filter((l) => /^SELECT [123]$/.test(l.sql)).length, 3);
});

test("a different tenant on the same connection is always written", async () => {
  const { db, contexts, restore } = loadConnection();
  await db.withStore(5, () => db.query("SELECT 1"));
  await db.withStore(6, () => db.query("SELECT 1"));
  await db.withStore(5, () => db.query("SELECT 1"));
  restore();
  assert.deepEqual(contexts(), [["5", ""], ["6", ""], ["5", ""]]);
});

test("a statement with no tenant after a tenant statement resets the context to nothing", async () => {
  const { db, contexts, restore } = loadConnection();
  await db.withStore(5, () => db.query("SELECT 1"));
  await db.query("SELECT 2"); // no store, not system: must see no tenant rows
  restore();
  assert.deepEqual(contexts(), [["5", ""], ["", ""]]);
});

test("system (bypass) and tenant contexts never leak into each other", async () => {
  const { db, contexts, restore } = loadConnection();
  await db.asSystem(() => db.query("SELECT 1"));
  await db.withStore(7, () => db.query("SELECT 2"));
  await db.asSystem(() => db.query("SELECT 3"));
  restore();
  assert.deepEqual(contexts(), [["", "on"], ["7", ""], ["", "on"]]);
});

test("a transaction writes its context before BEGIN and joins nested calls", async () => {
  const { db, log, restore } = loadConnection();
  await db.withStore(9, () => db.tx(async () => { await db.query("SELECT 1"); await db.tx(async () => { await db.query("SELECT 2"); }); }));
  restore();
  const order = log.map((l) => (/set_config/.test(l.sql) ? "ctx" : l.sql));
  assert.deepEqual(order, ["ctx", "BEGIN", "SELECT 1", "SELECT 2", "COMMIT"]);
});

test("queries started together inside one transaction run one after another on the connection", async () => {
  const { db, restore } = (() => {
    const state = { running: 0, maxRunning: 0 };
    class Client {
      async query(sql) { state.running++; state.maxRunning = Math.max(state.maxRunning, state.running); await new Promise((r) => setTimeout(r, 5)); state.running--; return { rows: [], rowCount: 0 }; }
      release() {}
    }
    class Pool { on() {} async connect() { return new Client(); } async end() {} }
    const pgPath = require.resolve("pg");
    const connPath = require.resolve("../src/db/connection");
    const oldPg = require.cache[pgPath];
    require.cache[pgPath] = { id: pgPath, filename: pgPath, loaded: true, exports: { Pool, types: { setTypeParser() {} } } };
    delete require.cache[connPath];
    const db = require("../src/db/connection");
    db.state = state;
    return { db, restore: () => { delete require.cache[connPath]; if (oldPg) require.cache[pgPath] = oldPg; else delete require.cache[pgPath]; } };
  })();
  await db.withStore(3, () => db.tx(async () => { await Promise.all([db.query("SELECT 1"), db.query("SELECT 2"), db.query("SELECT 3")]); }));
  const max = db.state.maxRunning;
  restore();
  assert.equal(max, 1, "pg 8 only warns about overlapping queries on one client; pg 9 will refuse them");
});
