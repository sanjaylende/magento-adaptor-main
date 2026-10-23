// Security behaviour of the running adapter (real PostgreSQL + fake Magento): headers, input validation, staff sign-in, SSRF and so on.
// The authentication, replay, expiry and cross-store tests live in platform.e2e.test.js; this file adds the hardening checks.
const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers");

h.useTestEnvironment();

describe("security hardening", () => {
  let fakeMagento, httpServer, db, A, call;
  const BASE = () => `http://127.0.0.1:${h.ADAPTER_PORT}`;

  before(async () => {
    await h.resetDatabase();
    fakeMagento = await h.startFakeMagento();
    const { runMigrations, syncEntityTypes } = require("../src/db/migrate");
    await runMigrations();
    await syncEntityTypes([require("../src/models/VideoSlot"), require("../src/models/VideoVersion"), require("../src/models/StoreSetting")]);
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
    const get = (path, opts) => fetch(BASE() + path, { redirect: "manual", ...opts });

    it("every response hides the framework and sets nosniff, referrer and permissions policies", async () => {
      for (const path of ["/", "/admin/login", "/static/css/app.css", "/api/bootstrap", "/billing/return?gw=icici"]) {
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
      for (const path of ["/admin/login", "/api/bootstrap", "/billing/return?gw=icici"]) {
        const res = await get(path);
        assert.match(res.headers.get("content-security-policy"), /frame-ancestors 'none'/, path);
        assert.equal(res.headers.get("x-frame-options"), "DENY", path);
      }
    });

    it("/.well-known/security.txt says where to report a problem and when the file expires", async () => {
      const res = await get("/.well-known/security.txt");
      assert.equal(res.status, 200);
      assert.ok(res.headers.get("content-type").startsWith("text/plain"));
      const body = await res.text();
      assert.match(body, /^Contact: (mailto:|https:)/m);
      assert.match(body, /^Expires: [0-9]{4}-[0-9]{2}-[0-9]{2}T/m);
    });

    it("an unknown path gets a plain 404 with the full set of security headers and does not echo the path", async () => {
      const res = await get("/robots.txt?x=<script>alert(1)</script>");
      assert.equal(res.status, 404);
      const body = await res.text();
      assert.equal(body, "Not found");
      assert.match(res.headers.get("content-security-policy"), /frame-ancestors 'none'/);
      assert.match(res.headers.get("content-security-policy"), /form-action/);
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    });

    it("production allows photos and videos over https only; development also allows plain http", async () => {
      const config = require("../src/config");
      assert.match((await get("/")).headers.get("content-security-policy"), /img-src [^;]*http:/);
      config.isProduction = true;
      try {
        const csp = (await get("/")).headers.get("content-security-policy");
        assert.doesNotMatch(csp, /img-src[^;]* http:/);
        assert.doesNotMatch(csp, /media-src[^;]* http:/);
        assert.match(csp, /img-src[^;]*https:/);
      } finally { config.isProduction = false; }
    });

    it("API and staff pages are never cached", async () => {
      assert.equal((await get("/api/bootstrap")).headers.get("cache-control"), "no-store");
      assert.equal((await get("/admin/login")).headers.get("cache-control"), "no-store");
    });
  });

  // ---- M3: CORS and cookie policy ----
  describe("M3 CORS and cookies", () => {
    const evil = "https://evil.example";
    it("no cross-origin browser access is granted: no CORS headers on simple requests or on preflight", async () => {
      for (const p of ["/api/bootstrap", "/api/session", "/api/v1/register", "/admin/login", "/", "/static/css/app.css", "/dl/abcdefghijklmnop", "/img/abcdefghijklmnop"]) {
        const res = await fetch(BASE() + p, { headers: { Origin: evil }, redirect: "manual" });
        assert.equal(res.headers.get("access-control-allow-origin"), null, p);
        assert.equal(res.headers.get("access-control-allow-credentials"), null, p);
      }
      const pre = await fetch(BASE() + "/api/session", { method: "OPTIONS", headers: { Origin: evil, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type" } });
      assert.equal(pre.headers.get("access-control-allow-origin"), null);
      assert.equal(pre.headers.get("access-control-allow-headers"), null);
    });

    it("the staff cookie cannot be sent from another site (SameSite=Strict) and is scoped to /admin; no cookie is set by API routes", async () => {
      const api = await h.api("GET", "/api/bootstrap");
      assert.equal(api.headers.get("set-cookie"), null);
      const login = await fetch(`${BASE()}/admin/login`, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "email=staff@test.local&password=staff-password-1" });
      const cookie = login.headers.getSetCookie().find((c) => c.startsWith("fl_admin="));
      assert.match(cookie, /HttpOnly/i);
      assert.match(cookie, /SameSite=Strict/i);
      assert.match(cookie, /Path=\/admin/);
      assert.doesNotMatch(cookie, /Domain=/i, "host-only cookie");
    });

    it("in production the cookie is Secure and HSTS is sent; in development neither", async () => {
      const config = require("../src/config");
      await db.asSystem(() => db.query("DELETE FROM rate_limits"));
      config.isProduction = true;
      try {
        const login = await fetch(`${BASE()}/admin/login`, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "email=staff@test.local&password=staff-password-1" });
        assert.match(login.headers.getSetCookie().find((c) => c.startsWith("fl_admin=")), /; Secure/);
        const res = await fetch(BASE() + "/admin/login");
        assert.equal(res.headers.get("strict-transport-security"), "max-age=31536000; includeSubDomains");
      } finally { config.isProduction = false; }
      assert.equal((await fetch(BASE() + "/admin/login")).headers.get("strict-transport-security"), null);
    });
  });

  // ---- M5: database least privilege ----
  describe("M5 database roles", () => {
    it("the running service connects as a role without superuser, BYPASSRLS, CREATEDB or CREATEROLE", async () => {
      const { rows: [role] } = await db.query("SELECT current_user AS name, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = current_user");
      assert.equal(role.name, "adapter_app");
      assert.deepEqual([role.rolsuper, role.rolbypassrls, role.rolcreatedb, role.rolcreaterole], [false, false, false, false]);
    });

    it("row-level security is on for every tenant table, and without a tenant context the service sees no tenant rows", async () => {
      const { rows } = await db.asSystem(() => db.query(
        `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname IN ('eav_entity', 'store_subscriptions', 'payment_orders', 'invoices', 'credit_ledger', 'usage_events')`));
      assert.ok(rows.length >= 5, "the tenant tables exist");
      for (const t of rows) assert.equal(t.relrowsecurity, true, `${t.relname} has row-level security`);
      // no tenant and no system context: nothing is visible
      const raw = await db.query("SELECT count(*)::int AS n FROM payment_orders");
      assert.equal(raw.rows[0].n, 0);
    });

    it("the application role cannot change the schema", async () => {
      await assert.rejects(() => db.query("CREATE TABLE should_not_exist (id int)"), /permission denied/);
      await assert.rejects(() => db.query("DROP TABLE stores"), /must be owner|permission denied/);
    });
  });

  // ---- M4: request limits ----
  describe("M4 request and connection limits", () => {
    it("the HTTP server has header, request and keep-alive limits", () => {
      const server = require("../src/app").createServer();
      assert.equal(server.headersTimeout, 15000);
      assert.equal(server.requestTimeout, 30000);
      assert.equal(server.keepAliveTimeout, 5000);
    });

    it("a body above the route's own limit is answered 413 (session 4 KB, checkout 2 KB, generate 128 KB), above 1 MB by the parser", async () => {
      const big = (n) => ({ launch: "x".repeat(n) });
      assert.equal((await h.api("POST", "/api/session", { body: big(10 * 1024) })).status, 413);
      assert.equal((await call("POST", "/api/billing/checkout", { currency: "USD", kind: "plan", tier: "x".repeat(3000) })).status, 413);
      assert.equal((await call("POST", "/api/generate", { uniqueTag: "magento-1-novariant", videoType: "hero_product", prompt: "x".repeat(200 * 1024) })).status, 413);
      const huge = await h.api("POST", "/api/session", { body: big(2 * 1024 * 1024) });
      assert.equal(huge.status, 413);
    });

    it("oversized request headers are refused", async () => {
      const res = await fetch(BASE() + "/api/bootstrap", { headers: { "X-Padding": "a".repeat(40 * 1024) } }).catch((err) => ({ status: 0, error: err }));
      assert.ok(res.status === 431 || res.status === 0, `expected 431 or a closed connection, got ${res.status}`);
    });
  });

  // ---- H7: callbacks, replay, webhook secret ----
  describe("H7 callbacks and webhooks", () => {
    let config;
    before(() => { config = require("../src/config"); });
    const postJson = (p, body, headers = {}) => fetch(BASE() + p, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

    it("the ICICI callback is limited to the configured source addresses (and checks the signature either way)", async () => {
      const saved = config.payment.icici.callbackAllowedIps;
      try {
        config.payment.icici.callbackAllowedIps = [];
        const open = await postJson("/api/payments/callback/icici", { merchantTxnNo: "X", responseCode: "0000", secureHash: "0".repeat(64) });
        assert.notEqual(open.status, 403, "no list configured: not restricted by address");
        config.payment.icici.callbackAllowedIps = ["203.0.113.0/24", "198.51.100.7"];
        const blocked = await postJson("/api/payments/callback/icici", { merchantTxnNo: "X", responseCode: "0000", secureHash: "0".repeat(64) });
        assert.equal(blocked.status, 403, "this machine is not on the list");
        config.payment.icici.callbackAllowedIps = ["203.0.113.0/24", "127.0.0.1"];
        const allowed = await postJson("/api/payments/callback/icici", { merchantTxnNo: "X", responseCode: "0000", secureHash: "0".repeat(64) });
        assert.notEqual(allowed.status, 403);
        assert.equal(allowed.status, 400, "an allowed address still has to present a valid signature");
      } finally { config.payment.icici.callbackAllowedIps = saved; }
    });

    it("replay: the same signed return message used again changes nothing (one invoice, one recorded message)", async () => {
      const order = await call("POST", "/api/billing/checkout", { kind: "plan", tier: "starter", cycle: "monthly", currency: "USD" });
      assert.equal(order.status, 201);
      const txn = new URL(order.body.redirectUrl).searchParams.get("tranCtx");
      h.icici.setResult(txn, "paid");
      const signedForm = new URLSearchParams(h.icici.returnForm(txn, "paid"));
      const returnOnce = () => fetch(`${BASE()}/billing/return?gw=icici`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: signedForm }).then((r) => r.text());
      const first = await returnOnce();
      assert.match(first, /Payment received/);
      for (let i = 0; i < 3; i++) assert.match(await returnOnce(), /Payment received/);
      const invoices = (await db.asSystem(() => db.query("SELECT count(*)::int AS n FROM invoices i JOIN payment_orders o ON o.id = i.order_id WHERE o.merchant_txn_no = $1", [txn]))).rows[0].n;
      assert.equal(invoices, 1, "replays did not issue more invoices");
      const events = (await db.asSystem(() => db.query("SELECT count(*)::int AS n FROM gateway_events e JOIN payment_orders o ON o.id = e.order_id WHERE o.merchant_txn_no = $1 AND e.event_key LIKE 'return:%'", [txn]))).rows[0].n;
      assert.equal(events, 1, "the message was recorded once");
    });

    it("a tampered return message is rejected and does not touch the order", async () => {
      const order = await call("POST", "/api/billing/checkout", { kind: "plan", tier: "starter", cycle: "monthly", currency: "USD" });
      const txn = new URL(order.body.redirectUrl).searchParams.get("tranCtx");
      const forged = await fetch(`${BASE()}/billing/return?gw=icici`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ merchantTxnNo: txn, responseCode: "0000", secureHash: "0".repeat(64) }) });
      assert.match(await forged.text(), /could not verify/i);
      const status = (await db.asSystem(() => db.query("SELECT status FROM payment_orders WHERE merchant_txn_no = $1", [txn]))).rows[0].status;
      assert.notEqual(status, "paid");
    });

    it("the video-engine webhook needs its shared secret when one is configured", async () => {
      const saved = config.videoEngineWebhookSecret;
      try {
        config.videoEngineWebhookSecret = "engine-shared-secret";
        const body = { project_id: "p-123", event: "edited" };
        assert.equal((await postJson("/api/webhooks/video-engine", body)).status, 401);
        assert.equal((await postJson("/api/webhooks/video-engine", body, { "X-Webhook-Secret": "wrong" })).status, 401);
        assert.equal((await postJson("/api/webhooks/video-engine", body, { "X-Webhook-Secret": "engine-shared-secret" })).status, 200);
        config.videoEngineWebhookSecret = "";
        assert.equal((await postJson("/api/webhooks/video-engine", body)).status, 200, "no secret configured: accepted as before");
      } finally { config.videoEngineWebhookSecret = saved; }
    });
  });

  // ---- H4: staff console sign-in (delegated to LTX, see test/fakeLtx.js) ----
  describe("H4 staff console sign-in through LTX, idle timeout, CSRF", () => {
    let config, crypto;
    const post = (path, form, cookie) => fetch(BASE() + path, {
      method: "POST", redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded", ...(cookie ? { Cookie: cookie } : {}) },
      body: new URLSearchParams(form),
    });
    const cookieOf = (res, name) => (res.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith(`${name}=`)) || "");
    const signIn = (email, password) => post("/admin/login", { email, password });

    before(() => {
      config = require("../src/config");
      crypto = require("../src/utils/crypto");
    });
    beforeEach(async () => {
      await db.asSystem(() => db.query("DELETE FROM rate_limits"));
      h.ltx.state.down = false;
      config.admin.idleMinutes = 30;
    });

    it("an LTX superadmin and an admin of this tenant sign in; the console role is 'admin'", async () => {
      for (const [email, password] of [["staff@test.local", "staff-password-1"], ["tenant-admin@test.local", "tenant-password-1"]]) {
        const ok = await signIn(email, password);
        assert.equal(ok.status, 302, email);
        assert.equal(ok.headers.get("location"), "/admin");
        const page = await fetch(`${BASE()}/admin`, { headers: { Cookie: cookieOf(ok, "fl_admin") } });
        assert.equal(page.status, 200);
        assert.match(await page.text(), new RegExp(`${email.replace(".", "\\.")} \\(admin\\)`));
      }
    });

    it("a wrong password, an unknown e-mail, another tenant's admin and a non-admin LTX user all get the same refusal", async () => {
      const attempts = [["staff@test.local", "wrong"], ["ghost@test.local", "wrong"], ["other-admin@test.local", "other-password-1"], ["member@test.local", "member-password-1"]];
      const answers = [];
      for (const [email, password] of attempts) {
        const res = await signIn(email, password);
        assert.equal(res.status, 401, email);
        assert.equal(cookieOf(res, "fl_admin"), "", `no session for ${email}`);
        answers.push(await res.text());
      }
      assert.equal(new Set(answers).size, 1, "nothing in the answer tells these cases apart");
    });

    it("no password is stored: no staff table, not in the cookie, not in the audit log", async () => {
      const exists = (await db.asSystem(() => db.query("SELECT to_regclass('admin_users') AS t"))).rows[0].t;
      assert.equal(exists, null, "the adapter has no staff accounts table");
      const ok = await signIn("staff@test.local", "staff-password-1");
      const cookie = cookieOf(ok, "fl_admin");
      const claims = crypto.verifyToken(cookie.split("=")[1]);
      assert.ok(claims && claims.tok, "the session carries the LTX token");
      assert.doesNotMatch(JSON.stringify(claims), /staff-password-1/);
      const audit = (await db.asSystem(() => db.query("SELECT * FROM audit_log"))).rows;
      assert.ok(audit.some((r) => r.action === "admin.login"));
      assert.doesNotMatch(JSON.stringify(audit), /staff-password-1|wrong/);
    });

    it("the sign-in is forwarded to LTX exactly once", async () => {
      const before = h.ltx.calls.login.length;
      await signIn("tenant-admin@test.local", "tenant-password-1");
      assert.equal(h.ltx.calls.login.length, before + 1);
      assert.deepEqual(h.ltx.calls.login[before], { email: "tenant-admin@test.local", password: "tenant-password-1" });
    });

    it("the session ends the moment LTX revokes the account", async () => {
      const ok = await signIn("tenant-admin@test.local", "tenant-password-1");
      const cookie = cookieOf(ok, "fl_admin");
      assert.equal((await fetch(`${BASE()}/admin`, { headers: { Cookie: cookie }, redirect: "manual" })).status, 200);
      h.ltx.revoke("tenant-admin@test.local");
      const after = await fetch(`${BASE()}/admin`, { headers: { Cookie: cookie }, redirect: "manual" });
      assert.equal(after.status, 302);
      assert.equal(after.headers.get("location"), "/admin/login");
      assert.match(after.headers.getSetCookie().join(";"), /fl_admin=;.*Max-Age=0/, "the cookie is cleared");
    });

    it("when LTX is not reachable, sign-in and open sessions answer 503 and nobody is let in", async () => {
      const ok = await signIn("staff@test.local", "staff-password-1");
      const cookie = cookieOf(ok, "fl_admin");
      h.ltx.state.down = true;
      const login = await signIn("staff@test.local", "staff-password-1");
      assert.equal(login.status, 503);
      assert.equal(cookieOf(login, "fl_admin"), "");
      assert.equal((await fetch(`${BASE()}/admin`, { headers: { Cookie: cookie }, redirect: "manual" })).status, 503);
    });

    it("the session cookie is HttpOnly, SameSite=Strict and limited to /admin", async () => {
      const ok = await signIn("staff@test.local", "staff-password-1");
      const raw = ok.headers.getSetCookie().find((c) => c.startsWith("fl_admin="));
      assert.match(raw, /HttpOnly/);
      assert.match(raw, /SameSite=Strict/);
      assert.match(raw, /Path=\/admin/);
    });

    it("the local two-factor and security pages are gone", async () => {
      const cookie = cookieOf(await signIn("staff@test.local", "staff-password-1"), "fl_admin");
      assert.equal((await fetch(`${BASE()}/admin/security`, { headers: { Cookie: cookie }, redirect: "manual" })).status, 404);
      assert.notEqual((await post("/admin/login/2fa", { code: "123456" })).status, 200);
    });

    it("idle timeout: a session unused for longer than the limit is signed out; an active one is kept and extended", async () => {
      const real = crypto.verifyToken(cookieOf(await signIn("staff@test.local", "staff-password-1"), "fl_admin").split("=")[1]);
      const now = Math.floor(Date.now() / 1000);
      const make = (last) => `fl_admin=${crypto.signToken({ typ: "admin", uid: real.uid, iat: now - 60, last, tok: real.tok }, 3600)}`;
      const stale = await fetch(`${BASE()}/admin`, { headers: { Cookie: make(now - 31 * 60) }, redirect: "manual" });
      assert.equal(stale.status, 302);
      assert.match(stale.headers.get("location"), /^\/admin\/login/);
      const fresh = await fetch(`${BASE()}/admin`, { headers: { Cookie: make(now - 60) }, redirect: "manual" });
      assert.equal(fresh.status, 200);
      assert.match(cookieOf(fresh, "fl_admin"), /^fl_admin=.+/, "cookie re-issued with a new activity time");
    });

    it("a session cookie without an LTX token is refused", async () => {
      const now = Math.floor(Date.now() / 1000);
      const cookie = `fl_admin=${crypto.signToken({ typ: "admin", uid: "u-super", iat: now, last: now }, 3600)}`;
      const res = await fetch(`${BASE()}/admin`, { headers: { Cookie: cookie }, redirect: "manual" });
      assert.equal(res.status, 302);
      assert.equal(res.headers.get("location"), "/admin/login");
    });

    it("a state-changing form without a valid CSRF token is refused", async () => {
      const cookie = cookieOf(await signIn("staff@test.local", "staff-password-1"), "fl_admin");
      assert.equal((await post("/admin/installations/1/status", { status: "suspended" }, cookie)).status, 403);
      assert.equal((await post("/admin/installations/1/status", { status: "suspended", _csrf: "deadbeef" }, cookie)).status, 403);
    });
  });
});
