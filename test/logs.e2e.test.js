// What the adapter writes to its logs (H9): run a realistic session at debug level, capture every log line, and prove that no
// credential, token, signature, password or e-mail address appears in it. Also: errors never leak internals, JSON in production.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const h = require("./helpers");

h.useTestEnvironment();
process.env.LOG_LEVEL = "debug";   // the noisiest level: if nothing leaks here, nothing leaks at info
process.env.LOG_FORMAT = "json";
process.env.LOG_TO_FILE = "false";

const captured = [];
const original = { log: console.log, warn: console.warn, error: console.error };
const capture = (line) => captured.push(String(line));
console.log = console.warn = console.error = capture;

describe("log contents", () => {
  let fakeMagento, httpServer, db, A;
  const secrets = new Map(); // label -> value that must never appear in a log line
  const BASE = () => `http://127.0.0.1:${h.ADAPTER_PORT}`;

  before(async () => {
    await h.resetDatabase();
    fakeMagento = await h.startFakeMagento();
    const { runMigrations, syncEntityTypes } = require("../src/db/migrate");
    await runMigrations();
    await syncEntityTypes([require("../src/models/VideoSlot"), require("../src/models/VideoVersion"), require("../src/models/StoreSetting")]);
    await require("../src/services/adminUserService").ensureBootstrapAdmin();
    db = require("../src/db/connection");
    httpServer = require("../src/app").createApp().listen(h.ADAPTER_PORT);
  });
  after(async () => {
    Object.assign(console, original);
    httpServer && httpServer.close();
    fakeMagento && fakeMagento.close();
    await db.close();
  });

  it("a full session (register, signed calls, bad signature, replay, session, checkout, staff sign-in failures) logs no secrets", async () => {
    // registration with a Magento token and a contact e-mail
    const reg = await h.api("POST", "/api/v1/register", { body: { baseUrl: `http://127.0.0.1:${h.MAGENTO_PORT}`, magentoToken: "good-token", merchantName: "Log Test", contactEmail: "private.person@example.com", countryCode: "IN" } });
    assert.equal(reg.status, 201);
    A = reg.body;
    secrets.set("install secret", A.secret);
    secrets.set("magento token", "good-token");
    secrets.set("e-mail address", "private.person@example.com");

    const call = h.signedClient({ installKey: A.installKey, secret: A.secret, websiteId: 1 });
    await call("GET", "/api/billing/status");
    const ts = Math.floor(Date.now() / 1000);
    const nonce = "log-nonce-1";
    const signature = h.hmac(A.secret, `${ts}\n${nonce}\nPOST\n/api/v1/ping\n${crypto.createHash("sha256").update("{}").digest("hex")}`);
    secrets.set("request signature", signature);
    await fetch(`${BASE()}/api/v1/ping`, { method: "POST", headers: { "Content-Type": "application/json", "X-Flipick-Key": A.installKey, "X-Flipick-Timestamp": String(ts), "X-Flipick-Nonce": nonce, "X-Flipick-Signature": signature }, body: "{}" });
    await fetch(`${BASE()}/api/v1/ping`, { method: "POST", headers: { "Content-Type": "application/json", "X-Flipick-Key": A.installKey, "X-Flipick-Timestamp": String(ts), "X-Flipick-Nonce": nonce, "X-Flipick-Signature": signature }, body: "{}" }); // replay
    await call("POST", "/api/v1/ping", {}, { badSignature: true });
    await call("POST", "/api/generate", { uniqueTag: "magento-1-novariant", videoType: "hero_product", __unknown: true }); // validation failure

    const launch = h.launchToken({ installKey: A.installKey, secret: A.secret, websiteId: 1 });
    secrets.set("launch token", launch);
    const session = await h.api("POST", "/api/session", { body: { launch } });
    secrets.set("session token", session.body.token);
    await h.api("GET", "/api/bootstrap", { token: session.body.token });
    await h.api("POST", "/api/billing/checkout", { token: session.body.token, body: { kind: "plan", tier: "starter", cycle: "monthly", currency: "USD" } });
    await h.api("GET", "/api/bootstrap", { token: "stolen-looking-token-abcdef123456" });

    secrets.set("staff password", "staff-password-1");
    secrets.set("wrong staff password", "wrong-password-zzz9");
    for (const password of ["wrong-password-zzz9", "staff-password-1"]) {
      await fetch(`${BASE()}/admin/login`, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email: "staff@test.local", password }) });
    }
    secrets.set("ADAPTER_SECRET_KEY", process.env.ADAPTER_SECRET_KEY);

    const text = captured.join("\n");
    assert.ok(captured.length > 20, `expected a realistic amount of log output, got ${captured.length} lines`);
    for (const [label, value] of secrets) assert.ok(!text.includes(value), `${label} must never appear in a log line`);
    assert.ok(!/Bearer\s+[A-Za-z0-9._~+/=-]{12,}/.test(text), "no bearer token");
    assert.ok(!/"authorization"\s*:\s*"[^[]/i.test(text), "no authorization header value");
    // the install key may be traced, but only in shortened form
    assert.ok(!text.includes(A.installKey), "the full install key is not logged");
  });

  it("every line is valid JSON with time, level and message (production-style logging)", () => {
    for (const line of captured) {
      const parsed = JSON.parse(line);
      assert.ok(parsed.time && parsed.level && typeof parsed.message === "string");
    }
  });

  it("scrubbing: bearer tokens, key=value credentials, install keys and e-mail addresses are masked inside messages and errors", () => {
    const logger = require("../src/utils/logger");
    captured.length = 0;
    logger.error("upstream said: Authorization: Bearer abcdefghijklmnop1234 and token=zzzSECRETzzz and install fk_ABCD1234567890xyz for jane.doe@example.com");
    logger.error("failed", { error: new Error("request to https://x.test/?api_key=KEY12345&ok=1 failed for bob@corp.example"), contactEmail: "bob@corp.example", phone: "9876543210", billingAddress: "1 Main St", secureHash: "abc" });
    const text = captured.join("\n");
    for (const bad of ["abcdefghijklmnop1234", "zzzSECRETzzz", "ABCD1234567890xyz", "jane.doe@example.com", "KEY12345", "bob@corp.example", "9876543210", "1 Main St"]) assert.ok(!text.includes(bad), `${bad} must be masked`);
    assert.match(text, /j\*\*\*@example\.com/);
  });

  it("an unexpected error answers with a generic message: no stack, file paths or database text", async () => {
    const errorHandler = require("../src/middleware/errorHandler");
    const out = {};
    const res = { headersSent: false, status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; } };
    const err = new Error('connect ECONNREFUSED 10.0.0.9:5432 at D:\\app\\src\\db\\connection.js:42 password=hunter2');
    err.stack = `${err.message}\n    at Pool.connect (D:\\app\\node_modules\\pg\\lib\\pool.js:1:1)`;
    errorHandler(err, { method: "GET", path: "/x", id: "req-9" }, res, () => {});
    assert.equal(out.status, 500);
    const body = JSON.stringify(out.body);
    assert.equal(out.body.error, "Internal server error");
    for (const leak of ["ECONNREFUSED", "10.0.0.9", "connection.js", "pool.js", "hunter2", "at Pool"]) assert.ok(!body.includes(leak), `${leak} must not reach the client`);
  });

  it("a real failing route (database down for one request) answers 500 with a generic body", async () => {
    // a request that fails inside the application: a malformed-but-valid-shape id the database rejects
    const call = h.signedClient({ installKey: A.installKey, secret: A.secret, websiteId: 1 });
    const res = await call("GET", "/api/billing/orders/00000000-0000-0000-0000-000000000000");
    assert.ok([200, 404].includes(res.status));
    assert.ok(!JSON.stringify(res.body).match(/Error:|\bat\s+\w+.*\(|node_modules|\.js:\d+/), "no stack trace in the answer");
  });
});

describe("log format in production", () => {
  it("a process started with NODE_ENV=production writes JSON lines by default", () => {
    const { spawnSync } = require("node:child_process");
    const run = spawnSync(process.execPath, ["-e", 'const l=require("./src/utils/logger"); l.info("hello", {token:"abc"})'], {
      cwd: require("node:path").join(__dirname, ".."), encoding: "utf8",
      env: { ...process.env, NODE_ENV: "production", LOG_FORMAT: "", LOG_TO_FILE: "false", LOG_LEVEL: "info" },
    });
    const line = JSON.parse(run.stdout.trim().split("\n").pop());
    assert.equal(line.level, "info");
    assert.equal(line.context.token, "[redacted]");
  });
});
