// Which sites may show the app in a frame (CSP frame-ancestors). A store that has JUST connected must be allowed at once: the plugin sends
// it straight back to its admin page, which frames the app, and the adapter's list of allowed sites is cached for a minute.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers");

h.useTestEnvironment();

describe("frame-ancestors of the app page", () => {
  let httpServer, db, tenants, fresh;
  const ORIGIN = "https://new-store.example.test";
  const BASE = () => `http://127.0.0.1:${h.ADAPTER_PORT}`;
  const ancestorsOf = async (query = "") => {
    const res = await fetch(`${BASE()}/${query}`);
    assert.equal(res.status, 200);
    const csp = res.headers.get("content-security-policy") || "";
    return (csp.match(/frame-ancestors ([^;]*)/) || [])[1] || "";
  };

  before(async () => {
    await h.resetDatabase();
    const { runMigrations } = require("../src/db/migrate");
    await runMigrations();
    db = require("../src/db/connection");
    tenants = require("../src/services/tenantService");
    httpServer = require("../src/app").createApp().listen(h.ADAPTER_PORT);
  });

  after(async () => {
    httpServer && httpServer.close();
    await db.close();
  });

  it("a page opened without a launch link lists only the page itself and the registered stores", async () => {
    assert.equal(await ancestorsOf("?embed=1"), "'self'"); // no store is registered yet; this also warms the one-minute cache
  });

  it("a store that connects AFTER the list was cached is still refused without a launch link (the cache is what it is) ...", async () => {
    fresh = await tenants.registerInstallation({ baseUrl: ORIGIN, magentoToken: "tok_test", merchantName: "Just Connected", contactEmail: "j@test.local", countryCode: "IN" });
    assert.doesNotMatch(await ancestorsOf("?embed=1"), /new-store\.example\.test/);
  });

  it("... but its own signed launch link lets it frame the page at once", async () => {
    const launch = h.launchToken({ installKey: fresh.installKey, secret: fresh.secret, websiteId: 1 });
    assert.equal(await ancestorsOf(`?embed=1&launch=${encodeURIComponent(launch)}`), `'self' ${ORIGIN}`);
  });

  it("the launch link is only checked, not used up: the session exchange can still consume it", async () => {
    await db.asSystem(() => db.query("DELETE FROM request_nonces"));
    const launch = h.launchToken({ installKey: fresh.installKey, secret: fresh.secret, websiteId: 1 });
    await ancestorsOf(`?embed=1&launch=${encodeURIComponent(launch)}`);
    const nonces = (await db.asSystem(() => db.query("SELECT count(*)::int AS n FROM request_nonces"))).rows[0].n;
    assert.equal(nonces, 0, "viewing the page does not record the nonce");
  });

  it("a link signed with the wrong secret, an expired link, a link for an unknown store and rubbish add nothing (the page is still served)", async () => {
    const wrongSecret = h.launchToken({ installKey: fresh.installKey, secret: "not-the-secret", websiteId: 1 });
    const expired = h.launchToken({ installKey: fresh.installKey, secret: fresh.secret, websiteId: 1, expiresInSeconds: -30 });
    const unknownStore = h.launchToken({ installKey: "fk_doesnotexist", secret: fresh.secret, websiteId: 1 });
    for (const launch of [wrongSecret, expired, unknownStore, "abc.def", "x", "..", "a".repeat(5000), ""]) {
      assert.doesNotMatch(await ancestorsOf(`?embed=1&launch=${encodeURIComponent(launch)}`), /new-store\.example\.test/, launch.slice(0, 20));
    }
    assert.doesNotMatch(await ancestorsOf("?embed=1&launch=a&launch=b"), /new-store\.example\.test/, "a repeated parameter is not an error");
  });

  it("a suspended or uninstalled store gets no early access", async () => {
    const launch = h.launchToken({ installKey: fresh.installKey, secret: fresh.secret, websiteId: 1 });
    for (const status of ["suspended", "uninstalled"]) {
      await db.asSystem(() => db.query("UPDATE installations SET status = $2 WHERE id = $1", [fresh.installationId, status]));
      tenants.invalidateInstallation(fresh.installKey);
      assert.doesNotMatch(await ancestorsOf(`?embed=1&launch=${encodeURIComponent(launch)}`), /new-store\.example\.test/, status);
    }
  });

  it("a store's launch link never adds another store's address", async () => {
    await db.asSystem(() => db.query("UPDATE installations SET status = 'active' WHERE id = $1", [fresh.installationId]));
    tenants.invalidateInstallation(fresh.installKey);
    const other = await tenants.registerInstallation({ baseUrl: "https://other-store.example.test", magentoToken: "tok_other", merchantName: "Other", contactEmail: "o@test.local", countryCode: "IN" });
    const launch = h.launchToken({ installKey: fresh.installKey, secret: fresh.secret, websiteId: 1 });
    const list = await ancestorsOf(`?embed=1&launch=${encodeURIComponent(launch)}`);
    assert.match(list, /new-store\.example\.test/);
    assert.doesNotMatch(list, /other-store\.example\.test/, `other store (${other.installKey}) is not in this list while the cache is fresh`);
  });
});
