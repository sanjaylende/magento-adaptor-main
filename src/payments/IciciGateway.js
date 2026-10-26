// ICICI Bank payment gateway ("ICICI PG", hosted payment page), implemented from ICICI's "Initiate Sale & Transaction APIs"
// merchant integration reference (UAT) and verified against the UAT sandbox.
//
//   * secureHash: HMAC-SHA256 (lowercase hex) of the top-level field values concatenated in alphabetical key order, nested
//     objects JSON-encoded, null/undefined skipped, secureHash excluded. The same method signs every request and every
//     bank message (return POST, payment advice).
//   * createPayment: POST {base}/tsp/pg/api/v2/initiateSale (UAT) or {base}/pg/api/v2/initiateSale (production) -> R1000 +
//     redirectURI + tranCtx; the customer is sent to {redirectURI}?tranCtx={tranCtx}.
//   * The bank POSTs the outcome to returnURL as an HTML form (browser-carried) and may also send a Payment Advice webhook
//     (needs enabling by ICICI for the merchant id). Neither is trusted on its own: checkStatus() asks the bank.
//   * checkStatus / refund: POST {base}/.../api/command?reqType=JSON with transactionType STATUS / REFUND. Every call needs its
//     own unique merchantTxnNo; originalTxnNo names the sale (or, to follow a refund, the refund's own reference).
//
//   * cancel: the bank page has no cancel call in this reference. An unpaid order is canceled here only after a STATUS says it is
//     not paid (paymentService.cancelOrder); a paid one is refunded instead.
//
// Sandbox findings baked in below: a sale is paid only when txnStatus is SUC (a bare responseCode 0000 also appears on
// pending payments); R1000 on a refund means "accepted", the outcome comes from a STATUS on the refund reference; the bank
// page may add a service charge on top of `amount`, which is reported separately as `oth_charge`.
const crypto = require("crypto");
const logger = require("../utils/logger");
const config = require("../config");
const { hmacHex, safeEqual } = require("../utils/crypto");
const { safeFetch } = require("../utils/safeFetch");

const name = "icici";
const ICICI_HOSTS = ["pgpay.icicibank.com", "pgpayuat.icicibank.com"]; // the only hosts this adapter will ever call for payments
const cfg = () => config.payment.icici;
const CURRENCY_CODE = { INR: "356", USD: "840" }; // ISO 4217 numeric

const SUCCESS_CODES = new Set(["0", "00", "000", "0000"]);
const PENDING_CODES = new Set(["P0030", "U1000", "R1000"]); // awaiting customer, request pending, request accepted
const REFUND_ACCEPTED = "R1000";
// The bank's own "Transaction Declined". A STATUS on a REFUND reference that the bank has declined answers with this code and a description but
// no txnStatus at all (seen on the UAT sandbox: accepted with R1000 first, then 039 "Transaction Declined" on every later check). Only codes
// listed here end a refund as failed this way; any other unfamiliar answer keeps waiting, so a refund that may have gone through is never failed.
const REFUND_DECLINE_CODES = new Set(["039"]);

// Alphabetical key order, values concatenated, null/undefined skipped, nested values JSON-encoded, secureHash excluded.
function secureHash(fields, secret) {
  const data = Object.keys(fields)
    .filter((k) => k !== "secureHash")
    .sort()
    .map((k) => {
      const v = fields[k];
      if (v === null || v === undefined) return "";
      return typeof v === "object" ? JSON.stringify(v) : String(v);
    })
    .join("");
  return hmacHex(secret, data);
}

const requireConfigured = () => {
  const c = cfg();
  if (!c.merchantId || !c.aggregatorId || !c.secretKey) {
    throw Object.assign(new Error("ICICI gateway is not configured (ICICI_PG_MERCHANT_ID, ICICI_PG_AGGREGATOR_ID, ICICI_PG_SECRET_KEY)"), { status: 503 });
  }
  return c;
};

// UAT paths contain /tsp; production ones do not (ICICI document, section 7).
function endpoint(c, path) {
  const isUat = /pgpayuat/i.test(c.baseUrl);
  return `${c.baseUrl.replace(/\/+$/, "")}${isUat ? "/tsp" : ""}/pg/api/${path}`;
}

// ICICI expects amounts in major units with two decimals, as a string.
const amountString = (minor) => (minor / 100).toFixed(2);
const amountMinor = (str) => Math.round(Number(str) * 100);

// yyyyMMddHHmmss in Asia/Kolkata wall-clock time.
function txnDate(d = new Date()) {
  return new Date(d.getTime() + 330 * 60000).toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

// A new unique reference for each status / refund call (the bank rejects reuse of a merchantTxnNo).
const newReference = (prefix) => `${prefix}${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(2).toString("hex").toUpperCase()}`;

// Response headers worth keeping when ICICI (or a firewall in front of it) refuses a request: they say who answered.
const DIAGNOSTIC_HEADERS = ["content-type", "server", "via", "x-request-id", "x-correlation-id", "cf-ray", "x-amzn-requestid", "retry-after"];

// The start of an answer we could not use, for the log. Whitespace is collapsed, it is cut short, and our own hash and secret are removed
// in case an error page echoes the request (the request itself is never logged).
function bodyPreview(text, secrets = []) {
  let out = String(text || "").replace(/\s+/g, " ");
  out = Array.from(out).filter((ch) => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 127).join("").trim(); // no other control characters in the log
  for (const secret of secrets) if (secret && String(secret).length >= 6) out = out.split(String(secret)).join("[removed]");
  return out.length > 500 ? `${out.slice(0, 500)}... (${out.length} characters)` : out;
}

async function post(url, body) {
  const startedAt = Date.now();
  let res;
  try {
    res = await safeFetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, { allowHosts: ICICI_HOSTS, maxRedirects: 0, maxBytes: 1024 * 1024, timeoutMs: 30000 });
  } catch (err) {
    // Never log the body: it carries the secure hash and customer details.
    logger.error("ICICI request failed", { path: new URL(url).pathname, ms: Date.now() - startedAt, error: err.message });
    throw Object.assign(new Error(`ICICI could not be reached: ${err.cause?.message || err.message}`), { status: 502, cause: err });
  }
  logger.debug("ICICI response", { path: new URL(url).pathname, status: res.status, ms: Date.now() - startedAt });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok || !json) {
    // What ICICI actually said, so that a refusal can be taken up with them. Only the answer is logged, never what we sent.
    const headers = {};
    if (res.headers && typeof res.headers.get === "function") for (const h of DIAGNOSTIC_HEADERS) { const v = res.headers.get(h); if (v) headers[h] = v; }
    logger.warn("ICICI refused the request or sent an answer that is not JSON", {
      path: new URL(url).pathname, transactionType: body.transactionType, status: res.status, headers, bodyPreview: bodyPreview(text, [body.secureHash, cfg().secretKey]),
    });
    throw Object.assign(new Error(`ICICI answered HTTP ${res.status}${json ? "" : " with a non-JSON body"}`), { status: 502, httpStatus: res.status });
  }
  return json;
}

async function command(fields) {
  const c = requireConfigured();
  const body = { aggregatorID: c.aggregatorId, merchantId: c.merchantId, ...fields };
  body.secureHash = secureHash(body, c.secretKey);
  return post(`${endpoint(c, "command")}?reqType=JSON`, body);
}

async function createPayment(order, { returnUrl, customerEmail, customerName, customerPhone }) {
  const c = requireConfigured();
  const fields = {
    aggregatorID: c.aggregatorId,
    amount: amountString(order.totalMinor),
    currencyCode: CURRENCY_CODE[order.currency],
    customerEmailID: customerEmail || "",
    customerMobileNo: customerPhone || "",
    customerName: customerName || "",
    merchantId: c.merchantId,
    merchantTxnNo: order.merchantTxnNo,
    payType: "0",
    returnURL: returnUrl,
    transactionType: "SALE",
    txnDate: txnDate(),
  };
  fields.secureHash = secureHash(fields, c.secretKey);
  const body = await post(endpoint(c, "v2/initiateSale"), fields);
  if (body.responseCode !== "R1000" || !body.redirectURI || !body.tranCtx) {
    logger.error("ICICI did not start the payment", { merchantTxnNo: order.merchantTxnNo, responseCode: body.responseCode, description: body.respDescription });
    throw Object.assign(new Error(`ICICI could not start the payment (${body.responseCode || "no code"}): ${body.respDescription || "no description"}`), { status: 502 });
  }
  return { redirectUrl: `${body.redirectURI}?tranCtx=${encodeURIComponent(body.tranCtx)}`, gatewayRef: null };
}

// Return POST fields or a Payment Advice -> normalised result. The signature must be valid; the caller still confirms the
// final outcome with checkStatus().
async function verifyReturn(params) {
  const c = requireConfigured();
  if (!params.secureHash || !safeEqual(params.secureHash, secureHash(params, c.secretKey))) {
    logger.warn("ICICI return with an invalid signature", { merchantTxnNo: params.merchantTxnNo });
    throw Object.assign(new Error("Invalid ICICI signature"), { status: 400 });
  }
  const code = String(params.responseCode || "");
  return {
    merchantTxnNo: params.merchantTxnNo,
    status: SUCCESS_CODES.has(code) ? "paid" : PENDING_CODES.has(code) ? "pending" : "failed",
    gatewayRef: params.txnID || null,
    raw: params,
  };
}

// Normalises a command response about a SALE.
function interpretSale(order, r) {
  const base = { merchantTxnNo: order.merchantTxnNo, gatewayRef: r.txnID || null, raw: r };
  if (r.txnStatus === "SUC" && SUCCESS_CODES.has(String(r.txnResponseCode))) {
    return { ...base, status: "paid", amountMinor: amountMinor(r.amount), currency: order.currency };
  }
  if (r.txnStatus === "REJ" || r.txnStatus === "FAIL" || r.txnStatus === "CAN") {
    return { ...base, status: "failed", failureReason: r.txnRespDescription || r.respDescription || "Payment was declined" };
  }
  // REQ (in progress), P0030 (awaiting the customer), unknown order yet: not final.
  return { ...base, status: "pending" };
}

// A STATUS call only reads, and ICICI's UAT front end was seen refusing a share of them with a bare 403 from its load balancer (the same call
// a few seconds later was answered). So a status check that is refused (403, 429), gets a 5xx, an unreadable answer or no answer at all is tried
// again after a short pause, three attempts in all. Every attempt has its own reference (the bank rejects a reused one). Refunds and
// payments are never retried this way: a repeated REFUND or SALE could be done twice.
const retry = { delaysMs: [1000, 2000] };
const isTransientRead = (err) => isUnknownOutcome(err) || err.httpStatus === 403 || err.httpStatus === 429;
async function statusCommand(prefix, fields) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await command({ merchantTxnNo: newReference(prefix), ...fields, transactionType: "STATUS" });
    } catch (err) {
      if (attempt >= retry.delaysMs.length || !isTransientRead(err)) throw err;
      logger.warn("ICICI status check was refused or unanswered; trying again", { attempt: attempt + 1, of: retry.delaysMs.length + 1, afterMs: retry.delaysMs[attempt], status: err.httpStatus || null });
      await new Promise((resolve) => setTimeout(resolve, retry.delaysMs[attempt]));
    }
  }
}

async function checkStatus(order) {
  const r = await statusCommand("S", { originalTxnNo: order.merchantTxnNo });
  return interpretSale(order, r);
}

// A copy of a bank message that is safe to store or show: anything that looks like a hash, secret, password or card detail is dropped.
const SECRET_FIELD = /hash|secret|password|passwd|card|cvv|\bpan\b|token/i;
function redact(raw) {
  const out = {};
  for (const [k, v] of Object.entries(raw || {})) if (!SECRET_FIELD.test(k)) out[k] = v;
  return out;
}

// What the bank answered to a REFUND request, as one of: "succeeded" (done at once), "processing" (accepted or still pending: the
// outcome is read later with a STATUS on the refund reference), "failed" (declined). Anything unknown is a decline, never a success.
function interpretRefundRequest(r) {
  if (r.txnStatus === "SUC" && SUCCESS_CODES.has(String(r.txnResponseCode))) return { status: "succeeded" };
  if (r.responseCode === REFUND_ACCEPTED || PENDING_CODES.has(String(r.responseCode))) return { status: "processing" };
  return { status: "failed", reason: `ICICI declined the refund request (${r.responseCode || "no code"}): ${r.respDescription || r.txnRespDescription || "no description"}` };
}

// A request that got no usable answer from the bank (timeout, connection lost, a 5xx from a proxy in front of it, a 200 that is not
// JSON) may still have been received: that is not a decline, and the refund must not be retried blindly. Only a 4xx, or a gateway
// that is not configured, is a real failure.
const isUnknownOutcome = (err) => (err.httpStatus !== undefined ? !(err.httpStatus >= 400 && err.httpStatus < 500) : !!err.cause);

// Starts a refund. The bank accepts it with R1000 and decides later, so the answer is "processing" with the refund's own
// reference; settleRefund() reads the final outcome from that reference. If the bank cannot be reached the answer is also
// "processing" but flagged unconfirmed: the same reference is asked about later, so the refund is neither lost nor duplicated.
async function refund(order, amountMinorToRefund, refundId) {
  const reference = `RF${refundId.replace(/-/g, "").slice(0, 14).toUpperCase()}`;
  let r;
  try {
    r = await command({ merchantTxnNo: reference, originalTxnNo: order.merchantTxnNo, amount: amountString(amountMinorToRefund), transactionType: "REFUND" });
  } catch (err) {
    if (!isUnknownOutcome(err)) throw err;
    logger.warn("ICICI refund request got no answer; the outcome is unknown and will be checked", { refundId, merchantTxnNo: order.merchantTxnNo, error: err.message });
    return { status: "processing", gatewayRef: reference, unconfirmed: true, raw: { error: err.message } };
  }
  const verdict = interpretRefundRequest(r);
  const detail = { gatewayRef: reference, gatewayTxnId: r.txnID || null, raw: redact(r) };
  if (verdict.status === "failed") {
    logger.error("ICICI declined the refund request", { refundId, merchantTxnNo: order.merchantTxnNo, responseCode: r.responseCode, description: r.respDescription });
    throw Object.assign(new Error(verdict.reason), { status: 502, gatewayResponse: detail.raw });
  }
  return { status: verdict.status, ...detail };
}

// Final outcome of a refund started earlier: STATUS on the refund reference.
async function settleRefund(refundRow) {
  const r = await statusCommand("T", { originalTxnNo: refundRow.gateway_ref });
  const detail = { gatewayTxnId: r.txnID || null, raw: redact(r) };
  if (r.txnStatus === "SUC" && SUCCESS_CODES.has(String(r.txnResponseCode))) return { status: "succeeded", ...detail };
  if (r.txnStatus === "REJ" || r.txnStatus === "FAIL") return { status: "failed", reason: r.txnRespDescription || r.respDescription || "Refund rejected by the bank", ...detail };
  if (!r.txnStatus && REFUND_DECLINE_CODES.has(String(r.responseCode))) return { status: "failed", reason: r.respDescription || "Refund declined by the bank", ...detail };
  return { status: "processing", ...detail };
}

module.exports = { name, retry, bodyPreview, secureHash, createPayment, verifyReturn, checkStatus, refund, settleRefund, interpretSale, interpretRefundRequest, redact };
