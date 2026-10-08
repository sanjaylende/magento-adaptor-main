// Logging and error-handling behaviour: secrets never reach the log, 5xx never leak internals, outbound calls fail with a clear message.
const test = require("node:test");
const assert = require("node:assert/strict");

function capture(fn) {
  const lines = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (l) => lines.push(String(l));
  return Promise.resolve().then(fn).then((r) => ({ r, lines }), (e) => { throw e; }).finally(() => Object.assign(console, orig));
}

test("logger redacts secrets in context objects and in URLs", async () => {
  const logger = require("../src/utils/logger");
  const { lines } = await capture(() => {
    logger.error("boom", { secret: "s3cr3t", token: "t0k", nested: { password: "pw", ok: "visible" }, apiKey: "k" });
    logger.warn("GET https://shop.test/x?consumer_key=ck_1&consumer_secret=cs_2 failed");
  });
  const text = lines.join("\n");
  for (const bad of ["s3cr3t", "t0k", "pw", "ck_1", "cs_2"]) assert.ok(!text.includes(bad), `${bad} must not be logged`);
  assert.match(text, /visible/);
  assert.match(text, /\[redacted\]/);
});

test("an Error in the context is logged with its stack", async () => {
  const logger = require("../src/utils/logger");
  const { lines } = await capture(() => logger.error("failed", { error: new Error("inner problem") }));
  assert.match(lines.join("\n"), /inner problem/);
});

test("error handler: 5xx hides internals, 4xx keeps its message, both carry the request id", async () => {
  const errorHandler = require("../src/middleware/errorHandler");
  const run = (err) => {
    const out = {};
    const res = { headersSent: false, status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; } };
    errorHandler(err, { method: "GET", path: "/x", id: "req-123" }, res, () => {});
    return out;
  };
  const { r: internal } = await capture(() => run(new Error("password authentication failed for user adapter_owner")));
  assert.equal(internal.status, 500);
  assert.equal(internal.body.error, "Internal server error");
  assert.equal(internal.body.requestId, "req-123");
  const { r: client } = await capture(() => run(Object.assign(new Error("Unknown installation"), { status: 404 })));
  assert.equal(client.status, 404);
  assert.equal(client.body.error, "Unknown installation");
  const { r: safe } = await capture(() => run(Object.assign(new Error("db detail"), { status: 502, userMessage: "Try again" })));
  assert.equal(safe.body.error, "Try again");
});

test("outbound calls: a network failure becomes a clear 502 naming the service, and the log has no query string", async () => {
  const { loggedFetch } = require("../src/utils/httpLog");
  const { r, lines } = await capture(async () => {
    try { await loggedFetch("video-engine", "http://127.0.0.1:1/api/x?key=SECRET", { method: "POST", timeoutMs: 2000 }); } catch (e) { return e; }
  });
  assert.equal(r.status, 502);
  assert.match(r.message, /^video-engine request failed/);
  assert.ok(!lines.join("\n").includes("SECRET"));
  assert.match(lines.join("\n"), /video-engine POST 127\.0\.0\.1:1\/api\/x/);
});
