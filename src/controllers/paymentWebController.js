// Browser-facing and server-to-server payment endpoints: the page the gateway returns the merchant to, and the gateway callback.
const logger = require("../utils/logger");
const payments = require("../services/paymentService");
const { escapeHtml, page } = require("../utils/html");

// The merchant lands here after paying (in the tab opened from the Plans & Billing modal).
async function returnPage(req, res) {
  // ICICI POSTs the result as a form and ignores query-string fields for its signature.
  const gateway = req.query.gw || "icici";
  const params = req.method === "POST" ? { ...req.body } : { ...req.query };
  delete params.gw;
  let title;
  let body;
  try {
    const { order, unconfirmed } = await payments.handleReturn(gateway, params);
    if (unconfirmed) {
      title = "Payment received";
      body = `<h1>Payment received</h1><p>Your bank says the payment went through. We are confirming it with the bank now, which usually takes a minute or two. You can close this tab; your ${order.kind === "plan" ? "plan" : "credit"} is added as soon as it is confirmed. If it is not in Plans &amp; Billing after a few minutes, contact support with your payment reference.</p>`;
    } else if (order.status === "paid") {
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
    const handled = await payments.handleReturn(req.params.gateway, { ...fields });
    if (handled.unconfirmed) return res.status(503).json({ error: "Not confirmed yet" }); // the bank may send it again; the scheduled check confirms it meanwhile
    res.json({ ok: true });
  } catch (err) {
    logger.error("Gateway callback rejected:", err.message);
    res.status(err.status || 400).json({ error: "Rejected" });
  }
}

module.exports = { returnPage, callback };
