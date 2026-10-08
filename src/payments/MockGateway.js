// Stand-in payment gateway for development and automated tests. It has a hosted "payment page" served by this adapter
// (see mockPayController) where a tester picks the outcome, so the whole flow (redirect, return, callback, status check,
// refund) runs without any bank account. Outcomes are kept as payment_attempts rows.
const config = require("../config");
const { query } = require("../db/connection");
const { hmacHex, safeEqual } = require("../utils/crypto");

const name = "mock";
const secret = () => `mock:${config.secretKey}`;

// Signature the mock page puts on the browser return, standing in for the bank's signed response.
const sign = (txn, status) => hmacHex(secret(), `${txn}|${status}`);

async function createPayment(order) {
  return { redirectUrl: `${config.publicBaseUrl}/mockpay/${order.merchantTxnNo}`, gatewayRef: null };
}

// Browser return or server callback parameters -> normalised result. params: { txn, status, sig }
async function verifyReturn(params) {
  if (!params.txn || !params.status || !safeEqual(params.sig || "", sign(params.txn, params.status))) {
    throw Object.assign(new Error("Invalid gateway signature"), { status: 400 });
  }
  return { merchantTxnNo: params.txn, status: params.status === "paid" ? "paid" : params.status === "failed" ? "failed" : "pending" };
}

// The authoritative outcome for an order, as the gateway itself would report it.
async function checkStatus(order) {
  const { rows: [attempt] } = await query(
    "SELECT status, response FROM payment_attempts WHERE order_id = $1 AND status LIKE 'mock_%' ORDER BY id DESC LIMIT 1", [order.id]
  );
  if (!attempt) return { merchantTxnNo: order.merchantTxnNo, status: "pending", raw: {} };
  const outcome = attempt.status.replace("mock_", "");
  return {
    merchantTxnNo: order.merchantTxnNo,
    status: outcome === "paid" ? "paid" : outcome === "failed" ? "failed" : "pending",
    gatewayRef: outcome === "paid" ? `MOCK-${order.merchantTxnNo}` : null,
    amountMinor: order.totalMinor,
    currency: order.currency,
    failureReason: outcome === "failed" ? (attempt.response && attempt.response.reason) || "Payment declined (mock)" : null,
    raw: attempt.response || {},
  };
}

async function refund(order, amountMinor, refundId) {
  return { status: "succeeded", gatewayRef: `MOCK-RF-${refundId.slice(0, 8)}`, raw: { amountMinor } };
}

module.exports = { name, sign, createPayment, verifyReturn, checkStatus, refund };
