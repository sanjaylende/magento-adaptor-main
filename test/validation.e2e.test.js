// Input validation on every route (H6): unknown fields, wrong types, injection-looking values and malformed paths are refused
// with 400 before any controller or SQL runs; valid requests still get through. Also checks that SQL stays parameterised.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const h = require("./helpers");

h.useTestEnvironment();

describe("input validation", () => {
  let fakeMagento, httpServer, db, A, call, cookie, csrf;
  const BASE = () => `http://127.0.0.1:${h.ADAPTER_PORT}`;
  const TAG = "magento-1-novariant";
  const ok = (r) => assert.notEqual(r.status, 400, `a valid request must not be rejected: ${JSON.stringify(r.body).slice(0, 200)}`);
  const bad = (r, what) => { assert.equal(r.status, 400, `${what} should be rejected (got ${r.status})`); assert.equal(r.body.error, "Invalid request"); };

  before(async () => {
    await h.resetDatabase();
    fakeMagento = await h.startFakeMagento();
    const { runMigrations, syncEntityTypes } = require("../src/db/migrate");
    await runMigrations();
    await syncEntityTypes([require("../src/models/VideoSlot"), require("../src/models/VideoVersion"), require("../src/models/StoreSetting")]);
    await require("../src/services/adminUserService").ensureBootstrapAdmin();
    db = require("../src/db/connection");
    httpServer = require("../src/app").createApp().listen(h.ADAPTER_PORT);
    const r = await h.api("POST", "/api/v1/register", { body: { baseUrl: `http://127.0.0.1:${h.MAGENTO_PORT}`, magentoToken: "good-token", merchantName: "Validation Test", contactEmail: "v@test.local", countryCode: "IN" } });
    A = r.body;
    call = h.signedClient({ installKey: A.installKey, secret: A.secret, websiteId: 1 });
    const login = await fetch(`${BASE()}/admin/login`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "email=staff@test.local&password=staff-password-1", redirect: "manual" });
    cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("fl_admin="));
    const page = await fetch(`${BASE()}/admin/stores/1`, { headers: { cookie } });
    csrf = (await page.text()).match(/name="_csrf" value="([^"]+)"/)[1];
  });
  after(async () => {
    httpServer && httpServer.close();
    fakeMagento && fakeMagento.close();
    await db.close();
  });

  describe("extension and UI routes (signed)", () => {
    const generate = { uniqueTag: TAG, videoType: "hero_product", prompt: "A calm studio shot", aspectRatio: "16:9", overlayFamily: "Offers", variableValues: { price: "9.99" }, variableSelections: { price: "price" } };

    it("accepts well-formed bodies (and the extension's empty-array body)", async () => {
      ok(await call("POST", "/api/prompt-default", { uniqueTag: TAG, videoType: "hero_product" }));
      ok(await call("POST", "/api/preview-images", { uniqueTag: TAG, videoType: "lifestyle", aspectRatio: "9:16" }));
      ok(await call("POST", "/api/generate", generate));
      ok(await call("POST", "/api/update-overlay", { uniqueTag: TAG, videoType: "hero_product", variableValues: { price: 12 } }));
      ok(await call("POST", "/api/billing/checkout", { kind: "plan", tier: "starter", cycle: "monthly", currency: "USD" }, { headers: { "Idempotency-Key": "abc-123" } }));
      ok(await call("POST", "/api/refresh", []));
      ok(await call("POST", "/api/v1/ping", { extensionVersion: "1.0.0" }));
    });

    it("rejects fields that are not part of the contract", async () => {
      bad(await call("POST", "/api/generate", { ...generate, isAdmin: true }), "unknown field on generate");
      bad(await call("POST", "/api/prompt-default", { uniqueTag: TAG, videoType: "hero_product", extra: 1 }), "unknown field on prompt-default");
      bad(await call("POST", "/api/billing/checkout", { currency: "USD", totalMinor: 1 }), "price smuggled into checkout");
      bad(await call("POST", "/api/v1/ping", { extensionVersion: "1", role: "admin" }), "unknown field on ping");
      bad(await call("POST", "/api/refresh", { force: true }), "body on a route that takes none");
    });

    it("rejects wrong types, bad enums, oversize values and injection-looking text", async () => {
      bad(await call("POST", "/api/generate", { ...generate, videoType: "nope" }), "bad video type");
      bad(await call("POST", "/api/generate", { ...generate, uniqueTag: "../../etc/passwd" }), "path traversal in the product tag");
      bad(await call("POST", "/api/generate", { ...generate, uniqueTag: "x'; DROP TABLE stores;--" }), "SQL in the product tag");
      bad(await call("POST", "/api/generate", { ...generate, aspectRatio: "3:2" }), "unsupported aspect ratio");
      bad(await call("POST", "/api/generate", { ...generate, startImageUrl: "javascript:alert(1)" }), "javascript: image address");
      bad(await call("POST", "/api/generate", { ...generate, startImageUrls: ["file:///etc/passwd"] }), "file: image address");
      bad(await call("POST", "/api/generate", { ...generate, prompt: "x".repeat(4001) }), "oversize prompt");
      bad(await call("POST", "/api/generate", { ...generate, variableValues: { price: { nested: 1 } } }), "nested object as a value");
      bad(await call("POST", "/api/generate", { ...generate, variableValues: { price: "x".repeat(5000) } }), "oversize value");
      bad(await call("POST", "/api/generate", { ...generate, uniqueTag: 123 }), "number as tag");
      bad(await call("POST", "/api/billing/checkout", { currency: "EUR" }), "unsupported currency");
      bad(await call("POST", "/api/billing/checkout", { currency: "USD", kind: "topup", packUsdCents: -5 }), "negative top-up");
      bad(await call("POST", "/api/billing/checkout", { currency: "USD", kind: "plan; DROP" }), "bad kind");
    });

    it("prototype pollution: a body carrying __proto__ or constructor keys is refused and nothing is polluted", async () => {
      const polluting = JSON.parse('{"uniqueTag":"magento-1-novariant","videoType":"hero_product","__proto__":{"isAdmin":true}}');
      bad(await call("POST", "/api/prompt-default", polluting), "__proto__ key");
      bad(await call("POST", "/api/prompt-default", JSON.parse('{"uniqueTag":"magento-1-novariant","videoType":"hero_product","constructor":{"prototype":{"x":1}}}')), "constructor key");
      // inside a free-form map the validator drops a __proto__ key instead of applying it: never an error, never a pollution
      const nested = await call("POST", "/api/update-overlay", { uniqueTag: TAG, videoType: "hero_product", variableValues: JSON.parse('{"__proto__":"yes","price":"1"}') });
      assert.notEqual(nested.status, 500);
      assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, "yes"), false);
      assert.equal({}.polluted, undefined);
      assert.equal({}.isAdmin, undefined);
    });

    it("rejects malformed path and query values", async () => {
      bad(await call("GET", "/api/status/bad%20tag/hero_product"), "space in the tag");
      bad(await call("GET", "/api/status/" + TAG + "/not_a_type"), "unknown video type in the path");
      bad(await call("POST", `/api/generated/${TAG}/hero_product/versions/${encodeURIComponent("1 OR 1=1")}/restore`, {}), "SQL in a version id");
      bad(await call("DELETE", `/api/generated/${encodeURIComponent("a'b")}/hero_product`), "quote in the tag");
      bad(await call("GET", "/api/overlay-families?aspectRatio=7:3"), "unsupported aspect ratio in the query");
      bad(await call("GET", "/api/products?refresh=maybe"), "bad refresh flag");
      bad(await call("GET", "/api/billing/orders/" + encodeURIComponent("1;select 1")), "bad order id");
      bad(await call("GET", "/api/billing/orders/12345"), "an invoice-style number used as an order id");
      bad(await call("GET", "/api/billing/invoices/00000000-0000-0000-0000-000000000000/link"), "an order id used as an invoice number (used to cause a database error)");
      assert.equal((await call("GET", "/api/billing/invoices/999999/link")).status, 404, "an unknown invoice number is a plain 404");
      ok(await call("GET", "/api/status/" + TAG + "/hero_product"));
      ok(await call("GET", "/api/products?cache=1234"), "unknown query names are ignored");
    });

    it("rejects a malformed Idempotency-Key", async () => {
      const r = await call("POST", "/api/billing/checkout", { currency: "USD" }, { headers: { "Idempotency-Key": "has spaces and 'quotes'" } });
      assert.equal(r.status, 400);
      assert.equal(r.body.details[0].field, "Idempotency-Key");
    });

    it("validation errors never echo the submitted value and name only the field and rule", async () => {
      const r = await call("POST", "/api/generate", { ...generate, aspectRatio: "SECRET-VALUE-XYZ" });
      assert.equal(r.status, 400);
      assert.ok(!JSON.stringify(r.body).includes("SECRET-VALUE-XYZ"));
      assert.ok(r.body.details.every((d) => d.in && d.problem));
    });
  });

  describe("public routes", () => {
    it("registration: strict fields, valid e-mail and country code", async () => {
      const base = { baseUrl: `http://127.0.0.1:${h.MAGENTO_PORT}`, magentoToken: "good-token" };
      bad(await h.api("POST", "/api/v1/register", { body: { ...base, admin: true } }), "unknown field");
      bad(await h.api("POST", "/api/v1/register", { body: { ...base, contactEmail: "not-an-email" } }), "bad e-mail");
      bad(await h.api("POST", "/api/v1/register", { body: { ...base, countryCode: "INDIA" } }), "bad country");
      bad(await h.api("POST", "/api/v1/register", { body: { baseUrl: "ftp://x.example.com", magentoToken: "t" } }), "non-http address");
      bad(await h.api("POST", "/api/v1/register", { body: { baseUrl: base.baseUrl } }), "missing token");
    });

    it("session exchange, callbacks, payment return, tokens and webhook", async () => {
      bad(await h.api("POST", "/api/session", { body: { launch: "x", extra: 1 } }), "unknown field on session");
      bad(await h.api("POST", "/api/session", { body: {} }), "missing launch");
      bad(await h.api("POST", "/api/payments/callback/paypal", { body: { a: "b" } }), "unknown gateway");
      bad(await h.api("POST", "/api/payments/callback/icici", { body: { "bad key!": "x" } }), "odd field name in a bank message");
      bad(await h.api("GET", "/billing/return?gw=unknown"), "unknown gateway on return");
      bad(await h.api("GET", "/dl/short"), "download token too short");
      bad(await h.api("GET", "/img/not%20a%20token%20at%20all"), "image token with spaces");
      bad(await h.api("GET", "/invoice/..%2f..%2fetc"), "invoice token with slashes");
      bad(await h.api("POST", "/api/webhooks/video-engine", { body: { event: "edited" } }), "webhook without project id");
      ok(await h.api("POST", "/api/webhooks/video-engine", { body: { project_id: "p-1", event: "edited", extra_from_engine: 1 } }));
    });

    it("mock gateway routes only accept known results and references", async () => {
      bad(await h.api("GET", "/mockpay/x"), "reference too short");
      bad(await h.api("POST", "/mockpay/FLTESTREF01/complete", { body: { result: "hacked" } }), "unknown result");
    });
  });

  describe("staff console", () => {
    const post = (p, form) => fetch(BASE() + p, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie }, body: new URLSearchParams({ _csrf: csrf, ...form }) });

    it("ids in the path must be numbers (or a UUID for payments): anything else is a 404, not a database error", async () => {
      for (const p of ["/admin/stores/abc", "/admin/merchants/1;select", "/admin/payments/not-a-uuid", "/admin/stores/99999999999999999999"]) {
        assert.equal((await fetch(BASE() + p, { headers: { Cookie: cookie } })).status, 404, p);
      }
    });

    it("forms reject unknown fields, bad numbers and bad enums", async () => {
      assert.equal((await post("/admin/installations/1/status", { status: "suspended", sneaky: "1" })).status, 400);
      assert.equal((await post("/admin/installations/1/status", { status: "deleted" })).status, 400);
      assert.equal((await post("/admin/stores/1/credit", { usd: "abc" })).status, 400);
      assert.equal((await post("/admin/stores/1/credit", { usd: "5; DROP TABLE x" })).status, 400);
      assert.equal((await post("/admin/plans/rate", { plan: "starter", type: "nope", rate: "1" })).status, 400);
      assert.equal((await post("/admin/plans/price", { plan: "starter'", interval: "monthly", currency: "USD", amount: "1", budget: "1" })).status, 400);
      assert.equal((await fetch(`${BASE()}/admin/payments?status=%3Cscript%3E`, { headers: { Cookie: cookie } })).status, 400);
    });

    it("a valid form still works", async () => {
      const res = await post("/admin/stores/1/credit", { usd: "1.50", note: "validation test" });
      assert.equal(res.status, 302);
      assert.match(res.headers.get("location"), /ok=/);
    });
  });

  describe("SQL stays parameterised", () => {
    it("no statement in src/ builds SQL from request data: the only dynamic part is the fixed EAV value-table name", () => {
      const files = [];
      const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith(".js")) files.push(p); } };
      walk(path.join(__dirname, "..", "src"));
      const offenders = [];
      for (const file of files) {
        if (/[\\/]admin[\\/]views\.js$/.test(file)) continue; // HTML, not SQL
        const src = fs.readFileSync(file, "utf8");
        // an SQL keyword followed by a template placeholder inside the same template literal
        const re = /`[^`]*\b(SELECT|INSERT INTO|UPDATE|DELETE FROM)\b[^`]*`/gs;
        for (const m of src.matchAll(re)) {
          for (const p of m[0].matchAll(/\$\{([^}]*)\}/g)) {
            const expr = p[1].trim();
            const allowed = /^safeTable\(/.test(expr) || /^tuples\.join\(/.test(expr) || /^joins\.join\(/.test(expr) || /^clauses\.join\(/.test(expr) || /^add\(/.test(expr) || /^i\}?$/.test(expr)
              || /^params\.length/.test(expr) || /^attr\.attribute_id/.test(expr) || /^i$/.test(expr)
              || expr === 'status ? "WHERE o.status = $1" : ""'; // fixed text chosen by a checked enum, value stays a $1 parameter
            if (!allowed) offenders.push(`${path.relative(path.join(__dirname, ".."), file)}: \${${expr}}`);
          }
        }
      }
      assert.deepEqual(offenders, [], "SQL text must not contain request data");
    });

    it("the EAV layer only accepts its five fixed value tables", () => {
      const { safeTable } = require("../src/db/eav/EavRepository");
      for (const t of ["varchar", "int", "text", "datetime", "decimal"]) assert.equal(safeTable(t), t);
      for (const t of ["users; DROP TABLE x", "varchar ", "VARCHAR", "", undefined, "payment_orders"]) assert.throws(() => safeTable(t), /Unsupported EAV value table/);
    });
  });
});
