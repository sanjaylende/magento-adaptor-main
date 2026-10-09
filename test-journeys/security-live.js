// Security behaviour of a RUNNING adapter (HTTP only, like an attacker or a broken client would see it).
// Usage: node test-journeys/security-live.js [baseUrl]        default http://localhost:4200
// It registers two throwaway installations against a fake Magento (started here on port 45124), creates a throwaway staff user, runs the
// checks and removes the staff user at the end. The installations are suspended afterwards. Development mode is assumed: private
// store addresses are allowed there on purpose, so SSRF address blocking is covered by test/ssrf.test.js and the production-mode smoke.
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const h = require("../test/helpers");
const adminUsers = require("../src/services/adminUserService");

const BASE = (process.argv[2] || "http://localhost:4200").replace(/\/+$/, "");
const results = [];
const check = (name, pass, detail = "") => { results.push({ name, pass: !!pass, detail }); console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  [${detail}]` : ""}`); };
const psql = (sql) => execFileSync("docker", ["exec", "-i", "magento-adaptor-db-1", "psql", "-U", "adapter_owner", "-d", "magento_adapter", "-At"], { input: sql, encoding: "utf8", env: { ...process.env, MSYS_NO_PATHCONV: "1" } }).trim();
const post = (path, body, headers = {}) => fetch(BASE + path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
const form = (path, fields, cookie) => fetch(BASE + path, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded", ...(cookie ? { Cookie: cookie } : {}) }, body: new URLSearchParams(fields) });
const cookieOf = (res, name) => (res.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith(`${name}=`)) || "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const fake = await h.startFakeMagento();
  const staffEmail = `sec-live-${Date.now()}@test.local`;
  const staffPassword = `Live-${crypto.randomBytes(6).toString("hex")}-pw`;
  const created = [];
  try {
    // ---- two merchants (two separate installations), one signed client each ----
    const reg = async (host, name) => {
      const r = await post("/api/v1/register", { baseUrl: `http://${host}:${h.MAGENTO_PORT}`, magentoToken: "good-token", merchantName: name, contactEmail: "live@test.local", countryCode: "IN" });
      return { status: r.status, body: await r.json() };
    };
    const A = await reg("127.0.0.1", "Live Test A");
    const B = await reg("localhost", "Live Test B");
    check("registration works for two separate merchants", A.status === 201 && B.status === 201, `${A.status}/${B.status}`);
    created.push(A.body.installKey, B.body.installKey);
    const callA = h.signedClient({ installKey: A.body.installKey, secret: A.body.secret, websiteId: 1, baseUrl: BASE });
    const callB = h.signedClient({ installKey: B.body.installKey, secret: B.body.secret, websiteId: 1, baseUrl: BASE });

    // ---- request signing ----
    check("valid signed request is accepted", (await callA("GET", "/api/billing/status")).status === 200);
    check("bad signature is refused (401)", (await callA("POST", "/api/v1/ping", {}, { badSignature: true })).status === 401);
    const nonce = `replay-${crypto.randomUUID()}`;
    const first = await callA("POST", "/api/v1/ping", {}, { nonce });
    const second = await callA("POST", "/api/v1/ping", {}, { nonce });
    check("a replayed nonce is refused (401)", first.status === 200 && second.status === 401, `${first.status} then ${second.status}`);
    check("an expired timestamp is refused (401)", (await callA("POST", "/api/v1/ping", {}, { ts: Math.floor(Date.now() / 1000) - 3600 })).status === 401);
    check("a timestamp from the future is refused (401)", (await callA("POST", "/api/v1/ping", {}, { ts: Math.floor(Date.now() / 1000) + 3600 })).status === 401);
    const wrongKey = h.signedClient({ installKey: "fk_doesnotexist000", secret: A.body.secret, websiteId: 1, baseUrl: BASE });
    check("an unknown install key is refused (401)", (await wrongKey("GET", "/api/billing/status")).status === 401);
    check("a signature made for another path is refused", await (async () => {
      const ts = Math.floor(Date.now() / 1000), n = `p-${crypto.randomUUID()}`;
      const sig = h.hmac(A.body.secret, `${ts}\n${n}\nGET\n/api/billing/status\n${crypto.createHash("sha256").update("").digest("hex")}`);
      const res = await fetch(`${BASE}/api/billing/history`, { headers: { "X-Flipick-Key": A.body.installKey, "X-Flipick-Timestamp": String(ts), "X-Flipick-Nonce": n, "X-Flipick-Signature": sig, "X-Flipick-Website": "1" } });
      return res.status === 401;
    })());

    // ---- body and field validation ----
    check("a body over the route's limit is refused (413)", (await post("/api/session", { launch: "x".repeat(10 * 1024) })).status === 413);
    check("a 2 MB body is refused (413)", (await post("/api/session", { launch: "x".repeat(2 * 1024 * 1024) })).status === 413);
    check("an unknown JSON field is refused (400)", (await callA("POST", "/api/prompt-default", { uniqueTag: "magento-1-novariant", videoType: "hero_product", admin: true })).status === 400);
    check("a prototype-pollution body is refused (400)", (await callA("POST", "/api/prompt-default", JSON.parse('{"uniqueTag":"magento-1-novariant","videoType":"hero_product","__proto__":{"isAdmin":true}}'))).status === 400);
    check("SQL text in a path value is refused (400)", (await callA("GET", "/api/status/" + encodeURIComponent("x';DROP TABLE stores;--") + "/hero_product")).status === 400);
    check("a malformed Idempotency-Key is refused (400)", (await callA("POST", "/api/billing/checkout", { currency: "USD" }, { headers: { "Idempotency-Key": "bad key with spaces" } })).status === 400);

    // ---- SSRF-shaped registration addresses (shape checks only in development) ----
    for (const url of ["ftp://x.example.com", "file:///etc/passwd", "gopher://127.0.0.1:70", "http://user:pass@127.0.0.1/"]) {
      const r = await post("/api/v1/register", { baseUrl: url, magentoToken: "t" });
      check(`registration with ${url} is refused (4xx)`, r.status >= 400 && r.status < 500, String(r.status));
    }
    for (const url of ["http://169.254.169.254/latest/meta-data", "http://127.0.0.1:22"]) {
      const r = await post("/api/v1/register", { baseUrl: url, magentoToken: "t" });
      check(`registration with ${url} does not succeed (it reaches no Magento)`, r.status === 400, `${r.status} ${JSON.stringify((await r.json()).error || "")}`.slice(0, 120));
    }

    // ---- cross-store isolation (row-level security) ----
    const orderB = await callB("POST", "/api/billing/checkout", { kind: "plan", tier: "starter", cycle: "monthly", currency: "USD" });
    const orderId = orderB.body && orderB.body.orderId;
    check("merchant B can start a checkout", orderB.status === 201 && !!orderId, String(orderB.status));
    const ownView = await callB("GET", `/api/billing/orders/${orderId}`);
    const otherView = await callA("GET", `/api/billing/orders/${orderId}`);
    check("merchant B sees its own order", ownView.status === 200);
    check("merchant A cannot see merchant B's order (404, not 200)", otherView.status === 404 || otherView.status === 403, String(otherView.status));
    const invoiceOther = await callA("GET", `/api/billing/invoices/${orderId}/link`);
    check("merchant A cannot get a link to merchant B's invoice", invoiceOther.status >= 400, String(invoiceOther.status));
    const sessB = (await (await post("/api/session", { launch: h.launchToken({ installKey: B.body.installKey, secret: B.body.secret, websiteId: 1 }) })).json()).token;
    const sessA = (await (await post("/api/session", { launch: h.launchToken({ installKey: A.body.installKey, secret: A.body.secret, websiteId: 1 }) })).json()).token;
    const viaSession = await fetch(`${BASE}/api/billing/orders/${orderId}`, { headers: { Authorization: `Bearer ${sessA}` } });
    check("the same holds with a browser session token of merchant A", viaSession.status === 404 || viaSession.status === 403, String(viaSession.status));
    const sameOwner = await fetch(`${BASE}/api/billing/orders/${orderId}`, { headers: { Authorization: `Bearer ${sessB}` } });
    check("and merchant B's session does see it", sameOwner.status === 200);
    const stolen = await fetch(`${BASE}/api/bootstrap`, { headers: { Authorization: `Bearer ${sessA.slice(0, -4)}abcd` } });
    check("a session token with a changed signature is refused (401)", stolen.status === 401);

    // ---- staff console: lock-out and CSRF ----
    psql(`INSERT INTO admin_users (email, password_hash, role) VALUES ('${staffEmail}', '${adminUsers.hashPassword(staffPassword)}', 'admin')`);
    await sleep(100);
    psql("DELETE FROM rate_limits WHERE bucket LIKE 'admin-login:%'");
    let lastWrong;
    for (let i = 1; i <= 6; i++) lastWrong = await form("/admin/login", { email: staffEmail, password: `wrong-${i}` });
    const rightWhileLocked = await form("/admin/login", { email: staffEmail, password: staffPassword });
    const lockedUntil = psql(`SELECT locked_until > now() FROM admin_users WHERE email = '${staffEmail}'`);
    check("six wrong passwords lock the account; the right password is then refused", lockedUntil === "t" && rightWhileLocked.status === 401 && !cookieOf(rightWhileLocked, "fl_admin"), `locked=${lockedUntil}, right-password status ${rightWhileLocked.status}`);
    psql(`UPDATE admin_users SET locked_until = NULL, failed_attempts = 0 WHERE email = '${staffEmail}'`);
    psql("DELETE FROM rate_limits WHERE bucket LIKE 'admin-login:%'");
    const login = await form("/admin/login", { email: staffEmail, password: staffPassword });
    const cookie = cookieOf(login, "fl_admin");
    check("after the lock is lifted the right password signs in", login.status === 302 && !!cookie);
    const noCsrf = await form("/admin/installations/1/status", { status: "suspended" }, cookie);
    const badCsrf = await form("/admin/installations/1/status", { status: "suspended", _csrf: "deadbeef" }, cookie);
    const stateAfter = psql("SELECT status FROM installations WHERE id = 1");
    check("a staff POST without or with a wrong CSRF token is refused (403) and changes nothing", noCsrf.status === 403 && badCsrf.status === 403 && stateAfter === "active", `${noCsrf.status}/${badCsrf.status}, installation 1 is ${stateAfter}`);
    check("the staff console is not reachable without a session", (await fetch(`${BASE}/admin`, { redirect: "manual" })).status === 302);
    check("a forged staff cookie is refused", (await fetch(`${BASE}/admin`, { redirect: "manual", headers: { Cookie: "fl_admin=eyJ0eXAiOiJhZG1pbiIsInVpZCI6MSwiZXhwIjo5OTk5OTk5OTk5fQ.0000" } })).status === 302);

    // ---- rate limits (last: it uses up the per-minute budget of this address) ----
    psql("DELETE FROM rate_limits WHERE bucket LIKE 'session:%'");
    let blocked = null, count = 0;
    for (; count < 90; count++) {
      const r = await post("/api/session", { launch: "x" });
      if (r.status === 429) { blocked = r; break; }
    }
    check("hammering /api/session triggers the rate limit (429 with Retry-After)", !!blocked && !!blocked.headers.get("retry-after"), blocked ? `after ${count} requests, Retry-After ${blocked.headers.get("retry-after")}s` : "never limited");
  } finally {
    try { psql(`DELETE FROM admin_users WHERE email = '${staffEmail}'`); psql("DELETE FROM rate_limits"); } catch (err) { console.log("cleanup:", err.message.split("\n")[0]); }
    try { for (const key of created) psql(`UPDATE installations SET status = 'suspended' WHERE install_key = '${key}'`); } catch (err) { console.log("cleanup:", err.message.split("\n")[0]); }
    fake.close();
  }
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((err) => { console.error("FAILED:", err.message); process.exit(2); });
