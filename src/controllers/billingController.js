// Plans & Billing endpoints for the embedded UI: status, checkout, order status, cancel, history, invoice links.
const config = require("../config");
const { tenant } = require("../context");
const { query } = require("../db/connection");
const { signToken } = require("../utils/crypto");
const billing = require("../services/billingService");
const payments = require("../services/paymentService");

const fail = (res, err) => res.status(err.status || 500).json({ error: err.userMessage || err.message || "Something went wrong" });

async function merchantCountry() {
  const { rows: [m] } = await query("SELECT country_code FROM merchants WHERE id = $1", [tenant().installation.merchantId]);
  return m && m.country_code;
}

async function status(req, res) {
  res.json(await billing.snapshot(await merchantCountry()));
}

// Body: { kind: 'plan', tier, cycle, currency } or { kind: 'topup', packUsdCents, currency }. Returns the gateway page to open.
async function checkout(req, res) {
  const { kind = "plan", tier, cycle, currency, packUsdCents } = req.body || {};
  try {
    const { order, redirectUrl } = await payments.createOrder({
      kind, planCode: tier, interval: cycle, currency, topupUsdCents: packUsdCents, idempotencyKey: req.get("Idempotency-Key") || null,
    });
    res.status(201).json({ orderId: order.id, redirectUrl, totalMinor: order.totalMinor, currency: order.currency });
  } catch (err) {
    fail(res, err);
  }
}

// The page polls this after sending the merchant to the gateway, until the order is no longer pending.
async function orderStatus(req, res) {
  const order = await payments.getOrder(req.params.id);
  if (!order || order.storeId !== tenant().store.id) return res.status(404).json({ error: "Order not found" });
  if (order.status === "pending") {
    // The gateway is asked directly; this is what turns a completed payment into an active plan even when the callback is late.
    try { await payments.confirmWithGateway(order); } catch { /* still pending is a valid answer */ }
  }
  const fresh = await payments.getOrder(order.id);
  res.json({ id: fresh.id, status: fresh.status, failureReason: fresh.failureReason, kind: fresh.kind });
}

async function cancel(req, res) {
  try {
    await billing.cancelPlan({ type: "merchant", id: tenant().installation.id });
    res.json(await billing.snapshot(await merchantCountry()));
  } catch (err) {
    fail(res, err);
  }
}

async function history(req, res) {
  res.json({ orders: await payments.listHistory() });
}

// Invoices open in a new tab through a plain link, so the link carries a short-lived signed token.
async function invoiceLink(req, res) {
  const invoice = await payments.getInvoice(req.params.id);
  if (!invoice || invoice.store_id !== tenant().store.id) return res.status(404).json({ error: "Invoice not found" });
  res.json({ url: `/invoice/${signToken({ typ: "inv", id: invoice.id }, 600)}` });
}

module.exports = { status, checkout, orderStatus, cancel, history, invoiceLink };
