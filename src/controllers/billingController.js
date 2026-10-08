// Plans & Billing endpoints for the embedded UI: status, checkout, order status, cancel, history, invoice links.
const config = require("../config");
const { tenant } = require("../context");
const { query } = require("../db/connection");
const { signToken } = require("../utils/crypto");
const billing = require("../services/billingService");
const payments = require("../services/paymentService");
const logger = require("../utils/logger");

// 4xx = the caller's problem (warn); anything else is ours (error, with stack) and the client gets a generic line.
function fail(res, err, where = "billing") {
  const status = Number(err.status) >= 400 && Number(err.status) < 600 ? Number(err.status) : 500;
  if (status >= 500) logger.error(`${where} failed`, { error: err });
  else logger.warn(`${where} refused`, { status, reason: err.message });
  res.status(status).json({ error: err.userMessage || (status < 500 ? err.message : "Something went wrong. Please try again.") });
}

async function merchantCountry() {
  const { rows: [m] } = await query("SELECT country_code FROM merchants WHERE id = $1", [tenant().installation.merchantId]);
  return m && m.country_code;
}

async function status(req, res) {
  try {
    res.json(await billing.snapshot(await merchantCountry()));
  } catch (err) {
    fail(res, err, "billing status");
  }
}

// Body: { kind: 'plan', tier, cycle, currency } or { kind: 'topup', packUsdCents, currency }. Returns the gateway page to open.
async function checkout(req, res) {
  const { kind = "plan", tier, cycle, currency, packUsdCents } = req.body || {};
  try {
    const { order, redirectUrl } = await payments.createOrder({
      kind, planCode: tier, interval: cycle, currency, topupUsdCents: packUsdCents, idempotencyKey: req.get("Idempotency-Key") || null,
    });
    logger.info("Checkout started", { orderId: order.id, kind, tier, cycle, currency, totalMinor: order.totalMinor, storeId: tenant().store.id });
    res.status(201).json({ orderId: order.id, redirectUrl, totalMinor: order.totalMinor, currency: order.currency });
  } catch (err) {
    fail(res, err, "checkout");
  }
}

// The page polls this after sending the merchant to the gateway, until the order is no longer pending.
async function orderStatus(req, res) {
  try {
    const order = await payments.getOrder(req.params.id);
    if (!order || order.storeId !== tenant().store.id) return res.status(404).json({ error: "Order not found" });
    if (order.status === "pending") {
      // The gateway is asked directly; this is what turns a completed payment into an active plan even when the callback is late.
      try {
        await payments.confirmWithGateway(order);
      } catch (err) {
        // still pending is a valid answer, but say why the gateway could not be asked
        logger.warn("Gateway status check failed; order stays pending", { orderId: order.id, error: err.message });
      }
    }
    const fresh = await payments.getOrder(order.id);
    res.json({ id: fresh.id, status: fresh.status, failureReason: fresh.failureReason, kind: fresh.kind });
  } catch (err) {
    fail(res, err, "order status");
  }
}

async function cancel(req, res) {
  try {
    await billing.cancelPlan({ type: "merchant", id: tenant().installation.id });
    logger.info("Plan canceled by the merchant", { storeId: tenant().store.id });
    res.json(await billing.snapshot(await merchantCountry()));
  } catch (err) {
    fail(res, err, "cancel plan");
  }
}

async function history(req, res) {
  try {
    res.json({ orders: await payments.listHistory() });
  } catch (err) {
    fail(res, err, "billing history");
  }
}

// Invoices open in a new tab through a plain link, so the link carries a short-lived signed token.
async function invoiceLink(req, res) {
  try {
    const invoice = await payments.getInvoice(req.params.id);
    if (!invoice || invoice.store_id !== tenant().store.id) return res.status(404).json({ error: "Invoice not found" });
    res.json({ url: `/invoice/${signToken({ typ: "inv", id: invoice.id }, 600)}` });
  } catch (err) {
    fail(res, err, "invoice link");
  }
}

module.exports = { status, checkout, orderStatus, cancel, history, invoiceLink };
