// Payment orders, gateway results, refunds and invoices.
//
// Rules this module enforces:
//   * A plan or credit is only granted after the gateway's own status check says "paid" for the right amount. A browser
//     redirect or a callback alone never activates anything.
//   * Gateway results are processed idempotently: a duplicate or out-of-order callback changes nothing.
//   * Money is integer minor units (cents/paise); order totals never change after creation.
const crypto = require("crypto");
const config = require("../config");
const logger = require("../utils/logger");
const { query, tx, asSystem, currentStoreId } = require("../db/connection");
const { tenant } = require("../context");
const { getGateway } = require("../payments");
const rules = require("./billingRules");
const billing = require("./billingService");
const audit = require("./auditService");

const httpError = (status, message) => Object.assign(new Error(message), { status, userMessage: message });

const mapOrder = (r) => r && ({
  id: r.id, storeId: r.store_id, merchantId: r.merchant_id, kind: r.kind, planCode: r.plan_code, billingInterval: r.billing_interval,
  topupUsdCents: r.topup_usd_cents, currency: r.currency.trim(), subtotalMinor: r.subtotal_minor, taxMinor: r.tax_minor,
  totalMinor: r.total_minor, taxRateBp: r.tax_rate_bp, status: r.status, gateway: r.gateway, merchantTxnNo: r.merchant_txn_no,
  gatewayRef: r.gateway_ref, redirectUrl: r.redirect_url, failureReason: r.failure_reason, canceledBy: r.canceled_by,
  createdAt: new Date(r.created_at).toISOString(), paidAt: r.paid_at && new Date(r.paid_at).toISOString(),
});

const newTxnNo = () => `FL${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(3).toString("hex").toUpperCase()}`;

async function getMerchant(merchantId) {
  const { rows: [m] } = await query("SELECT * FROM merchants WHERE id = $1", [merchantId]);
  return m;
}

// ---------------------------------------------------------------------------------------------------------------------
// Creating orders

// Price of what the merchant is buying, in the chosen currency: { subtotalMinor, planCode, interval, topupUsdCents }.
async function priceItem({ kind, planCode, interval, currency, topupUsdCents }) {
  if (!["USD", "INR"].includes(currency)) throw httpError(400, "Currency must be USD or INR");
  if (kind === "plan") {
    const catalogue = await billing.loadCatalogue();
    const price = catalogue.plans[planCode]?.prices?.[interval]?.[currency];
    if (!price || planCode === "trial") throw httpError(400, "That plan is not available");
    return { subtotalMinor: price.amountMinor, planCode, interval };
  }
  if (kind === "topup") {
    if (!config.billing.topupPacksUsd.includes(topupUsdCents)) throw httpError(400, "That credit pack does not exist");
    return { subtotalMinor: currency === "USD" ? topupUsdCents : topupUsdCents * config.billing.inrPerUsd, topupUsdCents };
  }
  throw httpError(400, "Unknown order kind");
}

// Creates the order for the ambient store and starts the gateway payment. Returns { order, redirectUrl }.
async function createOrder({ kind, planCode, interval, currency, topupUsdCents, idempotencyKey = null }) {
  const { store, installation } = tenant();
  const merchant = await getMerchant(installation.merchantId);
  const item = await priceItem({ kind, planCode, interval, currency, topupUsdCents });
  const tax = rules.taxFor({ subtotalMinor: item.subtotalMinor, currency, countryCode: merchant.country_code, gstRateBp: config.billing.gstRateBp });
  const gateway = getGateway();

  const { rows: [row] } = await query(
    `INSERT INTO payment_orders (store_id, merchant_id, kind, plan_code, billing_interval, topup_usd_cents, currency, subtotal_minor,
                                 tax_minor, total_minor, tax_rate_bp, gateway, merchant_txn_no, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
    [store.id, merchant.id, kind, item.planCode || null, item.interval || null, item.topupUsdCents || null, currency, item.subtotalMinor,
      tax.taxMinor, tax.totalMinor, tax.rateBp, gateway.name, newTxnNo(), idempotencyKey]
  );
  const order = mapOrder(row);
  try {
    const started = await gateway.createPayment(order, {
      returnUrl: `${config.publicBaseUrl}/billing/return?gw=${gateway.name}`,
      customerEmail: merchant.contact_email, customerName: merchant.name,
    });
    await query("UPDATE payment_orders SET status = 'pending', redirect_url = $2, gateway_ref = COALESCE($3, gateway_ref) WHERE id = $1", [order.id, started.redirectUrl, started.gatewayRef || null]);
    await query("INSERT INTO payment_attempts (order_id, status, response) VALUES ($1, 'initiated', $2)", [order.id, JSON.stringify({ redirectUrl: started.redirectUrl })]);
    logger.info("Payment order created", { orderId: order.id, kind, gateway: gateway.name, totalMinor: tax.totalMinor, currency, storeId: store.id });
    await audit.record({ actorType: "merchant", merchantId: merchant.id, installationId: installation.id, storeId: store.id, action: "payment.order_created", after: { orderId: order.id, kind, total: tax.totalMinor, currency } });
    return { order: { ...order, status: "pending", redirectUrl: started.redirectUrl }, redirectUrl: started.redirectUrl };
  } catch (err) {
    logger.error("Gateway could not start the payment", { orderId: order.id, gateway: gateway.name, error: err });
    await query("UPDATE payment_orders SET status = 'failed', failure_reason = $2 WHERE id = $1", [order.id, err.message.slice(0, 500)]);
    throw err;
  }
}

async function getOrder(orderId) {
  const { rows: [row] } = await query("SELECT * FROM payment_orders WHERE id = $1", [orderId]);
  return mapOrder(row);
}

// Orders and invoices of the ambient store, newest first (merchant payment history).
async function listHistory(limit = 50) {
  const { rows: orders } = await query("SELECT * FROM payment_orders WHERE store_id = $1 ORDER BY created_at DESC LIMIT $2", [currentStoreId(), limit]);
  const { rows: invoices } = await query("SELECT id, number, kind, order_id, total_minor, currency, issued_at FROM invoices WHERE store_id = $1 ORDER BY issued_at DESC LIMIT 200", [currentStoreId()]);
  const { rows: refunds } = await query("SELECT id, order_id, amount_minor, currency, status, reason, created_at FROM refunds WHERE store_id = $1 ORDER BY created_at DESC LIMIT 200", [currentStoreId()]);
  return orders.map(mapOrder).map((o) => ({
    ...o,
    invoices: invoices.filter((i) => i.order_id === o.id).map((i) => ({ id: i.id, number: i.number, kind: i.kind, totalMinor: i.total_minor, issuedAt: new Date(i.issued_at).toISOString() })),
    refunds: refunds.filter((r) => r.order_id === o.id).map((r) => ({ id: r.id, amountMinor: r.amount_minor, status: r.status, reason: r.reason, createdAt: new Date(r.created_at).toISOString() })),
  }));
}

// ---------------------------------------------------------------------------------------------------------------------
// Gateway results

// Applies one gateway result (already verified/normalised) to its order. Safe to call any number of times.
// result: { merchantTxnNo, status: 'paid'|'failed'|'pending', gatewayRef, amountMinor, currency, failureReason, raw }
async function applyGatewayResult(gatewayName, result, { eventKey } = {}) {
  let lateRefund = null; // set when the bank took the money for an order that was canceled on purpose
  const applied = await asSystem(() => tx(async () => {
    const { rows: [row] } = await query("SELECT * FROM payment_orders WHERE merchant_txn_no = $1 FOR UPDATE", [result.merchantTxnNo]);
    if (!row) throw httpError(404, "Unknown payment reference");
    const order = mapOrder(row);

    const key = eventKey || `${result.merchantTxnNo}:${result.status}:${result.gatewayRef || ""}`;
    const inserted = await query(
      "INSERT INTO gateway_events (gateway, event_key, order_id, payload) VALUES ($1, $2, $3, $4) ON CONFLICT (gateway, event_key) DO NOTHING",
      [gatewayName, key, order.id, JSON.stringify(result.raw || result)]
    );
    // The same event again: nothing to do (the first run already applied it).
    if (!inserted.rowCount) {
      logger.info("Duplicate gateway event ignored", { orderId: order.id, gateway: gatewayName, status: result.status });
      return { order, duplicate: true };
    }

    await query("INSERT INTO payment_attempts (order_id, status, response) VALUES ($1, $2, $3)", [order.id, `gateway_${result.status}`, JSON.stringify(result.raw || {})]);

    if (order.status === "paid" || order.status === "refunded" || order.status === "partially_refunded") return { order, duplicate: false };

    if (result.status === "pending") return { order, duplicate: false };

    if (result.status === "failed") {
      await query("UPDATE payment_orders SET status = 'failed', failure_reason = $2 WHERE id = $1 AND status IN ('created', 'pending')", [order.id, (result.failureReason || "Payment failed").slice(0, 500)]);
      logger.warn("Payment failed", { orderId: order.id, storeId: order.storeId, reason: result.failureReason });
      await audit.record({ actorType: "gateway", storeId: order.storeId, action: "payment.failed", after: { orderId: order.id, reason: result.failureReason } });
      await notify(order.storeId, "payment_failed", `payment_failed:${order.id}`, { orderId: order.id, reason: result.failureReason });
      return { order: { ...order, status: "failed" }, duplicate: false };
    }

    // paid: the amount and currency must be exactly what we asked for.
    if ((result.amountMinor != null && result.amountMinor !== order.totalMinor) || (result.currency && result.currency !== order.currency)) {
      logger.error("Gateway reported a different amount than the order", { orderId: order.id, expected: order.totalMinor, got: result.amountMinor });
      await query("UPDATE payment_orders SET status = 'failed', failure_reason = 'Amount mismatch' WHERE id = $1", [order.id]);
      await audit.record({ actorType: "gateway", storeId: order.storeId, action: "payment.amount_mismatch", after: { orderId: order.id, expected: order.totalMinor, got: result.amountMinor } });
      return { order: { ...order, status: "failed" }, duplicate: false };
    }
    // Somebody canceled this order on purpose and the bank took the money anyway: record the payment truthfully (paid, with its
    // invoice) but grant nothing; it is refunded in full once this transaction has committed (see refundLatePayment).
    if (order.status === "canceled" && order.canceledBy) {
      await query("UPDATE payment_orders SET status = 'paid', paid_at = now(), gateway_ref = COALESCE($2, gateway_ref), failure_reason = NULL WHERE id = $1", [order.id, result.gatewayRef || null]);
      const lateInvoice = await issueInvoice({ ...order, status: "paid" });
      logger.warn("Payment arrived for an order that was canceled; it will be refunded", { orderId: order.id, storeId: order.storeId });
      await audit.record({ actorType: "gateway", storeId: order.storeId, action: "payment.paid_after_cancel", after: { orderId: order.id, invoice: lateInvoice.number } });
      lateRefund = { ...order, status: "paid" };
      return { order: lateRefund, invoice: lateInvoice, duplicate: false, lateRefund: true };
    }
    await query("UPDATE payment_orders SET status = 'paid', paid_at = now(), gateway_ref = COALESCE($2, gateway_ref), failure_reason = NULL WHERE id = $1", [order.id, result.gatewayRef || null]);
    if (order.kind === "plan") {
      await billing.activatePlan({ storeId: order.storeId, planCode: order.planCode, billingInterval: order.billingInterval, currency: order.currency, orderId: order.id });
    } else {
      await billing.addCredit({ storeId: order.storeId, usdCents: order.topupUsdCents, kind: "topup", refType: "payment_order", refId: order.id });
    }
    const invoice = await issueInvoice({ ...order, status: "paid" });
    logger.info("Payment succeeded", { orderId: order.id, kind: order.kind, storeId: order.storeId, invoice: invoice.number });
    await audit.record({ actorType: "gateway", storeId: order.storeId, action: "payment.succeeded", after: { orderId: order.id, invoice: invoice.number } });
    return { order: { ...order, status: "paid" }, invoice, duplicate: false };
  }));
  if (lateRefund) await refundLatePayment(lateRefund);
  return applied;
}

// The authoritative path for a browser return, a callback or the reconciliation job: ask the gateway what happened to
// this order, then apply it.
// When each order was last put to the gateway, so that the merchant's page polling an order does not turn into a call to the bank every few
// seconds (a call every 3 seconds is what the dialog would otherwise make for the whole time the bank page is open).
const lastGatewayCheck = new Map();

async function confirmWithGateway(order) {
  const gateway = getGateway(order.gateway);
  lastGatewayCheck.set(order.id, Date.now());
  if (lastGatewayCheck.size > 1000) for (const [id, at] of lastGatewayCheck) if (Date.now() - at > 60000) lastGatewayCheck.delete(id);
  const result = await gateway.checkStatus(order);
  return applyGatewayResult(gateway.name, result, { eventKey: `status:${order.merchantTxnNo}:${result.status}:${result.gatewayRef || ""}` });
}

// The merchant's page polls an order; the bank is asked at most once per BILLING_ORDER_CHECK_MIN_INTERVAL_MS for each order (any earlier
// check counts, also one made by a browser return or the scheduler). Between checks the stored state is what the page gets.
async function confirmWithGatewayThrottled(order) {
  const last = lastGatewayCheck.get(order.id);
  if (last && Date.now() - last < config.billing.orderCheckMinIntervalMs) return { order, duplicate: false, skipped: true };
  return confirmWithGateway(order);
}

// Browser return from the hosted payment page, or a gateway callback. params are the gateway's own fields.
async function handleReturn(gatewayName, params) {
  const gateway = getGateway(gatewayName);
  const verified = await gateway.verifyReturn(params);
  const { rows: [row] } = await asSystem(() => query("SELECT * FROM payment_orders WHERE merchant_txn_no = $1", [verified.merchantTxnNo]));
  if (!row) throw httpError(404, "Unknown payment reference");
  const order = mapOrder(row);
  await asSystem(() => query(
    "INSERT INTO gateway_events (gateway, event_key, order_id, payload) VALUES ($1, $2, $3, $4) ON CONFLICT (gateway, event_key) DO NOTHING",
    [gateway.name, `return:${verified.merchantTxnNo}:${verified.status}:${verified.gatewayRef || ""}`, order.id, JSON.stringify(verified.raw || params)]
  ));
  // A message for an order that is already settled (paid, failed, canceled, refunded) changes nothing: a replayed or repeated
  // message is answered from our own record, without another call to the bank.
  if (["paid", "failed", "refunded", "partially_refunded"].includes(order.status) || (order.status === "canceled" && !order.canceledBy)) return { order, duplicate: true };
  // The bank's signed message says "paid" but the bank could not be asked just now (it refused or did not answer, even after the retries
  // in the gateway): that is not a failed payment. The order stays pending, the scheduled check confirms it, and the page says so.
  const unconfirmed = (err) => {
    if (verified.status !== "paid") throw err;
    logger.warn("The bank's signed message says paid, but it could not be asked to confirm yet; the scheduled check will", { orderId: order.id, error: err.message });
    return { order, duplicate: false, unconfirmed: true };
  };
  let result;
  try { result = await confirmWithGateway(order); } catch (err) { return unconfirmed(err); }
  // The bank's own signed return says "paid" but its status service can lag the redirect by a few seconds (seen on the ICICI
  // sandbox: P0030 right after a successful payment). Ask again briefly; otherwise the scheduled re-check settles it.
  for (let attempt = 0; attempt < 4 && verified.status === "paid" && result.order.status === "pending"; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    try { result = await confirmWithGateway(result.order); } catch (err) { return unconfirmed(err); }
  }
  return result;
}

// Scheduled: orders still pending are re-checked with the gateway; abandoned ones are closed after a day.
async function reconcilePending() {
  const { rows } = await asSystem(() => query("SELECT * FROM payment_orders WHERE status = 'pending' AND created_at < now() - interval '2 minutes' ORDER BY created_at LIMIT 100"));
  for (const row of rows) {
    const order = mapOrder(row);
    try {
      const { order: after } = await confirmWithGateway(order);
      if (after.status === "pending" && Date.now() - new Date(order.createdAt).getTime() > 24 * 3600 * 1000) {
        await asSystem(() => query("UPDATE payment_orders SET status = 'canceled', failure_reason = 'Not completed within 24 hours' WHERE id = $1 AND status = 'pending'", [order.id]));
      }
    } catch (err) {
      logger.error("Reconcile failed", { merchantTxnNo: order.merchantTxnNo, orderId: order.id, error: err });
    }
  }
  const { rows: canceled } = await asSystem(() => query("SELECT * FROM payment_orders WHERE status = 'canceled' AND canceled_by IS NOT NULL AND canceled_at > now() - interval '24 hours' ORDER BY canceled_at LIMIT 100"));
  for (const row of canceled) {
    try {
      await confirmWithGateway(mapOrder(row)); // a 'paid' answer is refunded by applyGatewayResult; anything else changes nothing
    } catch (err) {
      logger.error("Re-check of a canceled order failed", { orderId: row.id, error: err });
    }
  }
  return rows.length + canceled.length;
}

async function notify(storeId, kind, dedupeKey, payload) {
  await query("INSERT INTO notifications (store_id, kind, dedupe_key, payload) VALUES ($1, $2, $3, $4) ON CONFLICT (dedupe_key) DO NOTHING", [storeId, kind, dedupeKey, JSON.stringify(payload)]);
}

// ---------------------------------------------------------------------------------------------------------------------
// Invoices

function describeOrder(order) {
  if (order.kind === "plan") return `${order.planCode.charAt(0).toUpperCase() + order.planCode.slice(1)} plan, ${order.billingInterval}`;
  return `Video credit top-up ($${(order.topupUsdCents / 100).toFixed(2)})`;
}

async function issueInvoice(order) {
  const merchant = await getMerchant(order.merchantId);
  const { rows: [{ n }] } = await query("SELECT nextval('invoice_number_seq') AS n");
  const number = `FL-${new Date().getUTCFullYear()}-${String(n).padStart(6, "0")}`;
  const { rows: [inv] } = await query(
    `INSERT INTO invoices (number, kind, order_id, store_id, merchant_id, currency, subtotal_minor, tax_minor, total_minor, tax_rate_bp, description, buyer)
     VALUES ($1, 'invoice', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT DO NOTHING RETURNING *`,
    [number, order.id, order.storeId, order.merchantId, order.currency, order.subtotalMinor, order.taxMinor, order.totalMinor, order.taxRateBp, describeOrder(order),
      JSON.stringify({ name: merchant.name, email: merchant.contact_email, country: merchant.country_code, gst: merchant.gst_number, address: merchant.billing_address })]
  );
  if (inv) return inv;
  const { rows: [existing] } = await query("SELECT * FROM invoices WHERE order_id = $1 AND kind = 'invoice'", [order.id]);
  return existing;
}

async function getInvoice(invoiceId) {
  const { rows: [inv] } = await query("SELECT * FROM invoices WHERE id = $1", [invoiceId]);
  return inv;
}

// ---------------------------------------------------------------------------------------------------------------------
// Cancel (an order that has not been paid)

// Cancels an unpaid order, but only after the bank has been asked: ICICI's STATUS decides.
//   * bank says paid      -> NOT canceled. The payment is recorded as paid (the plan or credit is granted, as for any payment) and the
//                            caller is told to refund it instead if it must be reversed.
//   * bank says failed    -> recorded as failed (there is nothing to cancel).
//   * bank says pending   -> canceled here (canceled_by / canceled_at recorded). If the customer still finishes paying on the bank
//                            page afterwards, applyGatewayResult refunds that payment in full instead of granting anything.
//   * bank cannot be asked-> NOT canceled (an order that may be paid must not be canceled blind); the caller can try again.
// A paid, refunded, failed or already canceled order cannot be canceled. Returns { order, outcome: 'canceled' | 'failed' }.
async function cancelOrder({ orderId, actor }) {
  return asSystem(async () => {
    const { rows: [row] } = await query("SELECT * FROM payment_orders WHERE id = $1", [orderId]);
    if (!row) throw httpError(404, "Order not found");
    const order = mapOrder(row);
    if (order.status === "canceled") throw Object.assign(httpError(409, "This payment is already canceled"), { code: "already_canceled" });
    if (["paid", "partially_refunded", "refunded"].includes(order.status)) {
      throw Object.assign(httpError(409, "This payment is already paid, so it cannot be canceled. Refund it instead"), { code: "already_paid" });
    }
    if (order.status === "failed") throw Object.assign(httpError(409, "This payment already failed; there is nothing to cancel"), { code: "already_failed" });

    const gateway = getGateway(order.gateway);
    let result;
    try {
      result = await gateway.checkStatus(order);
    } catch (err) {
      logger.warn("Could not ask the bank before canceling; the order was left as it is", { orderId, error: err.message });
      throw Object.assign(httpError(503, "The bank could not be asked whether this payment went through, so it was not canceled. Try again in a moment"), { code: "bank_unreachable" });
    }
    if (result.status === "paid" || result.status === "failed") {
      const { order: settled } = await applyGatewayResult(gateway.name, result, { eventKey: `cancel-check:${order.merchantTxnNo}:${result.status}:${result.gatewayRef || ""}` });
      if (result.status === "paid") {
        throw Object.assign(httpError(409, "The bank reports this payment as paid, so it was recorded as paid and not canceled. Refund it instead if it must be reversed"), { code: "already_paid" });
      }
      return { order: settled, outcome: "failed" };
    }

    const who = `${actor.type}:${actor.id}`;
    const { rowCount } = await query(
      "UPDATE payment_orders SET status = 'canceled', canceled_by = $2, canceled_at = now(), failure_reason = 'Canceled before it was paid' WHERE id = $1 AND status IN ('created', 'pending')",
      [order.id, who]
    );
    if (!rowCount) throw Object.assign(httpError(409, "This payment changed while it was being canceled; check its status and try again"), { code: "changed" });
    await query("INSERT INTO payment_attempts (order_id, status, response) VALUES ($1, 'canceled', $2)", [order.id, JSON.stringify({ by: who })]);
    logger.info("Payment canceled", { orderId: order.id, storeId: order.storeId, by: who });
    await audit.record({ actorType: actor.type, actorId: actor.id, storeId: order.storeId, action: "payment.canceled", after: { orderId: order.id } });
    return { order: { ...order, status: "canceled", canceledBy: who }, outcome: "canceled" };
  });
}

// The bank took the money for an order somebody had canceled on purpose (the customer finished paying after the cancel). Nothing is
// granted; the payment is refunded in full. The key makes a repeated call a no-op. If this fails, the order stays 'paid' without a
// refund and the audit log says so, so staff can refund it from the console.
async function refundLatePayment(order) {
  try {
    await refundOrder({
      orderId: order.id, amountMinor: order.totalMinor, reason: "Payment arrived after the order was canceled", entitlementAction: "none",
      idempotencyKey: `late-after-cancel:${order.id}`, actor: { type: "system", id: "late-payment-after-cancel" },
    });
  } catch (err) {
    logger.error("Could not refund a payment that arrived after the order was canceled; refund it from the staff console", { orderId: order.id, error: err });
    await audit.record({ actorType: "system", storeId: order.storeId, action: "payment.late_refund_failed", after: { orderId: order.id, error: err.message } });
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Refunds (initiated by staff)

async function refundedSoFar(orderId) {
  const { rows: [r] } = await query("SELECT COALESCE(SUM(amount_minor), 0) AS total FROM refunds WHERE order_id = $1 AND status IN ('requested', 'processing', 'succeeded')", [orderId]);
  return r.total;
}

// A refund the bank could not be reached about carries this note while it waits (see settleProcessingRefunds).
const UNKNOWN_OUTCOME = "Outcome unknown: the bank could not be reached; it will be asked again";
const UNKNOWN_OUTCOME_GIVE_UP_HOURS = 24;

// entitlementAction: 'none' | 'cancel_plan' (end the paid period now) | 'remove_credit' (take back the granted credit)
// idempotencyKey (optional): the same key for the same order returns the refund it already made instead of making another, so a
// double click, a browser retry or a repeated API call can never refund twice. Returns { refundId, status, duplicate }.
async function refundOrder({ orderId, amountMinor, reason, entitlementAction = "none", idempotencyKey = null, actor }) {
  return asSystem(async () => {
    const refundId = crypto.randomUUID();
    let existing = null;
    const order = await tx(async () => {
      const { rows: [row] } = await query("SELECT * FROM payment_orders WHERE id = $1 FOR UPDATE", [orderId]);
      if (!row) throw httpError(404, "Order not found");
      const o = mapOrder(row);
      if (idempotencyKey) {
        const { rows: [prior] } = await query("SELECT * FROM refunds WHERE order_id = $1 AND idempotency_key = $2", [o.id, idempotencyKey]);
        if (prior) {
          if (Number(prior.amount_minor) !== amountMinor) throw httpError(409, "That request key was already used for a different refund amount");
          existing = prior;
          return o;
        }
      }
      if (!["paid", "partially_refunded"].includes(o.status)) throw httpError(400, "Only paid orders can be refunded");
      if (typeof getGateway(o.gateway).refund !== "function") throw httpError(400, `Refunds are not supported for payments made through ${o.gateway}`);
      if (!Number.isInteger(amountMinor) || amountMinor <= 0) throw httpError(400, "Refund amount must be positive");
      const already = await refundedSoFar(o.id);
      if (amountMinor + Number(already) > o.totalMinor) throw httpError(400, "Refund is more than what was paid");
      if (!reason) throw httpError(400, "A reason is required");
      await query(
        `INSERT INTO refunds (id, order_id, store_id, amount_minor, currency, reason, entitlement_action, requested_by, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [refundId, o.id, o.storeId, amountMinor, o.currency, reason, entitlementAction, `${actor.type}:${actor.id}`, idempotencyKey]
      );
      return o;
    });
    if (existing) {
      logger.info("Refund request repeated with the same key; returning the refund already made", { refundId: existing.id, orderId });
      return { refundId: existing.id, status: existing.status, duplicate: true };
    }

    let outcome;
    try {
      outcome = await getGateway(order.gateway).refund(order, amountMinor, refundId);
    } catch (err) {
      logger.error("Gateway refused to start the refund", { refundId, orderId, error: err });
      await query("UPDATE refunds SET status = 'failed', failure_reason = $2, gateway_response = $3, processed_at = now() WHERE id = $1",
        [refundId, err.message.slice(0, 500), err.gatewayResponse ? JSON.stringify(err.gatewayResponse) : null]);
      await audit.record({ actorType: actor.type, actorId: actor.id, storeId: order.storeId, action: "refund.failed", after: { refundId, orderId, error: err.message } });
      throw err;
    }
    const detail = [outcome.gatewayRef || null, outcome.gatewayTxnId || null, outcome.raw ? JSON.stringify(outcome.raw) : null];
    if (outcome.status === "processing") {
      await query("UPDATE refunds SET status = 'processing', gateway_ref = $2, gateway_txn_id = $3, gateway_response = $4, failure_reason = $5 WHERE id = $1",
        [refundId, ...detail, outcome.unconfirmed ? UNKNOWN_OUTCOME : null]);
      await audit.record({ actorType: actor.type, actorId: actor.id, storeId: order.storeId, action: outcome.unconfirmed ? "refund.outcome_unknown" : "refund.processing", after: { refundId, orderId, amountMinor, gatewayRef: outcome.gatewayRef } });
      return { refundId, status: "processing", duplicate: false };
    }
    if (outcome.status !== "succeeded") {
      await query("UPDATE refunds SET status = 'failed', failure_reason = 'Gateway declined the refund', processed_at = now() WHERE id = $1", [refundId]);
      throw httpError(502, "The gateway did not accept the refund");
    }
    await query("UPDATE refunds SET gateway_ref = $2, gateway_txn_id = $3, gateway_response = $4 WHERE id = $1", [refundId, ...detail]);
    await completeRefund(refundId, outcome.gatewayRef || null, actor);
    return { refundId, status: "succeeded", duplicate: false };
  });
}

// The refund is confirmed by the gateway: record it, mark the order, issue the credit note, apply the entitlement action.
// Safe to call once per refund (a refund that is already succeeded is left alone).
async function completeRefund(refundId, gatewayRef, actor) {
  return asSystem(() => tx(async () => {
    const { rows: [refund] } = await query("SELECT * FROM refunds WHERE id = $1 FOR UPDATE", [refundId]);
    if (!refund || refund.status === "succeeded") return;
    const { rows: [orderRow] } = await query("SELECT * FROM payment_orders WHERE id = $1 FOR UPDATE", [refund.order_id]);
    const order = mapOrder(orderRow);
    await query("UPDATE refunds SET status = 'succeeded', gateway_ref = COALESCE($2, gateway_ref), failure_reason = NULL, processed_at = now() WHERE id = $1", [refundId, gatewayRef]);
    const total = await refundedSoFar(order.id);
    await query("UPDATE payment_orders SET status = $2 WHERE id = $1", [order.id, total >= order.totalMinor ? "refunded" : "partially_refunded"]);
    await issueCreditNote(order, refundId, refund.amount_minor, refund.reason);
    if (refund.entitlement_action === "cancel_plan" && order.kind === "plan") await billing.endPlanNow(order.storeId, actor);
    if (refund.entitlement_action === "remove_credit" && order.kind === "topup") {
      const share = Math.round((order.topupUsdCents * refund.amount_minor) / order.totalMinor);
      const balance = await billing.creditBalance(order.storeId);
      const take = Math.min(share, Math.max(0, balance));
      if (take > 0) await billing.addCredit({ storeId: order.storeId, usdCents: -take, kind: "refund", refType: "refund", refId: refundId });
    }
    logger.info("Refund succeeded", { refundId, orderId: order.id, amountMinor: refund.amount_minor, entitlementAction: refund.entitlement_action });
    await audit.record({ actorType: actor.type, actorId: actor.id, storeId: order.storeId, action: "refund.succeeded", after: { refundId, orderId: order.id, amountMinor: refund.amount_minor, entitlementAction: refund.entitlement_action } });
  }));
}

// Scheduled: refunds the gateway accepted but has not finished are asked about; the bank's answer settles them. A refund whose
// request never got an answer (UNKNOWN_OUTCOME) is asked about by its own reference too; if the bank still has no record of it after
// a day it is closed as failed with a clear note, so that staff can check with ICICI and refund again without risking a double refund.
async function settleProcessingRefunds() {
  const { rows } = await asSystem(() => query(
    "SELECT r.*, o.gateway FROM refunds r JOIN payment_orders o ON o.id = r.order_id WHERE r.status = 'processing' ORDER BY r.created_at LIMIT 50"
  ));
  for (const row of rows) {
    try {
      const gateway = getGateway(row.gateway);
      if (!gateway.settleRefund) continue;
      const result = await gateway.settleRefund(row);
      const [type, id] = String(row.requested_by).split(/:(.*)/s);
      const detail = [result.gatewayTxnId || null, result.raw ? JSON.stringify(result.raw) : null];
      if (result.status === "succeeded") {
        await asSystem(() => query("UPDATE refunds SET gateway_txn_id = COALESCE($2, gateway_txn_id), gateway_response = COALESCE($3, gateway_response) WHERE id = $1", [row.id, ...detail]));
        await completeRefund(row.id, null, { type, id });
      } else if (result.status === "failed") {
        await asSystem(() => query("UPDATE refunds SET status = 'failed', failure_reason = $2, gateway_txn_id = COALESCE($3, gateway_txn_id), gateway_response = COALESCE($4, gateway_response), processed_at = now() WHERE id = $1", [row.id, (result.reason || "Refund rejected").slice(0, 500), ...detail]));
        await audit.record({ actorType: "gateway", storeId: row.store_id, action: "refund.failed", after: { refundId: row.id, reason: result.reason } });
      } else if (row.failure_reason === UNKNOWN_OUTCOME && Date.now() - new Date(row.created_at).getTime() > UNKNOWN_OUTCOME_GIVE_UP_HOURS * 3600 * 1000) {
        const note = `The bank has no record of this refund after ${UNKNOWN_OUTCOME_GIVE_UP_HOURS} hours (the request never got an answer). Check with ICICI before refunding again.`;
        await asSystem(() => query("UPDATE refunds SET status = 'failed', failure_reason = $2, processed_at = now() WHERE id = $1 AND status = 'processing'", [row.id, note]));
        logger.error("Refund with an unknown outcome closed as failed", { refundId: row.id, orderId: row.order_id });
        await audit.record({ actorType: "gateway", storeId: row.store_id, action: "refund.outcome_unknown_closed", after: { refundId: row.id, orderId: row.order_id } });
      }
    } catch (err) {
      logger.error("Could not settle refund", { refundId: row.id, error: err });
    }
  }
  return rows.length;
}

async function issueCreditNote(order, refundId, amountMinor, reason) {
  const merchant = await getMerchant(order.merchantId);
  // Tax portion of the refund follows the order's own rate.
  const subtotal = Math.round((amountMinor * order.subtotalMinor) / order.totalMinor);
  const { rows: [{ n }] } = await query("SELECT nextval('invoice_number_seq') AS n");
  await query(
    `INSERT INTO invoices (number, kind, order_id, refund_id, store_id, merchant_id, currency, subtotal_minor, tax_minor, total_minor, tax_rate_bp, description, buyer)
     VALUES ($1, 'credit_note', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) ON CONFLICT DO NOTHING`,
    [`CN-${new Date().getUTCFullYear()}-${String(n).padStart(6, "0")}`, order.id, refundId, order.storeId, order.merchantId, order.currency, -subtotal, -(amountMinor - subtotal), -amountMinor,
      order.taxRateBp, `Refund: ${reason}`, JSON.stringify({ name: merchant.name, email: merchant.contact_email, country: merchant.country_code, gst: merchant.gst_number })]
  );
}

module.exports = {
  createOrder, getOrder, listHistory, applyGatewayResult, confirmWithGateway, handleReturn, reconcilePending,
  getInvoice, refundOrder, cancelOrder, confirmWithGatewayThrottled, settleProcessingRefunds, describeOrder, notify, mapOrder,
};
