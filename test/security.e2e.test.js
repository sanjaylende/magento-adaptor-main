// Security behaviour of the running adapter (real PostgreSQL + fake Magento): headers, input validation, lock-out, SSRF and so on.
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
    const get = (path, opts) => fetch(BASE() + path, { redirect: "manual", ...opts });

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

  // ---- H4: staff console sign-in ----
  describe("H4 staff console lock-out, two-factor, idle timeout, CSRF", () => {
    const { authenticator } = require("otplib");
    let users, config, crypto;
    const post = (path, form, cookie) => fetch(BASE() + path, {
      method: "POST", redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded", ...(cookie ? { Cookie: cookie } : {}) },
      body: new URLSearchParams(form),
    });
    const cookieOf = (res, name) => (res.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith(`${name}=`)) || "");
    const addStaff = (email, password) => db.asSystem(() => db.query(
      `INSERT INTO admin_users (email, password_hash, role) VALUES ($1, $2, 'admin')
       ON CONFLICT (email) DO UPDATE SET password_hash = $2, failed_attempts = 0, locked_until = NULL, totp_enabled = FALSE, totp_secret = NULL, totp_last_step = 0`,
      [email, users.hashPassword(password)]));
    const idOf = async (email) => (await db.asSystem(() => db.query("SELECT id FROM admin_users WHERE email = $1", [email]))).rows[0].id;

    before(() => {
      users = require("../src/services/adminUserService");
      config = require("../src/config");
      crypto = require("../src/utils/crypto");
    });
    beforeEach(async () => {
      await db.asSystem(() => db.query("DELETE FROM rate_limits"));
      config.admin.require2fa = false;
      config.admin.maxFailedLogins = 3;
      config.admin.idleMinutes = 30;
    });

    it("locks the account after repeated failures; a locked account answers exactly like a wrong password", async () => {
      await addStaff("lock@test.local", "right-password-1");
      const wrong = await post("/admin/login", { email: "lock@test.local", password: "nope" });
      assert.equal(wrong.status, 401);
      const wrongText = await wrong.text();
      await post("/admin/login", { email: "lock@test.local", password: "nope" });
      await post("/admin/login", { email: "lock@test.local", password: "nope" }); // third failure: locked
      const lockedRight = await post("/admin/login", { email: "lock@test.local", password: "right-password-1" });
      assert.equal(lockedRight.status, 401, "correct password refused while locked");
      assert.equal(cookieOf(lockedRight, "fl_admin"), "");
      assert.equal(await lockedRight.text(), wrongText, "same page: nothing reveals the lock");
      const row = (await db.asSystem(() => db.query("SELECT failed_attempts, locked_until FROM admin_users WHERE email = 'lock@test.local'"))).rows[0];
      assert.ok(row.failed_attempts >= 3 && new Date(row.locked_until) > new Date());
      // after the lock time the right password works again
      await db.asSystem(() => db.query("UPDATE admin_users SET locked_until = now() - interval '1 minute' WHERE email = 'lock@test.local'"));
      const ok = await post("/admin/login", { email: "lock@test.local", password: "right-password-1" });
      assert.equal(ok.status, 302);
      assert.match(cookieOf(ok, "fl_admin"), /^fl_admin=.+/);
    });

    it("an unknown e-mail gets the same answer as a wrong password", async () => {
      await addStaff("known@test.local", "right-password-2");
      const a = await post("/admin/login", { email: "known@test.local", password: "wrong" });
      const b = await post("/admin/login", { email: "ghost@test.local", password: "wrong" });
      assert.equal(a.status, b.status);
      assert.equal(await a.text(), await b.text());
    });

    it("the session cookie is HttpOnly, SameSite=Strict and limited to /admin", async () => {
      await addStaff("cookie@test.local", "right-password-3");
      const ok = await post("/admin/login", { email: "cookie@test.local", password: "right-password-3" });
      const raw = ok.headers.getSetCookie().find((c) => c.startsWith("fl_admin="));
      assert.match(raw, /HttpOnly/);
      assert.match(raw, /SameSite=Strict/);
      assert.match(raw, /Path=\/admin/);
    });

    it("two-factor: password alone is not enough, a wrong code is refused, each code works once", async () => {
      await addStaff("tfa@test.local", "right-password-4");
      const id = await idOf("tfa@test.local");
      const { secret } = await users.beginEnrollment(id, "tfa@test.local");
      assert.equal(await users.confirmEnrollment(id, "000000"), false, "enrolment needs a real code");
      assert.equal(await users.confirmEnrollment(id, authenticator.generate(secret)), true);
      const stored = (await db.asSystem(() => db.query("SELECT totp_secret FROM admin_users WHERE id = $1", [id]))).rows[0].totp_secret;
      assert.ok(stored.startsWith("v1:") && !stored.includes(secret), "the secret is stored encrypted");

      const step1 = await post("/admin/login", { email: "tfa@test.local", password: "right-password-4" });
      assert.equal(step1.status, 200);
      assert.equal(cookieOf(step1, "fl_admin"), "", "no session after the password step");
      const pending = cookieOf(step1, "fl_admin_2fa");
      assert.ok(pending);
      assert.equal((await post("/admin/login/2fa", { code: "123456" }, pending)).status, 401);
      // the code used to enrol was already accepted once, so it cannot be used again
      assert.equal((await post("/admin/login/2fa", { code: authenticator.generate(secret) }, pending)).status, 401, "a used code is refused");
      // the code of the next 30-second step is accepted, once
      const next = authenticator.clone({ epoch: Date.now() + 30000 }).generate(secret);
      const ok = await post("/admin/login/2fa", { code: next }, pending);
      assert.equal(ok.status, 302);
      assert.match(cookieOf(ok, "fl_admin"), /^fl_admin=.+/);
      assert.equal((await post("/admin/login/2fa", { code: next }, pending)).status, 401, "replaying the accepted code fails");
    });

    it("wrong two-factor codes count towards the lock-out", async () => {
      await addStaff("tfalock@test.local", "right-password-5");
      const id = await idOf("tfalock@test.local");
      const { secret } = await users.beginEnrollment(id, "tfalock@test.local");
      await users.confirmEnrollment(id, authenticator.generate(secret));
      const step1 = await post("/admin/login", { email: "tfalock@test.local", password: "right-password-5" });
      const pending = cookieOf(step1, "fl_admin_2fa");
      for (let i = 0; i < 3; i++) await post("/admin/login/2fa", { code: "111111" }, pending);
      const row = (await db.asSystem(() => db.query("SELECT locked_until FROM admin_users WHERE id = $1", [id]))).rows[0];
      assert.ok(row.locked_until && new Date(row.locked_until) > new Date(), "locked after three wrong codes");
    });

    it("when two-factor is required, a person without it can only reach the set-up page", async () => {
      config.admin.require2fa = true;
      await addStaff("must@test.local", "right-password-6");
      const login = await post("/admin/login", { email: "must@test.local", password: "right-password-6" });
      assert.equal(login.headers.get("location"), "/admin/security");
      const cookie = cookieOf(login, "fl_admin");
      const overview = await fetch(`${BASE()}/admin`, { headers: { Cookie: cookie }, redirect: "manual" });
      assert.equal(overview.status, 302);
      assert.equal(overview.headers.get("location"), "/admin/security");
      assert.equal((await fetch(`${BASE()}/admin/payments`, { headers: { Cookie: cookie }, redirect: "manual" })).headers.get("location"), "/admin/security");
      const page = await fetch(`${BASE()}/admin/security`, { headers: { Cookie: cookie } });
      assert.equal(page.status, 200);
      assert.match(await page.text(), /Set up two-factor/);
    });

    it("idle timeout: a session unused for longer than the limit is signed out; an active one is kept and extended", async () => {
      await addStaff("idle@test.local", "right-password-7");
      const uid = await idOf("idle@test.local");
      const now = Math.floor(Date.now() / 1000);
      const make = (last) => `fl_admin=${crypto.signToken({ typ: "admin", uid, iat: now - 60, last }, 3600)}`;
      const stale = await fetch(`${BASE()}/admin`, { headers: { Cookie: make(now - 31 * 60) }, redirect: "manual" });
      assert.equal(stale.status, 302);
      assert.match(stale.headers.get("location"), /^\/admin\/login/);
      const fresh = await fetch(`${BASE()}/admin`, { headers: { Cookie: make(now - 60) }, redirect: "manual" });
      assert.equal(fresh.status, 200);
      assert.match(cookieOf(fresh, "fl_admin"), /^fl_admin=.+/, "cookie re-issued with a new activity time");
    });

    it("a state-changing form without a valid CSRF token is refused", async () => {
      await addStaff("csrf@test.local", "right-password-8");
      const login = await post("/admin/login", { email: "csrf@test.local", password: "right-password-8" });
      const cookie = cookieOf(login, "fl_admin");
      assert.equal((await post("/admin/installations/1/status", { status: "suspended" }, cookie)).status, 403);
      assert.equal((await post("/admin/installations/1/status", { status: "suspended", _csrf: "deadbeef" }, cookie)).status, 403);
    });
  });
});
