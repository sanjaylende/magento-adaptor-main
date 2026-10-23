// GET /internal/magento-token/:shop: the one route that hands a store's stored Magento integration token to LTX, behind INTERNAL_API_SECRET.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers");

h.useTestEnvironment();

describe("internal Magento token route", () => {
  let fakeMagento, httpServer, db, config, installationId;
  const SECRET = process.env.INTERNAL_API_SECRET; // the random secret the test environment set for this run (test/helpers.js)
  const HOST = () => `127.0.0.1:${h.MAGENTO_PORT}`;
  const BASE = () => `http://127.0.0.1:${h.ADAPTER_PORT}`;
  const get = (shop, headers = {}) => fetch(`${BASE()}/internal/magento-token/${shop}`, { headers });

  before(async () => {
    await h.resetDatabase();
    fakeMagento = await h.startFakeMagento();
    const { runMigrations } = require("../src/db/migrate");
    await runMigrations();
    db = require("../src/db/connection");
    config = require("../src/config");
    httpServer = require("../src/app").createApp().listen(h.ADAPTER_PORT);
    const r = await h.api("POST", "/api/v1/register", { body: { baseUrl: `http://${HOST()}`, magentoToken: "good-token", merchantName: "Internal Test", contactEmail: "i@test.local", countryCode: "IN" } });
    assert.equal(r.status, 201);
    installationId = (await db.asSystem(() => db.query("SELECT id FROM installations WHERE base_url = $1", [`http://${HOST()}`]))).rows[0].id;
  });

  after(async () => {
    httpServer && httpServer.close();
    fakeMagento && fakeMagento.close();
    await db.close();
  });

  it("refuses a missing, wrong or misnamed secret with 401 and no token", async () => {
    for (const headers of [{}, { "X-Internal-Secret": "wrong" }, { "X-Internal-Secret": SECRET + "x" }, { "X-Webhook-Secret": SECRET }, { Authorization: `Bearer ${SECRET}` }]) {
      const res = await get(HOST(), headers);
      assert.equal(res.status, 401, JSON.stringify(headers));
      assert.doesNotMatch(await res.text(), /good-token/);
    }
    assert.equal((await fetch(`${BASE()}/internal/magento-token/${HOST()}?secret=${SECRET}`)).status, 401, "not accepted in the query string");
  });

  it("with the secret it returns the store's base URL, access token and API version, uncached", async () => {
    const res = await get(HOST(), { "X-Internal-Secret": SECRET });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.deepEqual(await res.json(), { baseUrl: `http://${HOST()}`, accessToken: "good-token", apiVersion: "V1" });
  });

  it("every hand-out is audited, without the token itself", async () => {
    const rows = (await db.asSystem(() => db.query("SELECT * FROM audit_log WHERE action = 'internal.magento_token_issued'"))).rows;
    assert.ok(rows.length >= 1);
    assert.equal(String(rows[0].installation_id), String(installationId));
    assert.doesNotMatch(JSON.stringify(rows), /good-token/);
    assert.ok(!JSON.stringify(rows).includes(SECRET), "the internal secret is not in the audit log either");
  });

  it("an unknown store answers 404 not_installed; a host with a scheme, a path or odd characters is a 400", async () => {
    const unknown = await get("nobody.example.com", { "X-Internal-Secret": SECRET });
    assert.equal(unknown.status, 404);
    assert.deepEqual(await unknown.json(), { error: "not_installed" });
    for (const shop of ["http%3A%2F%2F127.0.0.1", "a.com%2Fshop", "a%20b", "-bad.com", "a.com%00"]) {
      assert.equal((await get(shop, { "X-Internal-Secret": SECRET })).status, 400, shop);
    }
  });

  it("a suspended or uninstalled store stops at once", async () => {
    for (const status of ["suspended", "uninstalled", "active"]) {
      await db.asSystem(() => db.query("UPDATE installations SET status = $2 WHERE id = $1", [installationId, status]));
      const res = await get(HOST(), { "X-Internal-Secret": SECRET });
      assert.equal(res.status, status === "active" ? 200 : 404, status);
    }
  });

  it("a store without a stored token answers 404 not_installed", async () => {
    await db.asSystem(() => db.query("UPDATE installations SET magento_token_enc = NULL WHERE id = $1", [installationId]));
    assert.equal((await get(HOST(), { "X-Internal-Secret": SECRET })).status, 404);
  });

  it("fails closed: with no secret configured nobody gets in, not even with an empty header", async () => {
    const saved = config.internalApiSecret;
    config.internalApiSecret = "";
    try {
      assert.equal((await get(HOST())).status, 401);
      assert.equal((await get(HOST(), { "X-Internal-Secret": "" })).status, 401);
      assert.equal((await get(HOST(), { "X-Internal-Secret": SECRET })).status, 401);
    } finally { config.internalApiSecret = saved; }
  });
});
