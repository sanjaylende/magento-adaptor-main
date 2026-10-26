// ICICI refunds and cancellations end to end: a real database, the real routes and the pretend bank (test/fakeIcici.js, which can be told
// to accept, decline, stay pending, answer at once, time out or return a 503). Money here is the plan and credit that merchants pay Flipick;
// there are no Magento store orders involved.
const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers");

h.useTestEnvironment();

describe("ICICI cancel and refund", () => {
  let fakeMagento, httpServer, db, payments, billing, tenants;
  let A, sessionA, sessionB, storeA;
  const BASE = () => `http://127.0.0.1:${h.ADAPTER_PORT}`;
  const staff = { type: "staff", id: "t@test.local" };
  const txnOf = (redirectUrl) => new URL(redirectUrl).searchParams.get("tranCtx");

  before(async () => {
    await h.resetDatabase();
    fakeMagento = await h.startFakeMagento();
    const { runMigrations, syncEntityTypes } = require("../src/db/migrate");
    await runMigrations();
    await syncEntityTypes([require("../src/models/VideoSlot"), require("../src/models/VideoVersion"), require("../src/models/StoreSetting")]);
    db = require("../src/db/connection");
    payments = require("../src/services/paymentService");
    billing = require("../src/services/billingService");
    tenants = require("../src/services/tenantService");
    httpServer = require("../src/app").createApp().listen(h.ADAPTER_PORT);
    const reg = async (host, name) => { // a different host name for the same fake Magento is a different installation
      const r = await h.api("POST", "/api/v1/register", { body: { baseUrl: `http://${host}:${h.MAGENTO_PORT}`, magentoToken: "good-token", merchantName: name, contactEmail: `${name.replace(/\s/g, "").toLowerCase()}@test.local`, countryCode: "US" } });
      assert.equal(r.status, 201);
      const installationId = (await tenants.getInstallationByKey(r.body.installKey)).id;
      const session = await h.api("POST", "/api/session", { body: { launch: h.launchToken({ installKey: r.body.installKey, secret: r.body.secret, websiteId: 1 }) } });
      assert.equal(session.status, 200);
      return { installation: { ...r.body, installationId }, token: session.body.token };
    };
    const a = await reg("127.0.0.1", "Refund Store A");
    const b = await reg("localhost", "Refund Store B");
    A = a.installation; sessionA = a.token; sessionB = b.token;
    storeA = await tenants.getStore(A.installationId, 1);
  });

  after(async () => {
    httpServer && httpServer.close();
    fakeMagento && fakeMagento.close();
    await db.close();
  });

  beforeEach(() => h.icici.resetRefund());

  const newTopup = async (token = sessionA) => {
    const made = await h.api("POST", "/api/billing/checkout", { token, body: { kind: "topup", packUsdCents: 1000, currency: "USD" } });
    assert.equal(made.status, 201);
    return { id: made.body.orderId, txn: txnOf(made.body.redirectUrl) };
  };
  const paidTopup = async () => {
    const o = await newTopup();
    await h.icici.pay(BASE(), o.txn, "paid");
    assert.equal((await orderRow(o.id)).status, "paid");
    return o;
  };
  const orderRow = async (id) => (await db.asSystem(() => db.query("SELECT * FROM payment_orders WHERE id = $1", [id]))).rows[0];
  const refundRows = async (orderId) => (await db.asSystem(() => db.query("SELECT * FROM refunds WHERE order_id = $1 ORDER BY created_at", [orderId]))).rows;
  const refund = (orderId, amountMinor, extra = {}) => payments.refundOrder({ orderId, amountMinor, reason: "Customer request", actor: staff, ...extra });
  // read as the system: the credit rows belong to the store and row-level security hides them from a connection with no store context
  const balance = async () => Number(await db.asSystem(() => billing.creditBalance(storeA.id)));

  describe("refund", () => {
    it("sends one signed REFUND to the bank for a paid order, keeps the bank's reference and answer (without its hash), and settles it later", async () => {
      const o = await paidTopup();
      const total = (await orderRow(o.id)).total_minor;
      const r = await refund(o.id, total);
      assert.equal(r.status, "processing");
      const calls = h.icici.refundCalls();
      assert.equal(calls.length, 1);
      assert.equal(calls[0].originalTxnNo, o.txn);
      assert.equal(calls[0].amount, (total / 100).toFixed(2));
      assert.equal(calls[0].signed, true, "the request carries a valid signature");
      const [row] = await refundRows(o.id);
      assert.match(row.gateway_ref, /^RF/);
      assert.equal(row.gateway_txn_id, `BANKRF-${row.gateway_ref}`);
      assert.equal(row.gateway_response.responseCode, "R1000");
      assert.equal("secureHash" in row.gateway_response, false, "the bank's hash is not stored");
      assert.equal((await orderRow(o.id)).status, "paid", "not refunded until the bank confirms");
      await payments.settleProcessingRefunds();
      assert.equal((await orderRow(o.id)).status, "refunded");
      assert.equal((await refundRows(o.id))[0].status, "succeeded");
    });

    it("validates the amount: zero, negative, fractional and more than was paid are refused before the bank is called", async () => {
      const o = await paidTopup();
      const total = (await orderRow(o.id)).total_minor;
      for (const bad of [0, -100, 12.5, NaN]) await assert.rejects(() => refund(o.id, bad), /must be positive/, String(bad));
      await assert.rejects(() => refund(o.id, total + 1), /more than what was paid/);
      await assert.rejects(() => refund(o.id, 100, { reason: "" }), /reason is required/);
      assert.equal(h.icici.refundCalls().length, 0);
      assert.equal((await refundRows(o.id)).length, 0);
    });

    it("partial refunds add up: the order is partially refunded, then fully refunded, and nothing beyond the total is possible", async () => {
      const o = await paidTopup();
      const total = (await orderRow(o.id)).total_minor;
      await refund(o.id, 400);
      await payments.settleProcessingRefunds();
      assert.equal((await orderRow(o.id)).status, "partially_refunded");
      await assert.rejects(() => refund(o.id, total - 400 + 1), /more than what was paid/);
      await refund(o.id, total - 400);
      await payments.settleProcessingRefunds();
      assert.equal((await orderRow(o.id)).status, "refunded");
      await assert.rejects(() => refund(o.id, 1), /Only paid orders/);
    });

    it("an amount still being refunded counts against the total, so two quick refunds cannot together exceed it", async () => {
      const o = await paidTopup();
      const total = (await orderRow(o.id)).total_minor;
      await refund(o.id, total - 100); // accepted, not yet settled
      await assert.rejects(() => refund(o.id, 200), /more than what was paid/);
      await refund(o.id, 100);
      assert.equal(h.icici.refundCalls().length, 2);
    });

    it("the same request key refunds once: a repeat or a double submit returns the refund already made and sends nothing to the bank", async () => {
      const o = await paidTopup();
      const first = await refund(o.id, 300, { idempotencyKey: "key-1" });
      const again = await refund(o.id, 300, { idempotencyKey: "key-1" });
      assert.equal(first.duplicate, false);
      assert.equal(again.duplicate, true);
      assert.equal(again.refundId, first.refundId);
      assert.equal(h.icici.refundCalls().length, 1);
      assert.equal((await refundRows(o.id)).length, 1);
      await assert.rejects(() => refund(o.id, 301, { idempotencyKey: "key-1" }), (err) => err.status === 409);
      const other = await refund(o.id, 300, { idempotencyKey: "key-2" }); // a different key is a different refund
      assert.notEqual(other.refundId, first.refundId);
      assert.equal(h.icici.refundCalls().length, 2);
    });

    it("two identical requests arriving at the same moment still refund once", async () => {
      const o = await paidTopup();
      const [x, y] = await Promise.all([refund(o.id, 250, { idempotencyKey: "race" }), refund(o.id, 250, { idempotencyKey: "race" })]);
      assert.deepEqual([x.duplicate, y.duplicate].sort(), [false, true]);
      assert.equal(h.icici.refundCalls().length, 1);
      assert.equal((await refundRows(o.id)).length, 1);
    });

    it("a refund the bank declines is recorded as failed with the bank's reason and the order is NOT marked refunded", async () => {
      const o = await paidTopup();
      h.icici.setRefundMode("decline");
      await assert.rejects(() => refund(o.id, 500), (err) => err.status === 502 && /E1100/.test(err.message));
      const [row] = await refundRows(o.id);
      assert.equal(row.status, "failed");
      assert.match(row.failure_reason, /E1100.*exceeds/);
      assert.equal(row.gateway_response.responseCode, "E1100");
      assert.equal((await orderRow(o.id)).status, "paid");
      h.icici.setRefundMode("accept"); // a failed refund can be asked for again
      assert.equal((await refund(o.id, 500)).status, "processing");
    });

    it("a refund the bank accepts and later rejects ends failed, the order stays paid, and the reason is kept", async () => {
      const o = await paidTopup();
      await refund(o.id, 500);
      h.icici.setRefundStatus("rejected");
      await payments.settleProcessingRefunds();
      const [row] = await refundRows(o.id);
      assert.equal(row.status, "failed");
      assert.match(row.failure_reason, /rejected by the issuer/);
      assert.equal((await orderRow(o.id)).status, "paid");
    });

    it("a refund the bank accepts and then declines with 039 (no txnStatus, as the UAT sandbox did) ends failed with the bank's reason; an unfamiliar answer keeps waiting", async () => {
      const o = await paidTopup();
      const r = await refund(o.id, 500);
      assert.equal(r.status, "processing");
      h.icici.setRefundStatus("unfamiliar");
      await payments.settleProcessingRefunds();
      assert.equal((await refundRows(o.id))[0].status, "processing", "an answer the adapter does not know is not turned into a failure");
      h.icici.setRefundStatus("declined");
      await payments.settleProcessingRefunds();
      const [row] = await refundRows(o.id);
      assert.equal(row.status, "failed");
      assert.equal(row.failure_reason, "Transaction Declined");
      assert.equal(row.gateway_response.responseCode, "039", "the bank's latest answer, the decline, is the one kept");
      assert.equal(row.gateway_txn_id, `BANKRF-${row.gateway_ref}`, "the bank's transaction id from when it accepted the request is kept");
      assert.equal((await orderRow(o.id)).status, "paid", "a declined refund never marks the order refunded");
      const again = await payments.settleProcessingRefunds(); // nothing left to settle
      assert.equal(again, 0);
      h.icici.setRefundStatus("success");
      assert.equal((await refund(o.id, 500)).status, "processing", "a new refund can be asked for");
    });

    it("a refund the bank leaves pending stays 'processing' and is settled when the bank decides", async () => {
      const o = await paidTopup();
      h.icici.setRefundMode("pending");
      assert.equal((await refund(o.id, 500)).status, "processing");
      h.icici.setRefundStatus("pending");
      await payments.settleProcessingRefunds();
      assert.equal((await refundRows(o.id))[0].status, "processing");
      h.icici.setRefundStatus("success");
      await payments.settleProcessingRefunds();
      assert.equal((await refundRows(o.id))[0].status, "succeeded");
    });

    it("a refund the bank answers at once is succeeded straight away, with a credit note", async () => {
      const o = await paidTopup();
      h.icici.setRefundMode("immediate");
      const total = (await orderRow(o.id)).total_minor;
      assert.equal((await refund(o.id, total)).status, "succeeded");
      assert.equal((await orderRow(o.id)).status, "refunded");
      const notes = (await db.asSystem(() => db.query("SELECT * FROM invoices WHERE order_id = $1 AND kind = 'credit_note'", [o.id]))).rows;
      assert.equal(notes.length, 1);
      assert.equal(Number(notes[0].total_minor), -total);
    });

    it("no answer from the bank (timeout or 503) is not a decline: the refund waits as 'processing', the order is unchanged, and the bank's later answer settles it", async () => {
      for (const mode of ["timeout", "http503"]) {
        const o = await paidTopup();
        h.icici.setRefundMode(mode);
        const r = await refund(o.id, 500);
        assert.equal(r.status, "processing", mode);
        const [row] = await refundRows(o.id);
        assert.match(row.failure_reason, /Outcome unknown/, mode);
        assert.match(row.gateway_ref, /^RF/);
        assert.equal((await orderRow(o.id)).status, "paid");
        h.icici.setRefundMode("accept");
        h.icici.setRefundStatus("success"); // the bank had received it after all
        await payments.settleProcessingRefunds();
        const [after] = await refundRows(o.id);
        assert.equal(after.status, "succeeded", mode);
        assert.equal(after.failure_reason, null, "the waiting note is gone once settled");
        assert.equal((await orderRow(o.id)).status, "partially_refunded", mode);
      }
    });

    it("a refund with no answer and no record at the bank after a day is closed as failed, so it can be checked and asked for again", async () => {
      const o = await paidTopup();
      h.icici.setRefundMode("timeout");
      const r = await refund(o.id, 500);
      h.icici.setRefundMode("accept");
      h.icici.setRefundStatus("pending"); // the bank knows nothing about it
      await payments.settleProcessingRefunds();
      assert.equal((await refundRows(o.id))[0].status, "processing", "not given up yet");
      await db.asSystem(() => db.query("UPDATE refunds SET created_at = now() - interval '25 hours' WHERE id = $1", [r.refundId]));
      await payments.settleProcessingRefunds();
      const [row] = await refundRows(o.id);
      assert.equal(row.status, "failed");
      assert.match(row.failure_reason, /no record of this refund after 24 hours/);
      h.icici.setRefundStatus("success");
      assert.equal((await refund(o.id, 500)).status, "processing", "asking again is now allowed");
    });

    it("only paid orders can be refunded: an unpaid, failed, canceled or unknown order is refused", async () => {
      const pending = await newTopup();
      await assert.rejects(() => refund(pending.id, 100), /Only paid orders/);
      await payments.cancelOrder({ orderId: pending.id, actor: staff });
      await assert.rejects(() => refund(pending.id, 100), /Only paid orders/);
      const failed = await newTopup();
      await h.icici.pay(BASE(), failed.txn, "failed");
      await assert.rejects(() => refund(failed.id, 100), /Only paid orders/);
      await assert.rejects(() => refund("00000000-0000-0000-0000-000000000000", 100), (err) => err.status === 404);
      assert.equal(h.icici.refundCalls().length, 0);
    });
  });

  describe("cancel", () => {
    it("an unpaid order is canceled after the bank says it is not paid; who and when are recorded; a second cancel is refused", async () => {
      const o = await newTopup();
      const r = await payments.cancelOrder({ orderId: o.id, actor: staff });
      assert.equal(r.outcome, "canceled");
      const row = await orderRow(o.id);
      assert.equal(row.status, "canceled");
      assert.equal(row.canceled_by, "staff:t@test.local");
      assert.ok(row.canceled_at);
      const attempts = (await db.asSystem(() => db.query("SELECT status FROM payment_attempts WHERE order_id = $1", [o.id]))).rows.map((a) => a.status);
      assert.ok(attempts.includes("canceled"));
      await assert.rejects(() => payments.cancelOrder({ orderId: o.id, actor: staff }), (err) => err.status === 409 && err.code === "already_canceled");
    });

    it("if the bank says the order is PAID, it is not canceled: it is recorded as paid (and granted) and the caller is told to refund instead", async () => {
      const o = await newTopup();
      const before = await balance();
      h.icici.setResult(o.txn, "paid"); // paid at the bank, the return has not arrived yet
      await assert.rejects(() => payments.cancelOrder({ orderId: o.id, actor: staff }), (err) => err.status === 409 && err.code === "already_paid" && /Refund it instead/.test(err.message));
      assert.equal((await orderRow(o.id)).status, "paid");
      assert.equal(await balance() - before, 1000, "the credit was granted, as for any payment");
      const invoices = (await db.asSystem(() => db.query("SELECT 1 FROM invoices WHERE order_id = $1 AND kind = 'invoice'", [o.id]))).rows;
      assert.equal(invoices.length, 1);
    });

    it("if the bank says the payment failed, it is recorded as failed", async () => {
      const o = await newTopup();
      h.icici.setResult(o.txn, "failed");
      const r = await payments.cancelOrder({ orderId: o.id, actor: staff });
      assert.equal(r.outcome, "failed");
      assert.equal((await orderRow(o.id)).status, "failed");
    });

    it("if the bank cannot be asked, nothing is canceled (an order that may be paid is never canceled blind)", async () => {
      const o = await newTopup();
      h.icici.setStatusDown(true);
      await assert.rejects(() => payments.cancelOrder({ orderId: o.id, actor: staff }), (err) => err.status === 503 && err.code === "bank_unreachable");
      assert.equal((await orderRow(o.id)).status, "pending");
      h.icici.setStatusDown(false);
      assert.equal((await payments.cancelOrder({ orderId: o.id, actor: staff })).outcome, "canceled");
    });

    it("a paid, partly refunded, refunded, failed or unknown order cannot be canceled", async () => {
      const paid = await paidTopup();
      await assert.rejects(() => payments.cancelOrder({ orderId: paid.id, actor: staff }), (err) => err.status === 409 && err.code === "already_paid");
      await refund(paid.id, 100);
      await payments.settleProcessingRefunds();
      await assert.rejects(() => payments.cancelOrder({ orderId: paid.id, actor: staff }), (err) => err.code === "already_paid");
      const failed = await newTopup();
      await h.icici.pay(BASE(), failed.txn, "failed");
      await assert.rejects(() => payments.cancelOrder({ orderId: failed.id, actor: staff }), (err) => err.code === "already_failed");
      await assert.rejects(() => payments.cancelOrder({ orderId: "00000000-0000-0000-0000-000000000000", actor: staff }), (err) => err.status === 404);
    });

    it("a payment that arrives AFTER an order was canceled on purpose is refunded in full, nothing is granted, and a repeat changes nothing", async () => {
      const o = await newTopup();
      await payments.cancelOrder({ orderId: o.id, actor: staff });
      const before = await balance();
      await h.icici.pay(BASE(), o.txn, "paid"); // the customer still finished paying on the bank page
      await payments.settleProcessingRefunds();
      const row = await orderRow(o.id);
      assert.equal(row.status, "refunded");
      assert.equal(await balance(), before, "no credit was granted");
      const refunds = await refundRows(o.id);
      assert.equal(refunds.length, 1);
      assert.equal(refunds[0].status, "succeeded");
      assert.match(refunds[0].reason, /after the order was canceled/);
      assert.equal(Number(refunds[0].amount_minor), Number(row.total_minor));
      assert.equal(refunds[0].requested_by, "system:late-payment-after-cancel");
      await h.icici.pay(BASE(), o.txn, "paid"); // the bank repeats its message
      assert.equal((await refundRows(o.id)).length, 1);
      assert.equal(h.icici.refundCalls().length, 1);
    });

    it("the scheduled check finds a late payment on a canceled order even when the browser never returns", async () => {
      const o = await newTopup();
      await payments.cancelOrder({ orderId: o.id, actor: staff });
      const before = await balance();
      h.icici.setResult(o.txn, "paid");
      await payments.reconcilePending();
      await payments.settleProcessingRefunds();
      assert.equal((await orderRow(o.id)).status, "refunded");
      assert.equal(await balance(), before);
      assert.equal(h.icici.refundCalls().length, 1);
    });

    it("an unpaid plan order canceled on purpose does not activate the plan if it is paid late", async () => {
      const made = await h.api("POST", "/api/billing/checkout", { token: sessionA, body: { kind: "plan", tier: "starter", cycle: "monthly", currency: "USD" } });
      assert.equal(made.status, 201);
      const txn = txnOf(made.body.redirectUrl);
      const planBefore = (await db.asSystem(() => db.query("SELECT plan_code FROM store_subscriptions WHERE store_id = $1", [storeA.id]))).rows[0].plan_code;
      await payments.cancelOrder({ orderId: made.body.orderId, actor: staff });
      await h.icici.pay(BASE(), txn, "paid");
      await payments.settleProcessingRefunds();
      const planAfter = (await db.asSystem(() => db.query("SELECT plan_code FROM store_subscriptions WHERE store_id = $1", [storeA.id]))).rows[0].plan_code;
      assert.equal(planAfter, planBefore);
      assert.equal((await orderRow(made.body.orderId)).status, "refunded");
    });
  });

  describe("merchant API", () => {
    const cancelCall = (id, token) => h.api("POST", `/api/billing/orders/${id}/cancel`, { token, body: {} });

    it("a merchant cancels their own unpaid payment", async () => {
      const o = await newTopup();
      const r = await cancelCall(o.id, sessionA);
      assert.equal(r.status, 200);
      assert.deepEqual({ status: r.body.status, outcome: r.body.outcome }, { status: "canceled", outcome: "canceled" });
      assert.equal((await orderRow(o.id)).canceled_by, `merchant:${A.installationId}`);
      const again = await cancelCall(o.id, sessionA);
      assert.equal(again.status, 409);
      assert.equal(again.body.code, "already_canceled");
    });

    it("a merchant cannot cancel another store's payment, and an unauthenticated call is refused", async () => {
      const o = await newTopup(sessionA);
      assert.equal((await cancelCall(o.id, sessionB)).status, 404);
      assert.equal((await cancelCall(o.id, undefined)).status, 401);
      assert.equal((await orderRow(o.id)).status, "pending");
    });

    it("when the bank says it is already paid the merchant is told so (409 already_paid) and the payment is kept", async () => {
      const o = await newTopup();
      h.icici.setResult(o.txn, "paid");
      const r = await cancelCall(o.id, sessionA);
      assert.equal(r.status, 409);
      assert.equal(r.body.code, "already_paid");
      assert.match(r.body.error, /paid/);
      assert.equal((await orderRow(o.id)).status, "paid");
    });

    it("the merchant's page can follow up: canceled orders show as canceled in the order status and the history", async () => {
      const o = await newTopup();
      await cancelCall(o.id, sessionA);
      const status = await h.api("GET", `/api/billing/orders/${o.id}`, { token: sessionA });
      assert.equal(status.body.status, "canceled");
      const history = await h.api("GET", "/api/billing/history", { token: sessionA });
      assert.equal(history.body.orders.find((x) => x.id === o.id).status, "canceled");
    });
  });

  describe("staff console", () => {
    let cookie;
    const form = (path, fields) => fetch(BASE() + path, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie }, body: new URLSearchParams(fields) });
    const page = async (path) => (await fetch(BASE() + path, { headers: { Cookie: cookie } })).text();
    const flash = (res) => decodeURIComponent((res.headers.get("location").match(/[?&](?:ok|err)=([^&]*)/) || [])[1] || "");

    before(async () => {
      await db.asSystem(() => db.query("DELETE FROM rate_limits"));
      const login = await fetch(`${BASE()}/admin/login`, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email: "staff@test.local", password: "staff-password-1" }) });
      assert.equal(login.status, 302);
      cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("fl_admin="));
    });

    it("the refund form carries a request key, and submitting the same form twice refunds once", async () => {
      const o = await paidTopup();
      const html = await page(`/admin/payments/${o.id}`);
      const csrf = html.match(/name="_csrf" value="([^"]+)"/)[1];
      const idem = html.match(/name="idem" value="([^"]+)"/)[1];
      const fields = { _csrf: csrf, amount: "4.00", reason: "double click", entitlement: "none", idem };
      const first = await form(`/admin/payments/${o.id}/refund`, fields);
      assert.equal(first.status, 302);
      assert.match(flash(first), /accepted by the bank/);
      const second = await form(`/admin/payments/${o.id}/refund`, fields);
      assert.match(flash(second), /already requested/);
      assert.equal(h.icici.refundCalls().length, 1);
      assert.equal((await refundRows(o.id)).length, 1);
      const refreshed = await page(`/admin/payments/${o.id}`);
      assert.notEqual(refreshed.match(/name="idem" value="([^"]+)"/)[1], idem, "every page view gets a fresh key");
    });

    it("a refund the bank declines shows its reason to staff and leaves the order paid", async () => {
      const o = await paidTopup();
      h.icici.setRefundMode("decline");
      const html = await page(`/admin/payments/${o.id}`);
      const res = await form(`/admin/payments/${o.id}/refund`, { _csrf: html.match(/name="_csrf" value="([^"]+)"/)[1], amount: "4.00", reason: "test", entitlement: "none", idem: html.match(/name="idem" value="([^"]+)"/)[1] });
      assert.match(flash(res), /E1100/);
      assert.equal((await orderRow(o.id)).status, "paid");
      assert.match(await page(`/admin/payments/${o.id}`), /Refund amount exceeds the transaction/);
    });

    it("an unpaid payment has a Cancel button that asks the bank first; a paid one has none", async () => {
      const o = await newTopup();
      const html = await page(`/admin/payments/${o.id}`);
      assert.match(html, /Cancel this unpaid payment/);
      const res = await form(`/admin/payments/${o.id}/cancel`, { _csrf: html.match(/name="_csrf" value="([^"]+)"/)[1] });
      assert.equal(res.status, 302);
      assert.match(flash(res), /Payment canceled/);
      assert.equal((await orderRow(o.id)).canceled_by, "staff:staff@test.local");
      const paid = await paidTopup();
      assert.doesNotMatch(await page(`/admin/payments/${paid.id}`), /Cancel this unpaid payment/);
    });

    it("canceling needs a valid form token, and a payment the bank reports as paid is not canceled from the console either", async () => {
      const o = await newTopup();
      assert.equal((await form(`/admin/payments/${o.id}/cancel`, {})).status, 403);
      assert.equal((await form(`/admin/payments/${o.id}/cancel`, { _csrf: "deadbeef" })).status, 403);
      assert.equal((await orderRow(o.id)).status, "pending");
      h.icici.setResult(o.txn, "paid");
      const html = await page(`/admin/payments/${o.id}`);
      const res = await form(`/admin/payments/${o.id}/cancel`, { _csrf: html.match(/name="_csrf" value="([^"]+)"/)[1] });
      assert.match(flash(res), /already paid|recorded as paid/);
      assert.equal((await orderRow(o.id)).status, "paid");
    });
  });

  describe("ICICI refusals and the merchant's order poll", () => {
    let config, gateway, savedDelays, savedInterval;
    before(() => {
      config = require("../src/config");
      gateway = require("../src/payments/IciciGateway");
      savedDelays = [...gateway.retry.delaysMs];
      savedInterval = config.billing.orderCheckMinIntervalMs;
      gateway.retry.delaysMs = [0, 0]; // no waiting between attempts in tests
    });
    after(() => { gateway.retry.delaysMs = savedDelays; config.billing.orderCheckMinIntervalMs = savedInterval; });
    beforeEach(() => { config.billing.orderCheckMinIntervalMs = 0; });
    const poll = (id, token = sessionA) => h.api("GET", `/api/billing/orders/${id}`, { token });
    const returnForm = (txn, result = "paid") => fetch(`${BASE()}/billing/return?gw=icici`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(h.icici.returnForm(txn, result)) });

    it("the poll rides out two refusals in a row: three status checks, and the order is paid", async () => {
      const o = await newTopup();
      h.icici.setResult(o.txn, "paid");
      h.icici.setStatusRefuseNext(2);
      const r = await poll(o.id);
      assert.equal(r.body.status, "paid");
      assert.equal(h.icici.statusCount(o.txn), 1, "only the third attempt reached the bank's own status service");
    });

    it("three refusals in a row leave the order pending (never failed); the next poll gets through and pays it", async () => {
      const o = await newTopup();
      h.icici.setResult(o.txn, "paid");
      h.icici.setStatusRefuseNext(3);
      assert.equal((await poll(o.id)).body.status, "pending");
      assert.equal((await orderRow(o.id)).failure_reason, null);
      assert.equal((await poll(o.id)).body.status, "paid");
    });

    it("the poll asks the bank at most once per interval for an order, and a browser return is not held back by that", async () => {
      config.billing.orderCheckMinIntervalMs = 60000;
      const o = await newTopup();
      assert.equal((await poll(o.id)).body.status, "pending");
      assert.equal(h.icici.statusCount(o.txn), 1);
      for (let i = 0; i < 5; i++) await poll(o.id);
      assert.equal(h.icici.statusCount(o.txn), 1, "six polls, one call to the bank");
      h.icici.setResult(o.txn, "paid");
      assert.equal((await poll(o.id)).body.status, "pending", "inside the interval the stored state is what the page gets");
      const page = await (await returnForm(o.txn)).text(); // the browser comes back from the bank page: asked at once
      assert.match(page, /Payment received/);
      assert.equal((await orderRow(o.id)).status, "paid");
    });

    it("an order that is checked for the first time is asked at once, and every order has its own interval", async () => {
      config.billing.orderCheckMinIntervalMs = 60000;
      const a = await newTopup();
      const b = await newTopup();
      await poll(a.id);
      await poll(b.id);
      assert.equal(h.icici.statusCount(a.txn), 1);
      assert.equal(h.icici.statusCount(b.txn), 1);
    });

    it("the bank says paid in its signed message but cannot be asked: the page says the payment was received and is being confirmed, not that it could not be verified; the scheduler confirms it later", async () => {
      const o = await newTopup();
      h.icici.setResult(o.txn, "paid");
      h.icici.setStatusDown(true);
      const page = await (await returnForm(o.txn)).text();
      assert.match(page, /Payment received/);
      assert.match(page, /confirming it with the bank/);
      assert.doesNotMatch(page, /could not verify/);
      assert.equal((await orderRow(o.id)).status, "pending", "nothing is granted until the bank confirms");
      h.icici.setStatusDown(false);
      await db.asSystem(() => db.query("UPDATE payment_orders SET created_at = now() - interval '3 minutes' WHERE id = $1", [o.id]));
      await payments.reconcilePending();
      assert.equal((await orderRow(o.id)).status, "paid");
    });

    it("a signed message that says the payment FAILED, with the bank not answering, is still reported as an error, not as received money", async () => {
      const o = await newTopup();
      h.icici.setStatusDown(true);
      const page = await (await returnForm(o.txn, "failed")).text();
      assert.doesNotMatch(page, /Payment received/);
      assert.match(page, /could not verify/);
      h.icici.setStatusDown(false);
    });

    it("the bank's server-to-server message gets a 503 when it could not be confirmed yet (so the bank can send it again), and 200 once it can", async () => {
      const o = await newTopup();
      h.icici.setResult(o.txn, "paid");
      h.icici.setStatusDown(true);
      const send = () => fetch(`${BASE()}/api/payments/callback/icici`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(h.icici.returnForm(o.txn, "paid")) });
      const first = await send();
      assert.equal(first.status, 503);
      assert.equal((await orderRow(o.id)).status, "pending");
      h.icici.setStatusDown(false);
      const second = await send();
      assert.equal(second.status, 200);
      assert.equal((await orderRow(o.id)).status, "paid");
    });
  });

});
