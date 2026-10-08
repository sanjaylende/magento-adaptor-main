// Staff console: merchants, installations, stores, subscriptions, payments, refunds, plans and the audit log.
// Server-rendered pages under /admin, behind a signed cookie session. Only 'admin' staff may change anything.
const express = require("express");
const config = require("../config");
const { query, asSystem } = require("../db/connection");
const { signToken, verifyToken, hmacHex, safeEqual } = require("../utils/crypto");
const users = require("../services/adminUserService");
const billing = require("../services/billingService");
const payments = require("../services/paymentService");
const tenants = require("../services/tenantService");
const audit = require("../services/auditService");
const { perIp } = require("../middleware/rateLimit");
const asyncHandler = require("../middleware/asyncHandler");
const v = require("./views");

const router = express.Router();
const COOKIE = "fl_admin";
const SESSION_SECONDS = 8 * 3600;
const q = (sql, params) => asSystem(() => query(sql, params));

function cookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(";").map((c) => c.trim().split(/=(.*)/s).slice(0, 2)).filter(([k]) => k));
}

const csrfFor = (sessionToken) => hmacHex(config.secretKey, `csrf:${sessionToken}`);

// Session check for every /admin page except the login form.
async function requireStaff(req, res, next) {
  const token = cookies(req)[COOKIE];
  const claims = token && verifyToken(token);
  const user = claims && claims.typ === "admin" ? await users.getById(claims.uid) : null;
  if (!user) return res.redirect("/admin/login");
  req.staff = user;
  req.csrf = csrfFor(token);
  if (req.method === "POST" && !safeEqual((req.body || {})._csrf || "", req.csrf)) return res.status(403).send("Form expired. Go back, reload and try again.");
  next();
}

const requireAdminRole = (req, res, next) => (req.staff.role === "admin" ? next() : res.status(403).send("Only admins can do this"));

// Page renderer with flash message and the csrf token available to forms.
function render(req, res, { title, active, body }) {
  const flash = req.query.ok ? { kind: "ok", text: req.query.ok } : req.query.err ? { kind: "bad", text: req.query.err } : null;
  res.send(v.layout({ title, user: req.staff, active, body: body.replaceAll("{{CSRF}}", req.csrf), flash }));
}

const back = (res, to, ok, err) => res.redirect(`${to}${to.includes("?") ? "&" : "?"}${ok ? `ok=${encodeURIComponent(ok)}` : `err=${encodeURIComponent(err)}`}`);
const csrfField = '<input type="hidden" name="_csrf" value="{{CSRF}}">';
const actor = (req) => ({ type: "staff", id: req.staff.email });
const major = (minor, cur) => v.money(minor, cur);

// ---- Login ----
router.get("/admin/login", (req, res) => res.send(v.loginPage()));
router.post("/admin/login", perIp("admin-login", 10), asyncHandler(async (req, res) => {
  const user = await users.authenticate(req.body.email, req.body.password);
  if (!user) {
    await audit.record({ actorType: "staff", actorId: req.body.email, action: "admin.login_failed", ip: req.ip });
    return res.status(401).send(v.loginPage("Wrong email or password"));
  }
  const token = signToken({ typ: "admin", uid: user.id }, SESSION_SECONDS);
  res.setHeader("Set-Cookie", `${COOKIE}=${token}; Path=/admin; HttpOnly; SameSite=Lax; Max-Age=${SESSION_SECONDS}${config.isProduction ? "; Secure" : ""}`);
  await audit.record({ actorType: "staff", actorId: user.email, action: "admin.login", ip: req.ip });
  res.redirect("/admin");
}));
router.get("/admin/logout", (req, res) => {
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/admin; HttpOnly; Max-Age=0`);
  res.redirect("/admin/login");
});

router.use("/admin", asyncHandler(requireStaff));

// ---- Overview ----
router.get("/admin", asyncHandler(async (req, res) => {
  const [counts, revenue, pending, byPlan] = await Promise.all([
    q(`SELECT (SELECT count(*) FROM merchants)::int AS merchants, (SELECT count(*) FROM installations WHERE status = 'active')::int AS installations,
               (SELECT count(*) FROM stores WHERE status = 'active')::int AS stores,
               (SELECT count(*) FROM usage_events WHERE created_at > now() - interval '30 days')::int AS videos30`),
    q("SELECT currency, SUM(total_minor)::bigint AS total FROM payment_orders WHERE status IN ('paid','partially_refunded') AND paid_at > now() - interval '30 days' GROUP BY currency"),
    q("SELECT count(*)::int AS n FROM payment_orders WHERE status = 'pending'"),
    q("SELECT plan_code, count(*)::int AS n FROM store_subscriptions GROUP BY plan_code ORDER BY plan_code"),
  ]);
  const c = counts.rows[0];
  const stat = (n, label) => `<div class="stat"><b>${n}</b><span>${v.e(label)}</span></div>`;
  render(req, res, { title: "Overview", active: "/admin", body: `<h1>Overview</h1>
    <div class="grid">${stat(c.merchants, "Merchants")}${stat(c.installations, "Active installations")}${stat(c.stores, "Stores")}${stat(c.videos30, "Videos, last 30 days")}${stat(pending.rows[0].n, "Payments pending")}
    ${revenue.rows.map((r) => stat(major(r.total, r.currency.trim()), `Paid, last 30 days (${r.currency.trim()})`)).join("") || stat("—", "Paid, last 30 days")}</div>
    <h2>Stores by plan</h2>${v.table(["Plan", { label: "Stores", n: true }], byPlan.rows.map((r) => [v.e(r.plan_code), r.n]))}` });
}));

// ---- Merchants ----
router.get("/admin/merchants", asyncHandler(async (req, res) => {
  const { rows } = await q(`SELECT m.*, (SELECT count(*) FROM installations i WHERE i.merchant_id = m.id)::int AS installs,
      (SELECT count(*) FROM stores s JOIN installations i ON i.id = s.installation_id WHERE i.merchant_id = m.id AND s.status = 'active')::int AS stores
      FROM merchants m ORDER BY m.id DESC LIMIT 200`);
  render(req, res, { title: "Merchants", active: "/admin/merchants", body: `<h1>Merchants</h1>${v.table(
    ["Name", "Email", "Country", { label: "Installations", n: true }, { label: "Stores", n: true }, "Created"],
    rows.map((m) => [`<a href="/admin/merchants/${m.id}">${v.e(m.name)}</a>`, v.e(m.contact_email || "—"), v.e(m.country_code || "—"), m.installs, m.stores, v.date(m.created_at)]))}` });
}));

router.get("/admin/merchants/:id", asyncHandler(async (req, res) => {
  const { rows: [m] } = await q("SELECT * FROM merchants WHERE id = $1", [req.params.id]);
  if (!m) return res.status(404).send("Not found");
  const [inst, stores] = await Promise.all([
    q("SELECT id, base_url, install_key, status, magento_version, extension_version, registered_at, last_seen_at FROM installations WHERE merchant_id = $1 ORDER BY id", [m.id]),
    q(`SELECT s.id, s.name, s.code, s.base_currency, ss.plan_code, ss.status, ss.period_end FROM stores s JOIN installations i ON i.id = s.installation_id
       LEFT JOIN store_subscriptions ss ON ss.store_id = s.id WHERE i.merchant_id = $1 AND s.status = 'active' ORDER BY s.id`, [m.id]),
  ]);
  const canEdit = req.staff.role === "admin";
  render(req, res, { title: m.name, active: "/admin/merchants", body: `<h1>${v.e(m.name)}</h1>
    <div class="kv"><div>Email</div><div>${v.e(m.contact_email || "—")}</div><div>Country</div><div>${v.e(m.country_code || "—")}</div><div>GST number</div><div>${v.e(m.gst_number || "—")}</div><div>Created</div><div>${v.date(m.created_at)}</div></div>
    ${canEdit ? `<h2>Billing profile</h2><form class="inline" method="post" action="/admin/merchants/${m.id}">${csrfField}
      <label>Country (2 letters)<input name="country" maxlength="2" value="${v.e(m.country_code || "")}"></label><label>GST number<input name="gst" value="${v.e(m.gst_number || "")}"></label>
      <label>Billing address<input name="address" size="40" value="${v.e(m.billing_address || "")}"></label><button>Save</button></form>` : ""}
    <h2>Installations</h2>${v.table(["Store URL", "Status", "Magento", "Extension", "Last seen", ""],
      inst.rows.map((i) => [v.e(i.base_url), v.statusTag(i.status), v.e(i.magento_version || "—"), v.e(i.extension_version || "—"), v.date(i.last_seen_at),
        canEdit ? `<form method="post" action="/admin/installations/${i.id}/status">${csrfField}<input type="hidden" name="status" value="${i.status === "active" ? "suspended" : "active"}"><button class="sec">${i.status === "active" ? "Suspend" : "Activate"}</button></form>` : ""]))}
    <h2>Stores</h2>${v.table(["Store", "Currency", "Plan", "Status", "Plan ends"],
      stores.rows.map((s) => [`<a href="/admin/stores/${s.id}">${v.e(s.name)}</a>`, v.e(s.base_currency.trim()), v.e(s.plan_code || "—"), v.statusTag(s.status || "—"), v.date(s.period_end)]))}` });
}));

router.post("/admin/merchants/:id", requireAdminRole, asyncHandler(async (req, res) => {
  const { rows: [before] } = await q("SELECT country_code, gst_number, billing_address FROM merchants WHERE id = $1", [req.params.id]);
  await q("UPDATE merchants SET country_code = $2, gst_number = $3, billing_address = $4 WHERE id = $1",
    [req.params.id, (req.body.country || "").toUpperCase().slice(0, 2) || null, req.body.gst || null, req.body.address || null]);
  await audit.record({ actorType: "staff", actorId: req.staff.email, merchantId: Number(req.params.id), action: "merchant.profile_updated", before, after: req.body });
  back(res, `/admin/merchants/${req.params.id}`, "Saved");
}));

router.post("/admin/installations/:id/status", requireAdminRole, asyncHandler(async (req, res) => {
  const status = req.body.status === "suspended" ? "suspended" : "active";
  const { rows: [inst] } = await q("UPDATE installations SET status = $2 WHERE id = $1 RETURNING merchant_id, install_key", [req.params.id, status]);
  if (inst) tenants.invalidateInstallation(inst.install_key);
  await audit.record({ actorType: "staff", actorId: req.staff.email, installationId: Number(req.params.id), action: `installation.${status}` });
  back(res, `/admin/merchants/${inst.merchant_id}`, `Installation ${status}`);
}));

// ---- Stores ----
router.get("/admin/stores", asyncHandler(async (req, res) => {
  const { rows } = await q(`SELECT s.id, s.name, i.base_url, ss.plan_code, ss.status, ss.period_end, ss.cycle_value_used_cents, ss.free_videos_used,
      (SELECT COALESCE(SUM(amount_usd_cents), 0) FROM credit_ledger c WHERE c.store_id = s.id)::bigint AS credit
      FROM stores s JOIN installations i ON i.id = s.installation_id LEFT JOIN store_subscriptions ss ON ss.store_id = s.id
      WHERE s.status = 'active' ORDER BY s.id DESC LIMIT 300`);
  render(req, res, { title: "Stores", active: "/admin/stores", body: `<h1>Stores</h1>${v.table(
    ["Store", "Installation", "Plan", "Status", "Plan ends", { label: "Used (USD)", n: true }, { label: "Credit (USD)", n: true }],
    rows.map((s) => [`<a href="/admin/stores/${s.id}">${v.e(s.name)}</a>`, v.e(s.base_url), v.e(s.plan_code || "—"), v.statusTag(s.status || "—"), v.date(s.period_end),
      s.plan_code === "trial" ? `${s.free_videos_used} free` : (s.cycle_value_used_cents / 100).toFixed(2), (s.credit / 100).toFixed(2)]))}` });
}));

router.get("/admin/stores/:id", asyncHandler(async (req, res) => {
  const { rows: [s] } = await q(`SELECT s.*, i.base_url, i.merchant_id, m.name AS merchant FROM stores s JOIN installations i ON i.id = s.installation_id JOIN merchants m ON m.id = i.merchant_id WHERE s.id = $1`, [req.params.id]);
  if (!s) return res.status(404).send("Not found");
  const sub = await asSystem(() => billing.getSubscription(s.id));
  const [credit, usage, orders, catalogue, log] = await Promise.all([
    asSystem(() => billing.creditBalance(s.id)),
    asSystem(() => billing.usageSummary(s.id, 20)),
    q("SELECT * FROM payment_orders WHERE store_id = $1 ORDER BY created_at DESC LIMIT 30", [s.id]),
    billing.loadCatalogue(),
    q("SELECT * FROM audit_log WHERE store_id = $1 ORDER BY at DESC LIMIT 20", [s.id]),
  ]);
  const canEdit = req.staff.role === "admin";
  const planOptions = Object.keys(catalogue.plans).filter((p) => p !== "trial").map((p) => `<option value="${p}">${v.e(catalogue.plans[p].label)}</option>`).join("");
  render(req, res, { title: s.name, active: "/admin/stores", body: `<h1>${v.e(s.name)} <span class="muted">· ${v.e(s.merchant)}</span></h1>
    <div class="kv"><div>Installation</div><div>${v.e(s.base_url)} (website ${v.e(s.external_id)})</div>
    <div>Plan</div><div>${v.e(sub.planCode)} ${sub.billingInterval ? `(${sub.billingInterval}, ${v.e(sub.currency)})` : ""} ${v.statusTag(sub.status)}${sub.cancelAtPeriodEnd ? " <span class='tag warn'>cancels at period end</span>" : ""}</div>
    <div>Period</div><div>${v.date(sub.periodStart)} to ${v.date(sub.periodEnd)}</div>
    <div>Usage this period</div><div>${sub.planCode === "trial" ? `${sub.freeVideosUsed} of ${catalogue.plans.trial.freeVideos} free videos` : `${sub.cycleVideosUsed} videos, $${(sub.cycleValueUsedCents / 100).toFixed(2)}`}</div>
    <div>Credit balance</div><div>$${(credit / 100).toFixed(2)}</div></div>
    ${canEdit ? `<h2>Actions</h2>
    <form class="inline" method="post" action="/admin/stores/${s.id}/credit">${csrfField}<label>Grant credit (USD)<input name="usd" type="number" step="0.01" required></label><label>Note<input name="note" required></label><button>Add credit</button></form>
    <form class="inline" method="post" action="/admin/stores/${s.id}/plan">${csrfField}<label>Plan<select name="plan">${planOptions}</select></label>
      <label>Interval<select name="interval"><option>monthly</option><option>annual</option></select></label><label>Currency<select name="currency"><option>USD</option><option>INR</option></select></label>
      <label>Reason<input name="note" required></label><button>Activate without payment</button></form>
    ${sub.planCode !== "trial" ? `<form class="inline" method="post" action="/admin/stores/${s.id}/end-plan">${csrfField}<button class="sec">End paid plan now</button></form>` : ""}` : ""}
    <h2>Payments</h2>${v.table(["When", "What", { label: "Total", n: true }, "Status", ""], orders.rows.map((o) => [v.date(o.created_at), v.e(payments.describeOrder(payments.mapOrder(o))), major(o.total_minor, o.currency.trim()), v.statusTag(o.status), `<a href="/admin/payments/${o.id}">Open</a>`]))}
    <h2>Recent videos</h2>${v.table(["When", "Type", "Funded by", { label: "Cost (USD)", n: true }], usage.map((u) => [v.date(u.created_at), v.e(u.video_type), v.e(u.source), (u.cost_usd_cents / 100).toFixed(2)]))}
    <h2>Activity</h2>${v.table(["When", "Who", "Action"], log.rows.map((a) => [v.date(a.at), v.e(`${a.actor_type}${a.actor_id ? `:${a.actor_id}` : ""}`), v.e(a.action)]))}` });
}));

router.post("/admin/stores/:id/credit", requireAdminRole, asyncHandler(async (req, res) => {
  const usdCents = Math.round(Number(req.body.usd) * 100);
  const to = `/admin/stores/${req.params.id}`;
  if (!Number.isFinite(usdCents) || usdCents === 0) return back(res, to, null, "Enter a non-zero amount");
  await asSystem(() => billing.addCredit({ storeId: Number(req.params.id), usdCents, kind: "manual", note: req.body.note }));
  await audit.record({ actorType: "staff", actorId: req.staff.email, storeId: Number(req.params.id), action: "credit.manual", after: { usdCents, note: req.body.note } });
  back(res, to, "Credit updated");
}));

router.post("/admin/stores/:id/plan", requireAdminRole, asyncHandler(async (req, res) => {
  const to = `/admin/stores/${req.params.id}`;
  const catalogue = await billing.loadCatalogue();
  if (!catalogue.plans[req.body.plan]?.prices?.[req.body.interval]?.[req.body.currency]) return back(res, to, null, "That plan, interval and currency is not offered");
  await asSystem(() => billing.activatePlan({ storeId: Number(req.params.id), planCode: req.body.plan, billingInterval: req.body.interval, currency: req.body.currency, orderId: `staff:${req.body.note}` }));
  await audit.record({ actorType: "staff", actorId: req.staff.email, storeId: Number(req.params.id), action: "subscription.staff_activated", after: req.body });
  back(res, to, "Plan activated");
}));

router.post("/admin/stores/:id/end-plan", requireAdminRole, asyncHandler(async (req, res) => {
  await asSystem(() => billing.endPlanNow(Number(req.params.id), actor(req)));
  back(res, `/admin/stores/${req.params.id}`, "Plan ended");
}));

// ---- Payments and refunds ----
router.get("/admin/payments", asyncHandler(async (req, res) => {
  const status = req.query.status || "";
  const { rows } = await q(`SELECT o.*, s.name AS store, m.name AS merchant FROM payment_orders o JOIN stores s ON s.id = o.store_id JOIN merchants m ON m.id = o.merchant_id
      ${status ? "WHERE o.status = $1" : ""} ORDER BY o.created_at DESC LIMIT 200`, status ? [status] : []);
  const filters = ["", "pending", "paid", "failed", "refunded", "partially_refunded"].map((s) => `<a href="/admin/payments${s ? `?status=${s}` : ""}">${s || "all"}</a>`).join(" · ");
  render(req, res, { title: "Payments", active: "/admin/payments", body: `<h1>Payments</h1><p class="muted">${filters}</p>${v.table(
    ["When", "Merchant", "Store", "What", { label: "Total", n: true }, "Gateway", "Status", ""],
    rows.map((o) => [v.date(o.created_at), v.e(o.merchant), v.e(o.store), v.e(payments.describeOrder(payments.mapOrder(o))), major(o.total_minor, o.currency.trim()), v.e(o.gateway), v.statusTag(o.status), `<a href="/admin/payments/${o.id}">Open</a>`]))}` });
}));

router.get("/admin/payments/:id", asyncHandler(async (req, res) => {
  const { rows: [o] } = await q("SELECT o.*, s.name AS store, m.name AS merchant FROM payment_orders o JOIN stores s ON s.id = o.store_id JOIN merchants m ON m.id = o.merchant_id WHERE o.id = $1", [req.params.id]);
  if (!o) return res.status(404).send("Not found");
  const [events, refunds, invoices] = await Promise.all([
    q("SELECT * FROM gateway_events WHERE order_id = $1 ORDER BY id", [o.id]),
    q("SELECT * FROM refunds WHERE order_id = $1 ORDER BY created_at", [o.id]),
    q("SELECT * FROM invoices WHERE order_id = $1 ORDER BY id", [o.id]),
  ]);
  const cur = o.currency.trim();
  const refunded = refunds.rows.filter((r) => r.status === "succeeded").reduce((a, r) => a + r.amount_minor, 0);
  const canRefund = req.staff.role === "admin" && ["paid", "partially_refunded"].includes(o.status) && refunded < o.total_minor;
  render(req, res, { title: `Payment ${o.merchant_txn_no}`, active: "/admin/payments", body: `<h1>Payment ${v.e(o.merchant_txn_no)} ${v.statusTag(o.status)}</h1>
    <div class="kv"><div>Merchant</div><div>${v.e(o.merchant)} · <a href="/admin/stores/${o.store_id}">${v.e(o.store)}</a></div><div>What</div><div>${v.e(payments.describeOrder(payments.mapOrder(o)))}</div>
    <div>Amount</div><div>${major(o.subtotal_minor, cur)} + tax ${major(o.tax_minor, cur)} = <b>${major(o.total_minor, cur)}</b></div><div>Gateway</div><div>${v.e(o.gateway)} ${o.gateway_ref ? `(${v.e(o.gateway_ref)})` : ""}</div>
    <div>Created / paid</div><div>${v.date(o.created_at)} / ${v.date(o.paid_at)}</div>${o.failure_reason ? `<div>Failure</div><div>${v.e(o.failure_reason)}</div>` : ""}</div>
    ${canRefund ? `<h2>Refund</h2><form class="inline" method="post" action="/admin/payments/${o.id}/refund">${csrfField}
      <label>Amount (${v.e(cur)})<input name="amount" type="number" step="0.01" max="${((o.total_minor - refunded) / 100).toFixed(2)}" value="${((o.total_minor - refunded) / 100).toFixed(2)}" required></label>
      <label>Reason<input name="reason" size="30" required></label>
      <label>Entitlement<select name="entitlement"><option value="none">Keep plan / credit</option><option value="${o.kind === "plan" ? "cancel_plan" : "remove_credit"}">${o.kind === "plan" ? "End the plan now" : "Take back the credit"}</option></select></label>
      <button>Refund</button></form>` : ""}
    <h2>Invoices and credit notes</h2>${v.table(["Number", "Kind", { label: "Total", n: true }, "Issued"], invoices.rows.map((i) => [v.e(i.number), v.e(i.kind), major(i.total_minor, cur), v.date(i.issued_at)]))}
    <h2>Refunds</h2>${v.table(["When", { label: "Amount", n: true }, "Status", "Reason", "By"], refunds.rows.map((r) => [v.date(r.created_at), major(r.amount_minor, cur), v.statusTag(r.status), v.e(r.reason), v.e(r.requested_by)]))}
    <h2>Gateway events</h2>${v.table(["When", "Event", "Payload"], events.rows.map((g) => [v.date(g.created_at), v.e(g.event_key), `<code>${v.e(JSON.stringify(g.payload).slice(0, 160))}</code>`]))}` });
}));

router.post("/admin/payments/:id/refund", requireAdminRole, asyncHandler(async (req, res) => {
  const to = `/admin/payments/${req.params.id}`;
  try {
    await payments.refundOrder({
      orderId: req.params.id, amountMinor: Math.round(Number(req.body.amount) * 100), reason: (req.body.reason || "").trim(),
      entitlementAction: ["cancel_plan", "remove_credit"].includes(req.body.entitlement) ? req.body.entitlement : "none", actor: actor(req),
    });
    back(res, to, "Refund processed");
  } catch (err) {
    back(res, to, null, err.userMessage || err.message);
  }
}));

router.get("/admin/refunds", asyncHandler(async (req, res) => {
  const { rows } = await q("SELECT r.*, o.merchant_txn_no, s.name AS store FROM refunds r JOIN payment_orders o ON o.id = r.order_id JOIN stores s ON s.id = r.store_id ORDER BY r.created_at DESC LIMIT 200");
  render(req, res, { title: "Refunds", active: "/admin/refunds", body: `<h1>Refunds</h1>${v.table(
    ["When", "Store", "Payment", { label: "Amount", n: true }, "Status", "Reason", "By"],
    rows.map((r) => [v.date(r.created_at), v.e(r.store), `<a href="/admin/payments/${r.order_id}">${v.e(r.merchant_txn_no)}</a>`, major(r.amount_minor, r.currency.trim()), v.statusTag(r.status), v.e(r.reason), v.e(r.requested_by)]))}` });
}));

// ---- Plans ----
router.get("/admin/plans", asyncHandler(async (req, res) => {
  const [prices, rates] = await Promise.all([
    q("SELECT * FROM plan_prices ORDER BY plan_code, billing_interval, currency"),
    q("SELECT * FROM plan_video_rates ORDER BY plan_code, video_type"),
  ]);
  const canEdit = req.staff.role === "admin";
  const row = (p) => [v.e(p.plan_code), v.e(p.billing_interval), v.e(p.currency.trim()),
    canEdit ? `<form class="inline" style="padding:0;border:0;margin:0" method="post" action="/admin/plans/price">${csrfField}<input type="hidden" name="plan" value="${v.e(p.plan_code)}"><input type="hidden" name="interval" value="${v.e(p.billing_interval)}"><input type="hidden" name="currency" value="${v.e(p.currency.trim())}">
      <input name="amount" type="number" step="0.01" value="${(p.amount_minor / 100).toFixed(2)}" style="width:110px"> <input name="budget" type="number" step="0.01" value="${(p.budget_usd_cents / 100).toFixed(2)}" style="width:110px"><button class="sec">Save</button></form>` : `${(p.amount_minor / 100).toFixed(2)} / ${(p.budget_usd_cents / 100).toFixed(2)}`];
  render(req, res, { title: "Plans", active: "/admin/plans", body: `<h1>Plans and prices</h1>
    <p class="muted">Price is what the merchant pays in that currency. Budget is the included video value per paid period, always in USD. INR prices seeded here are placeholders: confirm them before launch.</p>
    ${v.table(["Plan", "Interval", "Currency", "Price / budget"], prices.rows.map(row))}
    <h2>Video rates (USD, drawn from budget or credit)</h2>${v.table(["Plan", "Video type", "Rate"], rates.rows.map((r) => [v.e(r.plan_code), v.e(r.video_type),
      canEdit ? `<form class="inline" style="padding:0;border:0;margin:0" method="post" action="/admin/plans/rate">${csrfField}<input type="hidden" name="plan" value="${v.e(r.plan_code)}"><input type="hidden" name="type" value="${v.e(r.video_type)}"><input name="rate" type="number" step="0.01" value="${(r.usd_cents / 100).toFixed(2)}" style="width:110px"><button class="sec">Save</button></form>` : (r.usd_cents / 100).toFixed(2)]))}` });
}));

router.post("/admin/plans/price", requireAdminRole, asyncHandler(async (req, res) => {
  const amount = Math.round(Number(req.body.amount) * 100);
  const budget = Math.round(Number(req.body.budget) * 100);
  if (!(amount >= 0) || !(budget >= 0)) return back(res, "/admin/plans", null, "Enter valid amounts");
  await q("UPDATE plan_prices SET amount_minor = $4, budget_usd_cents = $5 WHERE plan_code = $1 AND billing_interval = $2 AND currency = $3", [req.body.plan, req.body.interval, req.body.currency, amount, budget]);
  billing.invalidateCatalogue();
  await audit.record({ actorType: "staff", actorId: req.staff.email, action: "plan.price_changed", after: req.body });
  back(res, "/admin/plans", "Price saved");
}));

router.post("/admin/plans/rate", requireAdminRole, asyncHandler(async (req, res) => {
  const cents = Math.round(Number(req.body.rate) * 100);
  if (!(cents > 0)) return back(res, "/admin/plans", null, "Enter a valid rate");
  await q("UPDATE plan_video_rates SET usd_cents = $3 WHERE plan_code = $1 AND video_type = $2", [req.body.plan, req.body.type, cents]);
  billing.invalidateCatalogue();
  await audit.record({ actorType: "staff", actorId: req.staff.email, action: "plan.rate_changed", after: req.body });
  back(res, "/admin/plans", "Rate saved");
}));

// ---- Audit log ----
router.get("/admin/audit", asyncHandler(async (req, res) => {
  const { rows } = await q("SELECT * FROM audit_log ORDER BY at DESC LIMIT 200");
  render(req, res, { title: "Audit log", active: "/admin/audit", body: `<h1>Audit log</h1>${v.table(
    ["When", "Who", "Action", "Store", "Details"],
    rows.map((a) => [v.date(a.at), v.e(`${a.actor_type}${a.actor_id ? `:${a.actor_id}` : ""}`), v.e(a.action), a.store_id ? `<a href="/admin/stores/${a.store_id}">${a.store_id}</a>` : "—", `<code>${v.e(JSON.stringify(a.after_state || {}).slice(0, 140))}</code>`]))}` });
}));

module.exports = router;
