// End-to-end tests of the multi-tenant platform against a real PostgreSQL database (docker compose up -d) and a fake Magento.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers");

h.useTestEnvironment();

describe("platform", () => {
  let fakeMagento, httpServer, db, billing, payments, tenants, ctx;
  let A, B; // two installations: { installKey, secret, stores }
  let sessionA1, sessionA2, sessionB1;

  const ctxFor = async (installation, websiteId) => {
    const store = await tenants.getStore(installation.installationId, websiteId);
    return { installation, store, magento: { baseUrl: "http://127.0.0.1:" + h.MAGENTO_PORT, accessToken: "good-token" } };
  };

  before(async () => {
    await h.resetDatabase();
    fakeMagento = await h.startFakeMagento();
    const { runMigrations, syncEntityTypes } = require("../src/db/migrate");
    await runMigrations();
    await syncEntityTypes([require("../src/models/VideoSlot"), require("../src/models/VideoVersion"), require("../src/models/StoreSetting")]);
    db = require("../src/db/connection");
    billing = require("../src/services/billingService");
    payments = require("../src/services/paymentService");
    tenants = require("../src/services/tenantService");
    ctx = require("../src/context");
    httpServer = require("../src/app").createApp().listen(h.ADAPTER_PORT);
  });

  after(async () => {
    httpServer && httpServer.close();
    fakeMagento && fakeMagento.close();
    await db.close();
  });

  describe("onboarding", () => {
    it("rejects a registration whose Magento token does not work", async () => {
      const r = await h.api("POST", "/api/v1/register", { body: { baseUrl: `http://127.0.0.1:${h.MAGENTO_PORT}`, magentoToken: "bad" } });
      assert.equal(r.status, 400);
    });

    it("registers an installation and creates a store per website (not Magento's admin website)", async () => {
      const r = await h.api("POST", "/api/v1/register", { body: { baseUrl: `http://127.0.0.1:${h.MAGENTO_PORT}`, magentoToken: "good-token", merchantName: "Acme Foods", contactEmail: "a@acme.test", countryCode: "IN", magentoVersion: "2.4.9", extensionVersion: "1.0.0" } });
      assert.equal(r.status, 201);
      assert.deepEqual(r.body.stores.map((s) => s.websiteId), ["1", "2"]);
      assert.match(r.body.installKey, /^fk_/);
      A = { ...r.body };
      A.installationId = (await tenants.getInstallationByKey(A.installKey)).id;
    });

    it("registers a second, separate installation (second merchant)", async () => {
      // Same fake Magento reached through a different host name = a different installation.
      const r = await h.api("POST", "/api/v1/register", { body: { baseUrl: `http://localhost:${h.MAGENTO_PORT}`, magentoToken: "good-token", merchantName: "Beta Goods", contactEmail: "b@beta.test", countryCode: "US" } });
      assert.equal(r.status, 201);
      B = { ...r.body };
      B.installationId = (await tenants.getInstallationByKey(B.installKey)).id;
      assert.notEqual(A.installKey, B.installKey);
    });

    it("re-registering the same store rotates credentials and the old secret stops working", async () => {
      const again = await h.api("POST", "/api/v1/register", { body: { baseUrl: `http://127.0.0.1:${h.MAGENTO_PORT}`, magentoToken: "good-token", merchantName: "Acme Foods" } });
      const oldCall = h.signedClient({ installKey: A.installKey, secret: A.secret });
      assert.equal((await oldCall("POST", "/api/v1/ping", {})).status, 401);
      A = { ...again.body, installationId: A.installationId };
      assert.equal((await h.signedClient({ installKey: A.installKey, secret: A.secret })("POST", "/api/v1/ping", {})).status, 200);
    });
  });

  describe("authentication", () => {
    it("rejects bad signatures, stale timestamps and replayed nonces", async () => {
      const call = h.signedClient({ installKey: A.installKey, secret: A.secret });
      assert.equal((await call("POST", "/api/v1/ping", {}, { badSignature: true })).status, 401);
      assert.equal((await call("POST", "/api/v1/ping", {}, { ts: Math.floor(Date.now() / 1000) - 3600 })).status, 401);
      const nonce = "same-nonce-1";
      assert.equal((await call("POST", "/api/v1/ping", {}, { nonce })).status, 200);
      assert.equal((await call("POST", "/api/v1/ping", {}, { nonce })).status, 401);
    });

    it("rejects a signature made for a different path or body", async () => {
      const call = h.signedClient({ installKey: A.installKey, secret: A.secret, websiteId: 1 });
      const ok = await call("GET", "/api/billing/status");
      assert.equal(ok.status, 200);
      // Same signature, tampered path: build the request by hand.
      const ts = Math.floor(Date.now() / 1000);
      const sig = h.hmac(A.secret, `${ts}\nn-tamper\nGET\n/api/billing/status\n${require("crypto").createHash("sha256").update("").digest("hex")}`);
      const res = await fetch(`http://127.0.0.1:${h.ADAPTER_PORT}/api/billing/history`, { headers: { "X-Flipick-Key": A.installKey, "X-Flipick-Timestamp": String(ts), "X-Flipick-Nonce": "n-tamper", "X-Flipick-Signature": sig, "X-Flipick-Website": "1" } });
      assert.equal(res.status, 401);
    });

    it("exchanges a launch token once for a browser session", async () => {
      const launch = h.launchToken({ installKey: A.installKey, secret: A.secret, websiteId: 1 });
      const first = await h.api("POST", "/api/session", { body: { launch } });
      assert.equal(first.status, 200);
      sessionA1 = first.body.token;
      assert.equal((await h.api("POST", "/api/session", { body: { launch } })).status, 401, "launch tokens are single use");
      assert.equal((await h.api("POST", "/api/session", { body: { launch: h.launchToken({ installKey: A.installKey, secret: A.secret, websiteId: 1, expiresInSeconds: -5 }) } })).status, 401);
      assert.equal((await h.api("POST", "/api/session", { body: { launch: h.launchToken({ installKey: A.installKey, secret: "wrong", websiteId: 1 }) } })).status, 401);
      sessionA2 = (await h.api("POST", "/api/session", { body: { launch: h.launchToken({ installKey: A.installKey, secret: A.secret, websiteId: 2 }) } })).body.token;
      sessionB1 = (await h.api("POST", "/api/session", { body: { launch: h.launchToken({ installKey: B.installKey, secret: B.secret, websiteId: 1 }) } })).body.token;
    });

    it("refuses data requests without a session", async () => {
      assert.equal((await h.api("GET", "/api/bootstrap")).status, 401);
      assert.equal((await h.api("GET", "/api/bootstrap", { token: "garbage" })).status, 401);
    });
  });

  describe("stores", () => {
    it("shows each website only its own products", async () => {
      const a1 = await h.api("GET", "/api/bootstrap", { token: sessionA1 });
      const a2 = await h.api("GET", "/api/bootstrap", { token: sessionA2 });
      assert.deepEqual(a1.body.products.map((p) => p.name), ["Apples"]);
      assert.deepEqual(a2.body.products.map((p) => p.name), ["Pears"]);
      assert.equal(a1.body.billing.currentPlan, "trial");
    });

    it("the line under \"Select products\" is the website name only, without the store address", async () => {
      const a1 = await h.api("GET", "/api/bootstrap", { token: sessionA1 });
      const a2 = await h.api("GET", "/api/bootstrap", { token: sessionA2 });
      assert.equal(a1.body.storeUrl, "Main Website");
      assert.equal(a2.body.storeUrl, "EU Website");
      assert.ok(!a1.body.storeUrl.includes("http") && !a1.body.storeUrl.includes("·"));
    });

    it("a new store starts on its own trial with its own counters", async () => {
      await ctx.runWithTenant(await ctxFor(A, 1), async () => {
        await db.query("SELECT 1");
        await billing.recordVideoCompleted(101, "hero_product");
      });
      const a1 = await h.api("GET", "/api/billing/status", { token: sessionA1 });
      const a2 = await h.api("GET", "/api/billing/status", { token: sessionA2 });
      assert.equal(a1.body.freeVideosUsed, 1);
      assert.equal(a2.body.freeVideosUsed, 0);
    });
  });

  describe("health check", () => {
    it("answers 200 ok to anyone, without a session", async () => {
      const res = await fetch(`http://127.0.0.1:${h.ADAPTER_PORT}/health`);
      assert.equal(res.status, 200);
      assert.equal(await res.text(), "ok");
      assert.match(res.headers.get("content-type"), /^text\/plain/);
    });
  });

  describe("catalog change signal (extension to adapter)", () => {
    const call = (body, creds = A) => h.signedClient({ installKey: creds.installKey, secret: creds.secret })("POST", "/api/v1/catalog-changed", body);
    const synced = async (installation, websiteId) => ctx.runWithTenant(await ctxFor(installation, websiteId), async () => require("../src/services/productService").syncedAt());
    const load = async (token) => h.api("GET", "/api/bootstrap", { token });

    it("drops the cached catalog of the named websites only", async () => {
      await load(sessionA1); await load(sessionA2);
      assert.ok(await synced(A, 1) && await synced(A, 2), "both websites have a cached catalog");
      const r = await call({ websiteIds: [1], reason: "product saved" });
      assert.equal(r.status, 200);
      assert.deepEqual({ ok: r.body.ok, invalidated: r.body.invalidated }, { ok: true, invalidated: 1 });
      assert.equal(await synced(A, 1), null, "website 1 will be refetched");
      assert.ok(await synced(A, 2), "website 2 is untouched");
    });

    it("with no website named, every website of the installation is dropped, and never another installation's", async () => {
      await load(sessionA1); await load(sessionA2); await load(sessionB1);
      const r = await call({});
      assert.equal(r.status, 200);
      assert.equal(r.body.invalidated, 2);
      assert.equal(await synced(A, 1), null);
      assert.equal(await synced(A, 2), null);
      assert.ok(await synced(B, 1), "the other installation keeps its cache");
    });

    it("needs a valid signature and a known body: unsigned, wrong secret, unknown field and a bad website id are refused", async () => {
      const url = `http://127.0.0.1:${h.ADAPTER_PORT}/api/v1/catalog-changed`;
      assert.equal((await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 401);
      assert.equal((await call({}, { installKey: A.installKey, secret: "not-the-secret" })).status, 401);
      assert.equal((await call({ websiteIds: [1], surprise: true })).status, 400);
      assert.equal((await call({ websiteIds: ["1; DROP TABLE stores"] })).status, 400);
      assert.equal((await call({ websiteIds: Array.from({ length: 101 }, (_, i) => i) })).status, 400);
      assert.equal((await call({ websiteIds: [] })).status, 400, "an empty list is refused: leave websiteIds out to mean every website");
    });

    it("keeps the cached products and only marks them stale, so a changed price still carries a product's videos to its new tag", async () => {
      await load(sessionA1);
      const productService = require("../src/services/productService");
      const count = await ctx.runWithTenant(await ctxFor(A, 1), async () => productService.list().length);
      assert.ok(count > 0);
      assert.equal((await call({ websiteIds: [1] })).status, 200);
      const after = await ctx.runWithTenant(await ctxFor(A, 1), async () => ({ n: productService.list().length, at: productService.syncedAt() }));
      assert.equal(after.n, count, "the products are still there to compare with the fresh list");
      assert.equal(after.at, null, "but they are stale");
      await load(sessionA1);
      assert.ok(await synced(A, 1), "the next read fetches the catalog again");
    });
  });

  describe("stills picker: product photos and uploads", () => {
    const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
    const upload = (token, body, { uniqueTag = "magento-1-novariant", type = "image/png", filename = "photo.png" } = {}) => fetch(
      `http://127.0.0.1:${h.ADAPTER_PORT}/api/upload-still-image?uniqueTag=${encodeURIComponent(uniqueTag)}&filename=${encodeURIComponent(filename)}`,
      { method: "POST", headers: { "Content-Type": type, Authorization: `Bearer ${token}` }, body }
    );

    it("lists the product's real photos: the real address for the engine, a proxied one for the browser", async () => {
      await h.api("GET", "/api/bootstrap", { token: sessionA1 });
      const r = await h.api("GET", "/api/product-images/magento-1-novariant", { token: sessionA1 });
      assert.equal(r.status, 200);
      assert.ok(r.body.images.length >= 1);
      assert.match(r.body.images[0].url, /^https?:\/\//);
      assert.match(r.body.images[0].displayUrl, /^\/img\//);
      assert.equal(r.body.images[0].source, "real");
      assert.equal((await h.api("GET", "/api/product-images/nope-1", { token: sessionA1 })).status, 404);
      assert.equal((await h.api("GET", "/api/product-images/magento-1-novariant")).status, 401, "needs a session");
    });

    it("uploads an image, hosts it behind a signed link, and serves it only as an image", async () => {
      const res = await upload(sessionA1, PNG);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.match(body.url, /\/up\/[A-Za-z0-9_.-]+$/);
      assert.match(body.displayUrl, /^\/up\//);
      const got = await fetch(`http://127.0.0.1:${h.ADAPTER_PORT}${body.displayUrl}`);
      assert.equal(got.status, 200);
      assert.equal(got.headers.get("content-type"), "image/png");
      assert.equal(got.headers.get("x-content-type-options"), "nosniff");
      assert.deepEqual(Buffer.from(await got.arrayBuffer()), PNG);
      assert.equal((await fetch(`http://127.0.0.1:${h.ADAPTER_PORT}/up/not-a-real-token-at-all`)).status, 404);
      const tampered = body.displayUrl.slice(0, -3) + "AAA";
      assert.equal((await fetch(`http://127.0.0.1:${h.ADAPTER_PORT}${tampered}`)).status, 404);
    });

    it("refuses what is not a real image, an empty body, and an unknown product", async () => {
      assert.equal((await upload(sessionA1, Buffer.from("<html><script>alert(1)</script></html>"), { type: "image/png", filename: "evil.png" })).status, 415);
      assert.equal((await upload(sessionA1, Buffer.from("%PDF-1.7 not an image at all"), { type: "image/jpeg" })).status, 415);
      assert.equal((await upload(sessionA1, Buffer.alloc(0))).status, 400);
      assert.equal((await upload(sessionA1, PNG, { uniqueTag: "nope-1" })).status, 404);
      assert.equal((await upload("garbage", PNG)).status, 401);
    });

    it("an upload belongs to its store: another store's session cannot list or use it, and rows are isolated", async () => {
      const mine = await (await upload(sessionA1, PNG)).json();
      const { rows } = await db.asSystem(() => db.query("SELECT store_id FROM uploaded_images WHERE id = $1", [JSON.parse(Buffer.from(mine.displayUrl.split("/up/")[1].split(".")[0], "base64url").toString()).id]));
      assert.equal(rows.length, 1);
      const otherStore = await tenants.getStore(B.installationId, 1);
      const seen = await db.withStore(otherStore.id, async () => (await db.query("SELECT id FROM uploaded_images")).rows.length);
      assert.equal(seen, 0, "row-level security hides it from another store");
    });

    it("a photo uploaded for a product is offered again for that product only, newest first, for 8 days", async () => {
      const boot = await h.api("GET", "/api/bootstrap", { token: sessionA1 });
      const other = boot.body.products.find((p) => p.uniqueTag !== "magento-1-novariant");
      const first = await (await upload(sessionA1, PNG, { filename: "first.png" })).json();
      const second = await (await upload(sessionA1, PNG, { filename: "second.png" })).json();
      const listed = (await h.api("GET", "/api/product-images/magento-1-novariant", { token: sessionA1 })).body.images;
      const ups = listed.filter((i) => i.uploaded);
      assert.ok(ups.length >= 2);
      assert.deepEqual(ups.slice(0, 2).map((i) => i.name), ["second.png", "first.png"], "newest first");
      assert.match(ups[0].displayUrl, /^\/up\//);
      assert.match(ups[0].url, /\/up\/[A-Za-z0-9_.-]+$/);
      assert.equal((await fetch(`http://127.0.0.1:${h.ADAPTER_PORT}${ups[1].displayUrl}`)).status, 200, "the listed link serves the image");
      assert.ok(listed.findIndex((i) => i.uploaded) >= listed.filter((i) => !i.uploaded).length, "the store's own photos come first");
      assert.ok(first.url && second.url);
      if (other) {
        const o = (await h.api("GET", `/api/product-images/${other.uniqueTag}`, { token: sessionA1 })).body.images;
        assert.equal(o.filter((i) => i.uploaded).length, 0, "another product does not get them");
      }
      // another store whose product has the same tag must not see them (the query is scoped to the store, not only protected by row-level security)
      const o2 = await h.api("GET", "/api/product-images/magento-1-novariant", { token: sessionB1 });
      assert.ok(o2.status === 200 || o2.status === 404);
      if (o2.status === 200) assert.equal(o2.body.images.filter((i) => i.uploaded).length, 0, "another store gets none of them");
      // older than the 8 days the scheduler keeps: no longer offered
      await db.asSystem(() => db.query("UPDATE uploaded_images SET created_at = now() - interval '9 days' WHERE filename = 'first.png'"));
      const after = (await h.api("GET", "/api/product-images/magento-1-novariant", { token: sessionA1 })).body.images.filter((i) => i.uploaded).map((i) => i.name);
      assert.ok(!after.includes("first.png") && after.includes("second.png"));
    });

  });

  describe("a product's uniqueTag changes (the variant that supplies its price changes)", () => {
    it("the current version says how many versions the slot has, also after an older one is restored", async () => {
      const videoVersions = require("../src/repositories/VideoVersionRepository");
      await ctx.runWithTenant(await ctxFor(A, 1), async () => {
        const v1 = await videoVersions.allocateVersion("magento-902-1", "hero_product", { status: "ready", aspectRatio: "16:9" });
        await videoVersions.allocateVersion("magento-902-1", "hero_product", { status: "ready", aspectRatio: "16:9" });
        const restored = await videoVersions.setCurrentVersion("magento-902-1", "hero_product", v1.id);
        assert.equal(restored.versionNo, 1);
        assert.equal(restored.versionCount, 2, "Version 1 is current but the history link still has something to show");
        // a preview that was never rendered is not in the history window, so it is not counted either
        await videoVersions.allocateVersion("magento-902-1", "hero_product", { status: "candidates", aspectRatio: "16:9" });
        const again = await videoVersions.setCurrentVersion("magento-902-1", "hero_product", v1.id);
        assert.equal(again.versionCount, 2, "previews are not counted");
      });
    });

    it("its videos move to the new tag, keep their history, and a type that already exists under the new tag is left alone", async () => {
      const videoVersions = require("../src/repositories/VideoVersionRepository");
      const generatedState = require("../src/services/generatedState");
      const oldTag = "magento-900-111", newTag = "magento-900-222";
      await ctx.runWithTenant(await ctxFor(A, 1), async () => {
        await generatedState.ensureLoaded();
        const hero = await videoVersions.allocateVersion(oldTag, "hero_product", { status: "ready", aspectRatio: "16:9" });
        await videoVersions.allocateVersion(oldTag, "lifestyle", { status: "ready", aspectRatio: "16:9" });
        const newerLifestyle = await videoVersions.allocateVersion(newTag, "lifestyle", { status: "ready", aspectRatio: "16:9" });
        const moved = await videoVersions.remapUniqueTag(oldTag, newTag);
        assert.deepEqual(moved, ["hero_product"], "lifestyle already existed under the new tag, so it is not overwritten");
        const history = await videoVersions.listVersions(newTag, "hero_product");
        assert.equal(history.length, 1);
        assert.equal(history[0].id, hero.id);
        assert.equal((await videoVersions.listVersions(oldTag, "hero_product")).length, 0);
        assert.equal((await videoVersions.listVersions(newTag, "lifestyle"))[0].id, newerLifestyle.id, "the newer video under the new tag is the one kept");
        assert.equal((await videoVersions.listVersions(oldTag, "lifestyle")).length, 1, "the old lifestyle video stays as an orphan");
        assert.deepEqual(await videoVersions.remapUniqueTag(oldTag, oldTag), [], "same tag: nothing to do");
        assert.deepEqual(await videoVersions.remapUniqueTag(oldTag, newTag), [], "already moved: nothing to do");
        // the in-memory mirror follows
        generatedState.set(generatedState.genKey(oldTag, "hero_product"), { status: "ready", id: hero.id });
        generatedState.rename(generatedState.genKey(oldTag, "hero_product"), generatedState.genKey(newTag, "hero_product"));
        assert.equal(generatedState.get(generatedState.genKey(oldTag, "hero_product")), undefined);
        assert.equal(generatedState.get(generatedState.genKey(newTag, "hero_product")).id, hero.id);
      });
    });
  });

  describe("abandoned starting-frame picks (candidates)", () => {
    it("loading the app discards a pick that was never finished: back to the last real video, or the slot is removed", async () => {
      const videoVersions = require("../src/repositories/VideoVersionRepository");
      const generatedState = require("../src/services/generatedState");
      const { genKey, mergeVersion } = generatedState;
      const withReady = "magento-910-1", candidatesOnly = "magento-910-2", generating = "magento-910-3";
      let readyId, genId;
      await ctx.runWithTenant(await ctxFor(A, 2), async () => {
        await generatedState.ensureLoaded();
        const ready = await videoVersions.allocateVersion(withReady, "hero_product", { status: "ready", aspectRatio: "16:9" });
        readyId = ready.id;
        mergeVersion(genKey(withReady, "hero_product"), ready);
        mergeVersion(genKey(withReady, "hero_product"), await videoVersions.allocateVersion(withReady, "hero_product", { status: "candidates", aspectRatio: "16:9" }));
        mergeVersion(genKey(candidatesOnly, "lifestyle"), await videoVersions.allocateVersion(candidatesOnly, "lifestyle", { status: "candidates", aspectRatio: "16:9" }));
        const g = await videoVersions.allocateVersion(generating, "lifestyle", { status: "generating", aspectRatio: "16:9" });
        genId = g.id;
        mergeVersion(genKey(generating, "lifestyle"), g);
        assert.equal(generatedState.get(genKey(withReady, "hero_product")).status, "candidates");
      });
      const r = await h.api("GET", "/api/bootstrap", { token: sessionA2 });
      assert.equal(r.status, 200);
      assert.equal(r.body.generated[`${withReady}::hero_product`].status, "ready", "falls back to the earlier real video");
      assert.equal(r.body.generated[`${withReady}::hero_product`].currentVersionId, readyId);
      assert.equal(r.body.generated[`${candidatesOnly}::lifestyle`], undefined, "a slot that only had a pending pick is removed");
      assert.equal(r.body.generated[`${generating}::lifestyle`].currentVersionId, genId, "a render in progress is never touched");
      assert.equal(r.body.generated[`${generating}::lifestyle`].status, "generating");
      await ctx.runWithTenant(await ctxFor(A, 2), async () => {
        assert.equal((await videoVersions.listVersions(withReady, "hero_product")).length, 1, "the pending version is deleted from the database");
        assert.equal((await videoVersions.listVersions(candidatesOnly, "lifestyle")).length, 0);
      });
    });

    it("the discard route (used by Cancel) answers with the slot's resulting state, and only acts on the caller's own store", async () => {
      const videoVersions = require("../src/repositories/VideoVersionRepository");
      const generatedState = require("../src/services/generatedState");
      const tag = "magento-911-1";
      let pendingId;
      await ctx.runWithTenant(await ctxFor(A, 2), async () => {
        await generatedState.ensureLoaded();
        const v = await videoVersions.allocateVersion(tag, "hero_product", { status: "candidates", aspectRatio: "16:9" });
        pendingId = v.id;
        generatedState.mergeVersion(generatedState.genKey(tag, "hero_product"), v);
      });
      const other = await h.api("POST", `/api/generated/${tag}/hero_product/discard-candidates`, { token: sessionB1, body: { versionId: pendingId } });
      assert.equal(other.status, 200);
      await ctx.runWithTenant(await ctxFor(A, 2), async () => {
        assert.equal((await videoVersions.listVersions(tag, "hero_product")).length, 1, "another store cannot discard it");
      });
      const mine = await h.api("POST", `/api/generated/${tag}/hero_product/discard-candidates`, { token: sessionA2, body: { versionId: pendingId } });
      assert.equal(mine.status, 200);
      assert.deepEqual(mine.body, { ok: true, current: null });
      await ctx.runWithTenant(await ctxFor(A, 2), async () => {
        assert.equal((await videoVersions.listVersions(tag, "hero_product")).length, 0);
      });
    });
  });

  describe("tenant isolation", () => {
    it("row-level security hides other stores' rows even from a query with no store filter", async () => {
      const sA1 = await tenants.getStore(A.installationId, 1);
      const sB1 = await tenants.getStore(B.installationId, 1);
      const seenByA = await db.withStore(sA1.id, async () => (await db.query("SELECT DISTINCT store_id FROM store_subscriptions")).rows.map((r) => r.store_id));
      assert.deepEqual(seenByA, [sA1.id]);
      const seenByB = await db.withStore(sB1.id, async () => (await db.query("SELECT DISTINCT store_id FROM store_subscriptions")).rows.map((r) => r.store_id));
      assert.deepEqual(seenByB, [sB1.id]);
      const noContext = (await db.query("SELECT * FROM store_subscriptions")).rows;
      assert.equal(noContext.length, 0, "a query with no tenant context sees nothing");
    });

    it("cannot write a row for another store", async () => {
      const sA1 = await tenants.getStore(A.installationId, 1);
      const sB1 = await tenants.getStore(B.installationId, 1);
      await assert.rejects(() => db.withStore(sA1.id, () => db.query("INSERT INTO credit_ledger (store_id, amount_usd_cents, kind) VALUES ($1, 100, 'manual')", [sB1.id])), /row-level security/);
    });

    it("a session for one store cannot see another store's order", async () => {
      const made = await h.api("POST", "/api/billing/checkout", { token: sessionB1, body: { kind: "plan", tier: "starter", cycle: "monthly", currency: "USD" } });
      assert.equal(made.status, 201);
      assert.equal((await h.api("GET", `/api/billing/orders/${made.body.orderId}`, { token: sessionA1 })).status, 404);
      assert.equal((await h.api("GET", `/api/billing/orders/${made.body.orderId}`, { token: sessionB1 })).status, 200);
    });
  });

  describe("plans, payments and metering (fake ICICI bank)", () => {
    const pay = async (token, redirectUrl, result) => {
      const txn = new URL(redirectUrl).searchParams.get("tranCtx");
      return { page: await h.icici.pay(`http://127.0.0.1:${h.ADAPTER_PORT}`, txn, result), txn };
    };
    let orderUsd, subA1;

    it("the trial gate closes after 5 free videos and returns the Shopify-style 402 reason", async () => {
      await ctx.runWithTenant(await ctxFor(A, 1), async () => {
        for (let i = 102; i < 106; i++) await billing.recordVideoCompleted(i, "image_transition");
        assert.equal(await billing.checkGenerationAllowed("hero_product"), "trial_exhausted");
      });
      // Through the HTTP API the same gate answers 402 with the reason code the UI maps to its Plans window.
      const blocked = await h.api("POST", "/api/generate", { token: sessionA1, body: { uniqueTag: "magento-1-novariant", videoType: "hero_product", aspectRatio: "16:9" } });
      assert.equal(blocked.status, 402);
      assert.equal(blocked.body.error, "trial_exhausted");
    });

    it("a successful payment activates the plan, applies no GST to USD, and issues an invoice", async () => {
      const made = await h.api("POST", "/api/billing/checkout", { token: sessionA1, body: { kind: "plan", tier: "starter", cycle: "monthly", currency: "USD" } });
      assert.equal(made.status, 201);
      orderUsd = made.body.orderId;
      assert.equal(made.body.totalMinor, 2750);
      const { page } = await pay(sessionA1, made.body.redirectUrl, "paid");
      assert.match(page, /Payment received/);
      const st = await h.api("GET", "/api/billing/status", { token: sessionA1 });
      assert.equal(st.body.currentPlan, "starter");
      assert.equal(st.body.subscriptionStatus, "active");
      assert.equal(st.body.cycleValueUsedCents, 0);
      subA1 = st.body;
      const hist = await h.api("GET", "/api/billing/history", { token: sessionA1 });
      assert.equal(hist.body.orders[0].status, "paid");
      assert.equal(hist.body.orders[0].invoices.length, 1);
      const link = await h.api("GET", `/api/billing/invoices/${hist.body.orders[0].invoices[0].id}/link`, { token: sessionA1 });
      const inv = await fetch(`http://127.0.0.1:${h.ADAPTER_PORT}${link.body.url}`);
      assert.equal(inv.status, 200);
      assert.match(await inv.text(), /Tax invoice/);
    });

    it("the same payment confirmed twice (browser return replayed) changes nothing", async () => {
      const hist = await h.api("GET", "/api/billing/history", { token: sessionA1 });
      const order = hist.body.orders.find((o) => o.id === orderUsd);
      const txn = order.merchantTxnNo;
      const form = new URLSearchParams(h.icici.returnForm(txn, "paid"));
      const repost = () => fetch(`http://127.0.0.1:${h.ADAPTER_PORT}/billing/return?gw=icici`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form });
      await repost();
      await repost();
      const after = await h.api("GET", "/api/billing/history", { token: sessionA1 });
      assert.equal(after.body.orders.find((o) => o.id === orderUsd).invoices.length, 1);
      const { rows } = await db.asSystem(() => db.query("SELECT count(*)::int AS n FROM invoices WHERE order_id = $1", [orderUsd]));
      assert.equal(rows[0].n, 1);
    });

    it("a forged return signature is rejected", async () => {
      const forged = new URLSearchParams({ merchantTxnNo: "ANY", responseCode: "0000", secureHash: "0".repeat(64) });
      const res = await fetch(`http://127.0.0.1:${h.ADAPTER_PORT}/billing/return?gw=icici`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: forged });
      assert.match(await res.text(), /could not verify/i);
    });

    it("the plan's budget is spent per video type and the next video is blocked without credit", async () => {
      await ctx.runWithTenant(await ctxFor(A, 1), async () => {
        // $27.50 budget: 5 x $5.50 = $27.50 fits exactly; the sixth does not.
        for (let i = 0; i < 5; i++) await billing.recordVideoCompleted(200 + i, "lifestyle");
        assert.equal(await billing.checkGenerationAllowed("lifestyle"), "usage_cap_reached");
        const sub = await billing.getSubscription();
        assert.equal(sub.cycleValueUsedCents, 2750);
      });
    });

    it("a repeated completion of the same video is only counted once", async () => {
      await ctx.runWithTenant(await ctxFor(A, 1), async () => {
        await billing.recordVideoCompleted(200, "lifestyle");
        assert.equal((await billing.getSubscription()).cycleValueUsedCents, 2750);
      });
    });

    it("a credit top-up lets the store generate again, and credit is drawn once per video", async () => {
      const made = await h.api("POST", "/api/billing/checkout", { token: sessionA1, body: { kind: "topup", packUsdCents: 1000, currency: "USD" } });
      assert.equal(made.status, 201);
      await pay(sessionA1, made.body.redirectUrl, "paid");
      const st = await h.api("GET", "/api/billing/status", { token: sessionA1 });
      assert.equal(st.body.creditCents, 1000);
      await ctx.runWithTenant(await ctxFor(A, 1), async () => {
        assert.equal(await billing.checkGenerationAllowed("hero_product"), null);
        await billing.recordVideoCompleted(300, "hero_product");
        await billing.recordVideoCompleted(300, "hero_product");
        assert.equal(await billing.creditBalance(), 450);
      });
    });

    it("a declined payment leaves the plan untouched and is shown in history", async () => {
      const before = await h.api("GET", "/api/billing/status", { token: sessionA2 });
      const made = await h.api("POST", "/api/billing/checkout", { token: sessionA2, body: { kind: "plan", tier: "pro", cycle: "annual", currency: "USD" } });
      const { page } = await pay(sessionA2, made.body.redirectUrl, "failed");
      assert.match(page, /Payment not completed/);
      const after = await h.api("GET", "/api/billing/status", { token: sessionA2 });
      assert.equal(after.body.currentPlan, before.body.currentPlan);
      const hist = await h.api("GET", "/api/billing/history", { token: sessionA2 });
      assert.equal(hist.body.orders[0].status, "failed");
      assert.match(hist.body.orders[0].failureReason, /declined/i);
    });

    it("a payment left pending is picked up later by reconciliation once the bank confirms", async () => {
      const made = await h.api("POST", "/api/billing/checkout", { token: sessionA2, body: { kind: "plan", tier: "starter", cycle: "monthly", currency: "USD" } });
      const { txn } = await pay(sessionA2, made.body.redirectUrl, "pending");
      assert.equal((await h.api("GET", `/api/billing/orders/${made.body.orderId}`, { token: sessionA2 })).body.status, "pending");
      // The bank confirms later; the poll (or the scheduled job) then applies it.
      h.icici.setResult(txn, "paid");
      assert.equal((await h.api("GET", `/api/billing/orders/${made.body.orderId}`, { token: sessionA2 })).body.status, "paid");
      assert.equal((await h.api("GET", "/api/billing/status", { token: sessionA2 })).body.currentPlan, "starter");
    });

    it("INR orders to an Indian merchant carry 18% GST on the order and invoice", async () => {
      const made = await h.api("POST", "/api/billing/checkout", { token: sessionA1, body: { kind: "plan", tier: "pro", cycle: "monthly", currency: "INR" } });
      assert.equal(made.body.totalMinor, 699900 + 125982);
      await pay(sessionA1, made.body.redirectUrl, "paid");
      const hist = await h.api("GET", "/api/billing/history", { token: sessionA1 });
      const order = hist.body.orders.find((o) => o.id === made.body.orderId);
      assert.equal(order.taxMinor, 125982);
      assert.equal(order.invoices[0].totalMinor, 699900 + 125982);
    });

    it("a US merchant pays no GST even in INR", async () => {
      const made = await h.api("POST", "/api/billing/checkout", { token: sessionB1, body: { kind: "plan", tier: "starter", cycle: "monthly", currency: "INR" } });
      assert.equal(made.body.totalMinor, 229900);
    });

    it("the same Idempotency-Key replays the first order instead of creating another", async () => {
      const call = h.signedClient({ installKey: A.installKey, secret: A.secret, websiteId: 2 });
      const body = { kind: "topup", packUsdCents: 2500, currency: "USD" };
      const one = await call("POST", "/api/billing/checkout", body, { headers: { "Idempotency-Key": "idem-1" } });
      const two = await call("POST", "/api/billing/checkout", body, { headers: { "Idempotency-Key": "idem-1" } });
      assert.equal(one.status, 201);
      assert.equal(two.body.orderId, one.body.orderId);
      assert.equal(two.headers.get("idempotent-replay"), "true");
      const different = await call("POST", "/api/billing/checkout", { ...body, packUsdCents: 1000 }, { headers: { "Idempotency-Key": "idem-1" } });
      assert.equal(different.status, 422);
    });

    it("refunds a plan payment: credit note issued, order marked refunded, plan ended", async () => {
      const { rows: [order] } = await db.asSystem(() => db.query("SELECT * FROM payment_orders WHERE id = $1", [orderUsd]));
      await payments.refundOrder({ orderId: orderUsd, amountMinor: order.total_minor, reason: "Customer request", entitlementAction: "cancel_plan", actor: { type: "staff", id: "t@test" } });
      await payments.settleProcessingRefunds(); // ICICI accepts a refund first; its final answer is read afterwards
      const after = await h.api("GET", "/api/billing/history", { token: sessionA1 });
      const o = after.body.orders.find((x) => x.id === orderUsd);
      assert.equal(o.status, "refunded");
      assert.equal(o.refunds[0].status, "succeeded");
      assert.ok(o.invoices.some((i) => i.kind === "credit_note" && i.totalMinor === -2750));
      await assert.rejects(() => payments.refundOrder({ orderId: orderUsd, amountMinor: 100, reason: "again", actor: { type: "staff", id: "t@test" } }), /Only paid orders/);
    });

    it("cannot refund more than was paid", async () => {
      const made = await h.api("POST", "/api/billing/checkout", { token: sessionB1, body: { kind: "topup", packUsdCents: 1000, currency: "USD" } });
      await pay(sessionB1, made.body.redirectUrl, "paid");
      await assert.rejects(() => payments.refundOrder({ orderId: made.body.orderId, amountMinor: 1001, reason: "too much", actor: { type: "staff", id: "t@test" } }), /more than what was paid/);
      await payments.refundOrder({ orderId: made.body.orderId, amountMinor: 400, reason: "partial", entitlementAction: "remove_credit", actor: { type: "staff", id: "t@test" } });
      await payments.settleProcessingRefunds(); // ICICI accepts a refund first; its final answer is read afterwards
      const st = await h.api("GET", "/api/billing/status", { token: sessionB1 });
      assert.equal(st.body.creditCents, 600);
    });

    it("an expired plan is blocked after the grace period and active during it", async () => {
      await db.asSystem(() => db.query("UPDATE store_subscriptions SET period_end = now() - interval '1 day' WHERE store_id = (SELECT id FROM stores WHERE installation_id = $1 AND external_id = '2')", [A.installationId]));
      await ctx.runWithTenant(await ctxFor(A, 2), async () => {
        assert.equal(await billing.checkGenerationAllowed("image_transition"), null, "within the 3-day grace period");
        await db.query("UPDATE store_subscriptions SET period_end = now() - interval '10 days' WHERE store_id = $1", [(await tenants.getStore(A.installationId, 2)).id]);
        assert.equal(await billing.checkGenerationAllowed("image_transition"), "subscription_inactive");
      });
    });
  });

  describe("cancel plan", () => {
    it("drops the store back to the free plan at once, keeping used free videos and credit, and cannot be repeated", async () => {
      const made = await h.api("POST", "/api/billing/checkout", { token: sessionB1, body: { kind: "plan", tier: "starter", cycle: "monthly", currency: "USD" } });
      await h.icici.pay(`http://127.0.0.1:${h.ADAPTER_PORT}`, new URL(made.body.redirectUrl).searchParams.get("tranCtx"), "paid");
      assert.equal((await h.api("GET", `/api/billing/orders/${made.body.orderId}`, { token: sessionB1 })).body.status, "paid");
      const before = (await h.api("GET", "/api/billing/status", { token: sessionB1 })).body;
      assert.equal(before.currentPlan, "starter");

      const cancelled = await h.api("POST", "/api/billing/cancel", { token: sessionB1 });
      assert.equal(cancelled.status, 200);
      assert.equal(cancelled.body.currentPlan, "trial");
      assert.equal(cancelled.body.subscriptionStatus, "active");
      assert.equal(cancelled.body.periodEnd, null);
      assert.equal(cancelled.body.freeVideosUsed, before.freeVideosUsed);
      assert.equal(cancelled.body.creditCents, before.creditCents);

      assert.equal((await h.api("POST", "/api/billing/cancel", { token: sessionB1 })).status, 400);
      // The paid order stays paid (a refund is a separate, staff-initiated step).
      const hist = await h.api("GET", "/api/billing/history", { token: sessionB1 });
      assert.equal(hist.body.orders.find((o) => o.id === made.body.orderId).status, "paid");
    });
  });

  describe("rate limiting", () => {
    it("answers 429 with Retry-After once a store's expensive budget is spent", async () => {
      let limited;
      for (let i = 0; i < 45 && !limited; i++) { // 45 > two windows of 20, so a window rollover mid-test cannot hide the limit
        const r = await h.api("POST", "/api/preview-images", { token: sessionB1, body: { uniqueTag: "nope", videoType: "lifestyle" } });
        if (r.status === 429) limited = r;
      }
      assert.ok(limited, "expected a 429");
      assert.ok(Number(limited.headers.get("retry-after")) >= 1);
    });
  });

  describe("staff console", () => {
    let cookie, csrf;
    it("rejects wrong passwords and requires login for pages", async () => {
      assert.equal((await fetch(`http://127.0.0.1:${h.ADAPTER_PORT}/admin`, { redirect: "manual" })).status, 302);
      const bad = await fetch(`http://127.0.0.1:${h.ADAPTER_PORT}/admin/login`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "email=staff@test.local&password=wrong" });
      assert.equal(bad.status, 401);
    });

    it("signs in and every page renders", async () => {
      const ok = await fetch(`http://127.0.0.1:${h.ADAPTER_PORT}/admin/login`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "email=staff@test.local&password=staff-password-1", redirect: "manual" });
      assert.equal(ok.status, 302);
      cookie = ok.headers.get("set-cookie").split(";")[0];
      for (const path of ["/admin", "/admin/merchants", "/admin/stores", "/admin/payments", "/admin/refunds", "/admin/plans", "/admin/audit"]) {
        const r = await fetch(`http://127.0.0.1:${h.ADAPTER_PORT}${path}`, { headers: { cookie } });
        assert.equal(r.status, 200, path);
      }
      const { rows: [store] } = await db.asSystem(() => db.query("SELECT id FROM stores WHERE installation_id = $1 ORDER BY id LIMIT 1", [A.installationId]));
      const page = await fetch(`http://127.0.0.1:${h.ADAPTER_PORT}/admin/stores/${store.id}`, { headers: { cookie } });
      assert.equal(page.status, 200);
      csrf = (await page.text()).match(/name="_csrf" value="([^"]+)"/)[1];
    });

    it("rejects a state-changing post without the csrf token, accepts it with", async () => {
      const { rows: [store] } = await db.asSystem(() => db.query("SELECT id FROM stores WHERE installation_id = $1 ORDER BY id LIMIT 1", [A.installationId]));
      const url = `http://127.0.0.1:${h.ADAPTER_PORT}/admin/stores/${store.id}/credit`;
      const headers = { cookie, "Content-Type": "application/x-www-form-urlencoded" };
      assert.equal((await fetch(url, { method: "POST", headers, body: "usd=5&note=x", redirect: "manual" })).status, 403);
      const ok = await fetch(url, { method: "POST", headers, body: `usd=5&note=goodwill&_csrf=${csrf}`, redirect: "manual" });
      assert.equal(ok.status, 302);
      const bal = await db.asSystem(() => billing.creditBalance(store.id));
      assert.equal(bal, 450 + 500);
    });
  });
});
