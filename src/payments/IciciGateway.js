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
// Sandbox findings baked in below: a sale is paid only when txnStatus is SUC (a bare responseCode 0000 also appears on
// pending payments); R1000 on a refund means "accepted", the outcome comes from a STATUS on the refund reference; the bank
// page may add a service charge on top of `amount`, which is reported separately as `oth_charge`.
const crypto = require("crypto");
const config = require("../config");
const { hmacHex, safeEqual } = require("../utils/crypto");

const name = "icici";
const cfg = () => config.payment.icici;
const CURRENCY_CODE = { INR: "356", USD: "840" }; // ISO 4217 numeric

const SUCCESS_CODES = new Set(["0", "00", "000", "0000"]);
const PENDING_CODES = new Set(["P0030", "U1000", "R1000"]); // awaiting customer, request pending, request accepted
const REFUND_ACCEPTED = "R1000";

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

async function post(url, body) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok || !json) {
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
    throw Object.assign(new Error(`ICICI could not start the payment (${body.responseCode || "no code"}): ${body.respDescription || "no description"}`), { status: 502 });
  }
  return { redirectUrl: `${body.redirectURI}?tranCtx=${encodeURIComponent(body.tranCtx)}`, gatewayRef: null };
}

// Return POST fields or a Payment Advice -> normalised result. The signature must be valid; the caller still confirms the
// final outcome with checkStatus().
async function verifyReturn(params) {
  const c = requireConfigured();
  if (!params.secureHash || !safeEqual(params.secureHash, secureHash(params, c.secretKey))) {
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

async function checkStatus(order) {
  const r = await command({ merchantTxnNo: newReference("S"), originalTxnNo: order.merchantTxnNo, transactionType: "STATUS" });
  return interpretSale(order, r);
}

// Starts a refund. The bank accepts it with R1000 and decides later, so the answer is "processing" with the refund's own
// reference; settleRefund() reads the final outcome from that reference.
async function refund(order, amountMinorToRefund, refundId) {
  const reference = `RF${refundId.replace(/-/g, "").slice(0, 14).toUpperCase()}`;
  const r = await command({ merchantTxnNo: reference, originalTxnNo: order.merchantTxnNo, amount: amountString(amountMinorToRefund), transactionType: "REFUND" });
  if (r.responseCode !== REFUND_ACCEPTED) {
    throw Object.assign(new Error(`ICICI declined the refund request (${r.responseCode || "no code"}): ${r.respDescription || ""}`), { status: 502 });
  }
  return { status: "processing", gatewayRef: reference, raw: r };
}

// Final outcome of a refund started earlier: STATUS on the refund reference.
async function settleRefund(refundRow) {
  const r = await command({ merchantTxnNo: newReference("T"), originalTxnNo: refundRow.gateway_ref, transactionType: "STATUS" });
  if (r.txnStatus === "SUC" && SUCCESS_CODES.has(String(r.txnResponseCode))) return { status: "succeeded", raw: r };
  if (r.txnStatus === "REJ" || r.txnStatus === "FAIL") return { status: "failed", reason: r.txnRespDescription || r.respDescription || "Refund rejected by the bank", raw: r };
  return { status: "processing", raw: r };
}

module.exports = { name, secureHash, createPayment, verifyReturn, checkStatus, refund, settleRefund, interpretSale };
