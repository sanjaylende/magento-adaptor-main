// perTenant counts the installation budget and the store budget in ONE statement (they used to be two round trips per request), with the
// same limits and the same answers as the two separate limiters.
const test = require("node:test");
const assert = require("node:assert/strict");

function load(hitsByBucket) {
  const statements = [];
  const connPath = require.resolve("../src/db/connection");
  const mwPath = require.resolve("../src/middleware/rateLimit");
  const oldConn = require.cache[connPath];
  require.cache[connPath] = { id: connPath, filename: connPath, loaded: true, exports: {
    asSystem: (fn) => fn(),
    query: async (sql, params) => { statements.push({ sql, params }); return { rows: params.slice(1).map((bucket) => ({ bucket, hits: hitsByBucket[bucket] || 1 })) }; },
  } };
  delete require.cache[mwPath];
  const { perTenant } = require("../src/middleware/rateLimit");
  const restore = () => { delete require.cache[mwPath]; if (oldConn) require.cache[connPath] = oldConn; else delete require.cache[connPath]; };
  return { perTenant, statements, restore };
}
function run(mw, req) {
  const headers = {}; let status = null; let body = null; let nextCalled = false;
  const res = { set: (k, v) => { headers[k] = v; }, status(c) { status = c; return this; }, json(b) { body = b; } };
  return mw(req, res, (err) => { if (err) throw err; nextCalled = true; }).then(() => ({ headers, status, body, nextCalled }));
}
const req = { path: "/x", installation: { id: 3 }, store: { id: 9 } };

test("both budgets are counted in one statement, buckets in a fixed order", async () => {
  const { perTenant, statements, restore } = load({});
  const out = await run(perTenant(600, "store", 300), req);
  restore();
  assert.equal(statements.length, 1);
  assert.match(statements[0].sql, /INSERT INTO rate_limits/);
  assert.deepEqual(statements[0].params.slice(1), ["inst:3", "store:9"]);
  assert.equal(out.nextCalled, true);
  assert.equal(out.headers["X-RateLimit-Limit"], "300", "the headers describe the store budget, as before");
  assert.equal(out.headers["X-RateLimit-Remaining"], "299");
});

test("over the installation budget answers 429 with Retry-After", async () => {
  const { perTenant, restore } = load({ "inst:3": 601 });
  const out = await run(perTenant(600, "store", 300), req);
  restore();
  assert.equal(out.status, 429);
  assert.equal(out.nextCalled, false);
  assert.match(out.body.error, /Too many requests/);
  assert.ok(Number(out.headers["Retry-After"]) >= 1);
});

test("over the store budget answers 429", async () => {
  const { perTenant, restore } = load({ "store:9": 301 });
  const out = await run(perTenant(600, "store", 300), req);
  restore();
  assert.equal(out.status, 429);
  assert.equal(out.nextCalled, false);
});

test("exactly at the budget is still allowed", async () => {
  const { perTenant, restore } = load({ "inst:3": 600, "store:9": 300 });
  const out = await run(perTenant(600, "store", 300), req);
  restore();
  assert.equal(out.nextCalled, true);
});

test("a request with no installation or store is not counted", async () => {
  const { perTenant, statements, restore } = load({});
  const out = await run(perTenant(600, "store", 300), { path: "/x" });
  restore();
  assert.equal(statements.length, 0);
  assert.equal(out.nextCalled, true);
});
