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
    await require("../src/services/adminUserService").ensureBootstrapAdmin();
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

  describe("plans, payments and metering (mock gateway)", () => {
    const pay = async (token, redirectUrl, result) => {
      const txn = redirectUrl.split("/mockpay/")[1];
      const done = await fetch(`http://127.0.0.1:${h.ADAPTER_PORT}/mockpay/${txn}/complete`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `result=${result}`, redirect: "manual" });
      assert.equal(done.status, 303);
      const back = await fetch(new URL(done.headers.get("location"), `http://127.0.0.1:${h.ADAPTER_PORT}`));
      return { page: await back.text(), returnUrl: done.headers.get("location") };
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
      const sig = require("../src/payments/MockGateway").sign(txn, "paid");
      await fetch(`http://127.0.0.1:${h.ADAPTER_PORT}/billing/return?gw=mock&txn=${txn}&status=paid&sig=${sig}`);
      await fetch(`http://127.0.0.1:${h.ADAPTER_PORT}/billing/return?gw=mock&txn=${txn}&status=paid&sig=${sig}`);
      const after = await h.api("GET", "/api/billing/history", { token: sessionA1 });
      assert.equal(after.body.orders.find((o) => o.id === orderUsd).invoices.length, 1);
      const { rows } = await db.asSystem(() => db.query("SELECT count(*)::int AS n FROM invoices WHERE order_id = $1", [orderUsd]));
      assert.equal(rows[0].n, 1);
    });

    it("a forged return signature is rejected", async () => {
      const res = await fetch(`http://127.0.0.1:${h.ADAPTER_PORT}/billing/return?gw=mock&txn=ANY&status=paid&sig=${"0".repeat(64)}`);
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
      await pay(sessionA2, made.body.redirectUrl, "pending");
      assert.equal((await h.api("GET", `/api/billing/orders/${made.body.orderId}`, { token: sessionA2 })).body.status, "pending");
      // The bank confirms later: the mock records the outcome, then the poll (or the scheduled job) applies it.
      await db.asSystem(() => db.query("INSERT INTO payment_attempts (order_id, status, response) VALUES ($1, 'mock_paid', '{}')", [made.body.orderId]));
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
      const txn = made.body.redirectUrl.split("/mockpay/")[1];
      await fetch(`http://127.0.0.1:${h.ADAPTER_PORT}/mockpay/${txn}/complete`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "result=paid", redirect: "manual" });
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
