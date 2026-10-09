// Browser-facing and server-to-server payment endpoints: the page the gateway returns the merchant to, the gateway callback,
// and the mock gateway's own payment page (development and tests only).
const config = require("../config");
const logger = require("../utils/logger");
const { query, asSystem } = require("../db/connection");
const payments = require("../services/paymentService");
const mock = require("../payments/MockGateway");
const { escapeHtml, money, page } = require("../utils/html");

// The merchant lands here after paying (in the tab opened from the Plans & Billing modal).
async function returnPage(req, res) {
  // ICICI POSTs the result as a form and ignores query-string fields for its signature; the mock gateway returns via GET.
  const gateway = req.query.gw || config.payment.gateway;
  const params = req.method === "POST" ? { ...req.body } : { ...req.query };
  delete params.gw;
  let title = "Payment status";
  let body;
  try {
    const { order } = await payments.handleReturn(gateway, params);
    if (order.status === "paid") {
      title = "Payment received";
      body = `<h1 class="ok">Payment received</h1><p>Thank you. Your ${order.kind === "plan" ? "plan is now active" : "credit has been added"}. You can close this tab and go back to Video Generator.</p>`;
    } else if (order.status === "failed" || order.status === "canceled") {
      title = "Payment not completed";
      // Reviewed: failureReason is escaped with escapeHtml()
      // nosemgrep: javascript.express.security.injection.raw-html-format.raw-html-format
      body = `<h1 class="bad">Payment not completed</h1><p>${escapeHtml(order.failureReason || "The payment did not go through.")} No charge was applied. You can close this tab and try again.</p>`;
    } else {
      title = "Payment pending";
      body = `<h1>Payment pending</h1><p>Your bank has not confirmed the payment yet. This usually takes a minute. You can close this tab; your plan activates as soon as the payment is confirmed.</p>`;
    }
  } catch (err) {
    logger.error("Payment return failed:", err.message);
    title = "Payment status";
    body = `<h1 class="bad">We could not verify this payment</h1><p>${escapeHtml(err.userMessage || "Please check Plans & Billing in Video Generator, or contact support with your payment reference.")}</p>`;
  }
  // Reviewed: every value placed in these pages is escaped with e()/escapeHtml() or is a fixed string/number (reviewed, see test/validation.e2e.test.js and docs/security)
  // nosemgrep: javascript.express.security.audit.xss.direct-response-write.direct-response-write
  res.send(page(title, body));
}

// Server-to-server notification from the gateway. 200 only once the signature checked out.
async function callback(req, res) {
  try {
    const fields = req.body && Object.keys(req.body).length ? req.body : req.query;
    await payments.handleReturn(req.params.gateway, { ...fields });
    res.json({ ok: true });
  } catch (err) {
    logger.error("Gateway callback rejected:", err.message);
    res.status(err.status || 400).json({ error: "Rejected" });
  }
}

// ---- Mock gateway hosted page ----

const mockEnabled = (req, res, next) => (config.payment.gateway === "mock" ? next() : res.status(404).send("Not found"));

async function mockPage(req, res) {
  const { rows: [row] } = await asSystem(() => query("SELECT * FROM payment_orders WHERE merchant_txn_no = $1", [req.params.txn]));
  if (!row) return res.status(404).send(page("Not found", "<h1>Unknown payment</h1>"));
  const order = payments.mapOrder(row);
  const what = payments.describeOrder(order);
  res.send(page("Mock payment page", `
    <h1>Mock payment gateway</h1>
    <p>Test environment. No money moves. Choose the outcome to simulate.</p>
    <table>
      <tr><td>Item</td><td>${escapeHtml(what)}</td></tr>
      <tr><td>Amount</td><td>${money(order.subtotalMinor, order.currency)}</td></tr>
      <tr><td>Tax (${order.taxRateBp / 100}%)</td><td>${money(order.taxMinor, order.currency)}</td></tr>
      <tr><td><b>Total</b></td><td><b>${money(order.totalMinor, order.currency)}</b></td></tr>
      <tr><td>Reference</td><td>${escapeHtml(order.merchantTxnNo)}</td></tr>
    </table>
    <div class="row">
      <form method="post" action="/mockpay/${escapeHtml(order.merchantTxnNo)}/complete"><input type="hidden" name="result" value="paid"><button class="primary" id="pay-success">Pay successfully</button></form>
      <form method="post" action="/mockpay/${escapeHtml(order.merchantTxnNo)}/complete"><input type="hidden" name="result" value="failed"><button id="pay-fail">Decline the card</button></form>
      <form method="post" action="/mockpay/${escapeHtml(order.merchantTxnNo)}/complete"><input type="hidden" name="result" value="pending"><button id="pay-pending">Leave pending</button></form>
    </div>`));
}

async function mockComplete(req, res) {
  const { rows: [row] } = await asSystem(() => query("SELECT * FROM payment_orders WHERE merchant_txn_no = $1", [req.params.txn]));
  if (!row) return res.status(404).send("Unknown payment");
  const result = ["paid", "failed", "pending"].includes((req.body || {}).result) ? req.body.result : "failed";
  await asSystem(() => query(
    "INSERT INTO payment_attempts (order_id, status, response) VALUES ($1, $2, $3)",
    [row.id, `mock_${result}`, JSON.stringify(result === "failed" ? { reason: "Card declined (mock)" } : {})]
  ));
  const sig = mock.sign(row.merchant_txn_no, result);
  res.redirect(303, `/billing/return?gw=mock&txn=${encodeURIComponent(row.merchant_txn_no)}&status=${result}&sig=${sig}`);
}

module.exports = { returnPage, callback, mockEnabled, mockPage, mockComplete };
