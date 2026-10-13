// RATE_LIMIT_SCALE is a load-test aid: it raises every budget outside production and is ignored in production.
const test = require("node:test");
const assert = require("node:assert/strict");

// Loads the middleware fresh with a stubbed database, so no real database is needed.
function limitHeader(env) {
  const saved = { NODE_ENV: process.env.NODE_ENV, RATE_LIMIT_SCALE: process.env.RATE_LIMIT_SCALE };
  Object.assign(process.env, env);
  const connPath = require.resolve("../src/db/connection");
  const mwPath = require.resolve("../src/middleware/rateLimit");
  const oldConn = require.cache[connPath];
  require.cache[connPath] = { id: connPath, filename: connPath, loaded: true, exports: { query: async () => ({ rows: [{ hits: 1 }] }), asSystem: (fn) => fn() } };
  delete require.cache[mwPath];
  try {
    const { rateLimit } = require("../src/middleware/rateLimit");
    const mw = rateLimit({ name: "t", limit: 10, key: () => "who" });
    const headers = {};
    const res = { set: (k, v) => { headers[k] = v; }, status() { return this; }, json() {} };
    return new Promise((resolve, reject) => mw({ path: "/x" }, res, (err) => (err ? reject(err) : resolve(headers["X-RateLimit-Limit"]))));
  } finally {
    delete require.cache[mwPath];
    if (oldConn) require.cache[connPath] = oldConn; else delete require.cache[connPath];
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test("the budget is unchanged by default", async () => {
  assert.equal(await limitHeader({ NODE_ENV: "test", RATE_LIMIT_SCALE: "" }), "10");
});
test("RATE_LIMIT_SCALE multiplies the budget outside production", async () => {
  assert.equal(await limitHeader({ NODE_ENV: "test", RATE_LIMIT_SCALE: "1000" }), "10000");
});
test("RATE_LIMIT_SCALE is ignored in production", async () => {
  assert.equal(await limitHeader({ NODE_ENV: "production", RATE_LIMIT_SCALE: "1000" }), "10");
});
