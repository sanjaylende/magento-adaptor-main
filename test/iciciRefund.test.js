// ICICI refunds at the gateway level (HTTP stubbed): how the request is built and signed, how every kind of answer is mapped, and what is
// kept of it. Answers are shaped like the real sandbox ones (see test/icici.test.js). The secret below is made up.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

Object.assign(process.env, {
  ADAPTER_SECRET_KEY: "11".repeat(32),
  ICICI_PG_BASE_URL: "https://pgpayuat.icicibank.com",
  ICICI_PG_MERCHANT_ID: "100000000000001",
  ICICI_PG_AGGREGATOR_ID: "A100000000000001",
  ICICI_PG_SECRET_KEY: "test-secret",
});
const icici = require("../src/payments/IciciGateway");
const config = require("../src/config");
const logger = require("../src/utils/logger");

// The pause between status attempts is a second or two in production; the tests do not wait for it.
const DEFAULT_RETRY_DELAYS = [...icici.retry.delaysMs];
icici.retry.delaysMs = [0, 0];

const order = { merchantTxnNo: "FLORDER00001" };
const REFUND_ID = "11111111-2222-3333-4444-555555555555";

// Stubs fetch. handler(body) returns { status, json } or throws (a network failure); every request the gateway sent is recorded.
function stubFetch(handler) {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    const { status = 200, json, headers = {} } = handler(body);
    return { ok: status < 400, status, headers: { get: (name) => headers[name] || null }, text: async () => (typeof json === "string" ? json : JSON.stringify(json)) };
  };
  return { calls, restore: () => { global.fetch = original; } };
}
const accepted = () => ({ json: { responseCode: "R1000", respDescription: "Request accepted", txnID: "BANK-RF-1", secureHash: "abc123" } });

test("the refund request is a signed REFUND naming the sale, with a reference of its own and the amount in major units", async () => {
  const stub = stubFetch(accepted);
  try {
    await icici.refund(order, 1050, REFUND_ID);
    const { url, body } = stub.calls[0];
    assert.match(url, /^https:\/\/pgpayuat\.icicibank\.com\/tsp\/pg\/api\/command\?reqType=JSON$/);
    assert.equal(body.transactionType, "REFUND");
    assert.equal(body.originalTxnNo, "FLORDER00001");
    assert.equal(body.amount, "10.50");
    assert.equal(body.merchantTxnNo, "RF11111111222233");
    assert.equal(body.merchantId, "100000000000001");
    assert.equal(body.aggregatorID, "A100000000000001");
    // the signature, recomputed here independently of the gateway's own helper: values in alphabetical key order, HMAC-SHA256 with the secret
    const { secureHash, ...rest } = body;
    const data = Object.keys(rest).sort().map((k) => String(rest[k])).join("");
    assert.equal(secureHash, crypto.createHmac("sha256", "test-secret").update(data).digest("hex"));
  } finally { stub.restore(); }
});

test("each refund gets its own reference (the bank refuses a reused one)", async () => {
  const stub = stubFetch(accepted);
  try {
    await icici.refund(order, 100, REFUND_ID);
    await icici.refund(order, 100, "99999999-8888-7777-6666-555555555555");
    assert.notEqual(stub.calls[0].body.merchantTxnNo, stub.calls[1].body.merchantTxnNo);
  } finally { stub.restore(); }
});

test("answers to a refund request map to succeeded, processing or failed; an unknown answer is never a success", () => {
  const table = [
    [{ txnStatus: "SUC", txnResponseCode: "0000" }, "succeeded"],
    [{ responseCode: "R1000" }, "processing"],
    [{ responseCode: "P0030" }, "processing"],
    [{ responseCode: "U1000" }, "processing"],
    [{ responseCode: "E1100", respDescription: "Refund amount exceeds the transaction" }, "failed"],
    [{ responseCode: "0000" }, "failed"], // a bare 0000 is not a refund success (see the sandbox notes in the gateway)
    [{ txnStatus: "REJ", txnResponseCode: "039" }, "failed"],
    [{}, "failed"],
  ];
  for (const [answer, expected] of table) assert.equal(icici.interpretRefundRequest(answer).status, expected, JSON.stringify(answer));
  assert.match(icici.interpretRefundRequest({ responseCode: "E1100", respDescription: "Too much" }).reason, /E1100.*Too much/);
});

test("an accepted refund is 'processing' with the bank's transaction id, and what is kept of the answer has no hash or secret", async () => {
  const stub = stubFetch(accepted);
  try {
    const r = await icici.refund(order, 500, REFUND_ID);
    assert.equal(r.status, "processing");
    assert.equal(r.gatewayRef, "RF11111111222233");
    assert.equal(r.gatewayTxnId, "BANK-RF-1");
    assert.equal(r.raw.responseCode, "R1000");
    assert.equal("secureHash" in r.raw, false);
    assert.equal(r.unconfirmed, undefined);
  } finally { stub.restore(); }
});

test("a declined refund throws, carrying the bank's reason and a cleaned copy of its answer", async () => {
  const stub = stubFetch(() => ({ json: { responseCode: "E1100", respDescription: "Refund amount exceeds the transaction", secureHash: "abc" } }));
  try {
    await assert.rejects(() => icici.refund(order, 500, REFUND_ID), (err) => {
      assert.equal(err.status, 502);
      assert.match(err.message, /declined.*E1100.*exceeds/);
      assert.equal(err.gatewayResponse.responseCode, "E1100");
      assert.equal("secureHash" in err.gatewayResponse, false);
      return true;
    });
  } finally { stub.restore(); }
});

test("no usable answer (timeout, lost connection, 5xx, a 200 that is not JSON) is NOT a decline: processing, unconfirmed, same reference", async () => {
  const cases = [
    ["a network failure", () => { throw new Error("socket hang up"); }],
    ["HTTP 503", () => ({ status: 503, json: "upstream timed out" })],
    ["HTTP 200 with a body that is not JSON", () => ({ status: 200, json: "<html>maintenance</html>" })],
  ];
  for (const [label, handler] of cases) {
    const stub = stubFetch(handler);
    try {
      const r = await icici.refund(order, 500, REFUND_ID);
      assert.equal(r.status, "processing", label);
      assert.equal(r.unconfirmed, true, label);
      assert.equal(r.gatewayRef, "RF11111111222233", label);
    } finally { stub.restore(); }
  }
});

test("a 4xx answer and an unconfigured gateway are real failures, not 'unknown'", async () => {
  const stub = stubFetch(() => ({ status: 400, json: { error: "bad request" } }));
  try {
    await assert.rejects(() => icici.refund(order, 500, REFUND_ID), (err) => err.status === 502 && err.httpStatus === 400);
  } finally { stub.restore(); }
  const saved = config.payment.icici.merchantId;
  config.payment.icici.merchantId = "";
  try {
    await assert.rejects(() => icici.refund(order, 500, REFUND_ID), (err) => err.status === 503 && /not configured/.test(err.message));
  } finally { config.payment.icici.merchantId = saved; }
});

test("settling a refund: SUC is succeeded, REJ is failed with the bank's reason, anything else is still processing", async () => {
  const row = { gateway_ref: "RF11111111222233" };
  const cases = [
    [{ responseCode: "0000", txnStatus: "SUC", txnResponseCode: "0000", txnID: "BANK-RF-1", secureHash: "x" }, "succeeded"],
    [{ responseCode: "0000", txnStatus: "REJ", txnResponseCode: "039", txnRespDescription: "Refund rejected by the issuer" }, "failed"],
    [{ responseCode: "P0030" }, "processing"],
    [{ responseCode: "0000", txnStatus: "REQ" }, "processing"],
    // the real sandbox answer for a refund the bank accepted and then declined: a decline code and a description, no txnStatus
    [{ responseCode: "039", respDescription: "Transaction Declined", merchantTxnNo: "RF11111111222233", amount: "27.50", paymentMode: "Card", acqName: "PayPhi", secureHash: "x" }, "failed"],
    // a code the adapter does not know is never turned into a failure: the refund may have gone through
    [{ responseCode: "E9999", respDescription: "Something else" }, "processing"],
    [{ responseCode: "039", txnStatus: "REQ" }, "processing"],
  ];
  for (const [answer, expected] of cases) {
    const stub = stubFetch(() => ({ json: answer }));
    try {
      const r = await icici.settleRefund(row);
      assert.equal(r.status, expected, JSON.stringify(answer));
      assert.equal(stub.calls[0].body.originalTxnNo, "RF11111111222233");
      assert.equal(stub.calls[0].body.transactionType, "STATUS");
      assert.equal("secureHash" in r.raw, false);
      if (expected === "succeeded") assert.equal(r.gatewayTxnId, "BANK-RF-1");
      if (expected === "failed") assert.match(r.reason, /rejected by the issuer|Transaction Declined/);
    } finally { stub.restore(); }
  }
});

test("redact drops hashes, secrets, passwords, card and token fields and keeps the rest", () => {
  const out = icici.redact({ responseCode: "R1000", txnID: "T1", secureHash: "h", clientSecret: "s", password: "p", cardNumber: "4111", pan: "x", authToken: "t", company: "kept" });
  assert.deepEqual(out, { responseCode: "R1000", txnID: "T1", company: "kept" });
});

test("when the bank (or a firewall in front of it) refuses with an error page, the log keeps its status, headers and the start of the page, without our hash or secret", async () => {
  const page = '<html><head><title>Access Denied</title></head><body>Access Denied. Reference #18.5f4c1e02.1730000000.abc123. Request hash {HASH} secret test-secret</body></html>';
  const seen = [];
  const original = logger.warn;
  logger.warn = (message, meta) => seen.push({ message, meta });
  let sent;
  const stub = stubFetch((body) => {
    sent = body;
    return { status: 403, json: page.replace("{HASH}", body.secureHash), headers: { server: "AkamaiGHost", "content-type": "text/html" } };
  });
  try {
    await assert.rejects(() => icici.refund(order, 500, REFUND_ID), (err) => err.status === 502 && err.httpStatus === 403 && /HTTP 403 with a non-JSON body/.test(err.message));
  } finally {
    stub.restore();
    logger.warn = original;
  }
  const entry = seen.find((e) => /refused the request/.test(e.message));
  assert.ok(entry, "the refusal was logged");
  assert.equal(entry.meta.status, 403);
  assert.equal(entry.meta.transactionType, "REFUND");
  assert.equal(entry.meta.path, "/tsp/pg/api/command");
  assert.deepEqual(entry.meta.headers, { "content-type": "text/html", server: "AkamaiGHost" });
  assert.match(entry.meta.bodyPreview, /Access Denied\. Reference #18\.5f4c1e02/);
  assert.ok(!entry.meta.bodyPreview.includes(sent.secureHash), "our request hash is not in the log");
  assert.ok(!entry.meta.bodyPreview.includes("test-secret"), "our secret is not in the log");
  assert.ok(!JSON.stringify(entry).includes(sent.secureHash), "nothing in the entry carries the hash");
});

test("the logged part of an answer is short, on one line, and free of control characters", () => {
  const long = icici.bodyPreview("x".repeat(2000));
  assert.ok(long.length < 560);
  assert.match(long, /\(2000 characters\)$/);
  assert.equal(icici.bodyPreview("<p>a</p>\n\n  <p>b\tc\u0007</p>"), "<p>a</p> <p>b c</p>");
  assert.equal(icici.bodyPreview(""), "");
  assert.equal(icici.bodyPreview("my secret is abcdef123 ok", ["abcdef123"]), "my secret is [removed] ok");
  assert.equal(icici.bodyPreview("short x", ["x"]), "short x", "very short secrets are not matched (they would blank ordinary text)");
});

// ---- status checks are tried again when the bank refuses or does not answer; refunds and payments never are ----
const SUCCESS = { responseCode: "0000", txnStatus: "SUC", txnResponseCode: "0000", amount: "10.00", txnID: "T1" };
const lbRefusal = { status: 403, json: "<html><head><title>403 Forbidden</title></head><body><h1>403 Forbidden</h1></body></html>", headers: { server: "awselb/2.0" } };
const sale = { merchantTxnNo: "FLSALE0001", currency: "INR" };

test("a status check is tried at most three times, a second and then two seconds apart in production", () => {
  assert.deepEqual(DEFAULT_RETRY_DELAYS, [1000, 2000]);
});

test("a status check refused with the load balancer's 403 is tried again and succeeds; each attempt has its own reference", async () => {
  let n = 0;
  const stub = stubFetch(() => (++n === 1 ? lbRefusal : { json: SUCCESS }));
  try {
    const r = await icici.checkStatus(sale);
    assert.equal(r.status, "paid");
    assert.equal(stub.calls.length, 2);
    assert.ok(stub.calls.every((c) => c.body.transactionType === "STATUS" && c.body.originalTxnNo === "FLSALE0001"));
    assert.notEqual(stub.calls[0].body.merchantTxnNo, stub.calls[1].body.merchantTxnNo, "the bank rejects a reused reference");
    assert.notEqual(stub.calls[0].body.secureHash, stub.calls[1].body.secureHash);
  } finally { stub.restore(); }
});

test("two refusals in a row are survived (three attempts), three in a row end with the last refusal thrown", async () => {
  let n = 0;
  let stub = stubFetch(() => (++n <= 2 ? lbRefusal : { json: SUCCESS }));
  try { assert.equal((await icici.checkStatus(sale)).status, "paid"); assert.equal(stub.calls.length, 3); } finally { stub.restore(); }
  stub = stubFetch(() => lbRefusal);
  try {
    await assert.rejects(() => icici.checkStatus(sale), (err) => err.httpStatus === 403 && err.status === 502);
    assert.equal(stub.calls.length, 3, "three attempts, then it gives up");
  } finally { stub.restore(); }
});

test("a status check is retried after a 429, a 5xx, a page that is not JSON and a lost connection, but not after a 400 or 404", async () => {
  const transient = [["HTTP 429", () => ({ status: 429, json: "slow down" })], ["HTTP 502", () => ({ status: 502, json: "bad gateway" })], ["a 200 that is not JSON", () => ({ status: 200, json: "<html>maintenance</html>" })], ["a lost connection", () => { throw new Error("socket hang up"); }]];
  for (const [label, failure] of transient) {
    let n = 0;
    const stub = stubFetch(() => (++n === 1 ? failure() : { json: SUCCESS }));
    try { assert.equal((await icici.checkStatus(sale)).status, "paid", label); assert.equal(stub.calls.length, 2, label); } finally { stub.restore(); }
  }
  for (const status of [400, 404]) {
    const stub = stubFetch(() => ({ status, json: { error: "no" } }));
    try {
      await assert.rejects(() => icici.checkStatus(sale), (err) => err.httpStatus === status);
      assert.equal(stub.calls.length, 1, `HTTP ${status} is not retried`);
    } finally { stub.restore(); }
  }
});

test("settling a refund is retried the same way", async () => {
  let n = 0;
  const stub = stubFetch(() => (++n === 1 ? lbRefusal : { json: { responseCode: "0000", txnStatus: "SUC", txnResponseCode: "0000", txnID: "BANK-RF-9" } }));
  try {
    const r = await icici.settleRefund({ gateway_ref: "RF11111111222233" });
    assert.equal(r.status, "succeeded");
    assert.equal(stub.calls.length, 2);
    assert.notEqual(stub.calls[0].body.merchantTxnNo, stub.calls[1].body.merchantTxnNo);
  } finally { stub.restore(); }
});

test("a refund and a payment are never retried by the gateway (a repeat could be done twice)", async () => {
  let stub = stubFetch(() => lbRefusal);
  try {
    await assert.rejects(() => icici.refund(order, 500, REFUND_ID), (err) => err.httpStatus === 403);
    assert.equal(stub.calls.length, 1, "REFUND sent once");
  } finally { stub.restore(); }
  stub = stubFetch(() => ({ status: 503, json: "upstream" }));
  try {
    assert.equal((await icici.refund(order, 500, REFUND_ID)).unconfirmed, true);
    assert.equal(stub.calls.length, 1, "REFUND sent once even when the outcome is unknown");
  } finally { stub.restore(); }
  stub = stubFetch(() => lbRefusal);
  try {
    await assert.rejects(() => icici.createPayment({ merchantTxnNo: "FLSALE0002", totalMinor: 1000, currency: "INR" }, { returnUrl: "http://x/billing/return?gw=icici" }), (err) => err.httpStatus === 403);
    assert.equal(stub.calls.length, 1, "SALE sent once");
  } finally { stub.restore(); }
});
