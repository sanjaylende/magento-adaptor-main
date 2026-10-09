// Security behaviour of the running adapter (real PostgreSQL + fake Magento): headers, input validation, lock-out, SSRF and so on.
// The authentication, replay, expiry and cross-store tests live in platform.e2e.test.js; this file adds the hardening checks.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers");

h.useTestEnvironment();

describe("security hardening", () => {
  let fakeMagento, httpServer, db, A, call;

  before(async () => {
    await h.resetDatabase();
    fakeMagento = await h.startFakeMagento();
    const { runMigrations, syncEntityTypes } = require("../src/db/migrate");
    await runMigrations();
    await syncEntityTypes([require("../src/models/VideoSlot"), require("../src/models/VideoVersion"), require("../src/models/StoreSetting")]);
    await require("../src/services/adminUserService").ensureBootstrapAdmin();
    db = require("../src/db/connection");
    httpServer = require("../src/app").createApp().listen(h.ADAPTER_PORT);
    const r = await h.api("POST", "/api/v1/register", { body: { baseUrl: `http://127.0.0.1:${h.MAGENTO_PORT}`, magentoToken: "good-token", merchantName: "Sec Test", contactEmail: "s@test.local", countryCode: "IN" } });
    assert.equal(r.status, 201);
    A = r.body;
    call = h.signedClient({ installKey: A.installKey, secret: A.secret, websiteId: 1 });
  });

  after(async () => {
    httpServer && httpServer.close();
    fakeMagento && fakeMagento.close();
    await db.close();
  });

  describe("H1 security headers", () => {
    const get = (path, opts) => fetch(`http://127.0.0.1:${h.ADAPTER_PORT}${path}`, { redirect: "manual", ...opts });

    it("every response hides the framework and sets nosniff, referrer and permissions policies", async () => {
      for (const path of ["/", "/admin/login", "/static/css/app.css", "/api/bootstrap", "/billing/return?gw=mock"]) {
        const res = await get(path);
        assert.equal(res.headers.get("x-powered-by"), null, path);
        assert.equal(res.headers.get("x-content-type-options"), "nosniff", path);
        assert.equal(res.headers.get("referrer-policy"), "no-referrer", path);
        assert.match(res.headers.get("permissions-policy"), /camera=\(\)/, path);
      }
    });

    it("the UI shell can be framed only by registered Magento admins; everything else cannot be framed at all", async () => {
      const shell = (await get("/")).headers.get("content-security-policy");
      assert.match(shell, /frame-ancestors 'self' http:\/\/127\.0\.0\.1:45124/);
      assert.match(shell, /object-src 'none'/);
      assert.equal((await get("/")).headers.get("x-frame-options"), null);
      for (const path of ["/admin/login", "/api/bootstrap", "/billing/return?gw=mock"]) {
        const res = await get(path);
        assert.match(res.headers.get("content-security-policy"), /frame-ancestors 'none'/, path);
        assert.equal(res.headers.get("x-frame-options"), "DENY", path);
      }
    });

    it("API and staff pages are never cached", async () => {
      assert.equal((await get("/api/bootstrap")).headers.get("cache-control"), "no-store");
      assert.equal((await get("/admin/login")).headers.get("cache-control"), "no-store");
    });
  });
});
