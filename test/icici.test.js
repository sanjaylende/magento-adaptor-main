// ICICI gateway: signature method, return/advice handling, status and refund calls (HTTP stubbed). The response shapes are
// taken from real sandbox answers recorded during integration. No credentials appear here; the secret below is made up.
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

const hmac = (text) => crypto.createHmac("sha256", "test-secret").update(text).digest("hex");

// Stubs fetch and records what the gateway sent.
function stubFetch(handler) {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    const { status = 200, json } = handler(url, body);
    return { ok: status < 400, status, text: async () => (typeof json === "string" ? json : JSON.stringify(json)) };
  };
  return { calls, restore: () => { global.fetch = original; } };
}

test("secureHash: top-level keys sorted, values concatenated, nested JSON-encoded, null skipped, secureHash excluded", () => {
  const fields = { merchantId: "M1", amount: "10.00", udfFields: { udf23: "x" }, empty: null, skipped: undefined, aggregatorID: "A1", secureHash: "ignored" };
  assert.equal(icici.secureHash(fields, "test-secret"), hmac("A110.00" + "M1" + '{"udf23":"x"}'));
});

test("verifyReturn: signed success (0000), decline (039) and pending (P0030); forged signature rejected", async () => {
  const signed = (f) => ({ ...f, secureHash: icici.secureHash(f, "test-secret") });
  assert.equal((await icici.verifyReturn(signed({ merchantTxnNo: "X", responseCode: "0000", txnID: "T1" }))).status, "paid");
  assert.equal((await icici.verifyReturn(signed({ merchantTxnNo: "X", responseCode: "000" }))).status, "paid");
  assert.equal((await icici.verifyReturn(signed({ merchantTxnNo: "X", responseCode: "039", respDescription: "Transaction Declined" }))).status, "failed");
  assert.equal((await icici.verifyReturn(signed({ merchantTxnNo: "X", responseCode: "P0030" }))).status, "pending");
  await assert.rejects(() => icici.verifyReturn({ merchantTxnNo: "X", responseCode: "0000", secureHash: "0".repeat(64) }), /Invalid ICICI signature/);
  // Tampering with a field after signing is caught.
  const good = signed({ merchantTxnNo: "X", responseCode: "039", amount: "1.00" });
  await assert.rejects(() => icici.verifyReturn({ ...good, responseCode: "0000" }), /Invalid ICICI signature/);
});

test("createPayment: signed initiateSale to the UAT path, redirect built from redirectURI and tranCtx", async () => {
  const stub = stubFetch(() => ({ json: { responseCode: "R1000", redirectURI: "https://pay.example/authRedirect", tranCtx: "CTX-1" } }));
  try {
    const out = await icici.createPayment({ merchantTxnNo: "FLP1", totalMinor: 229900, currency: "INR" }, { returnUrl: "https://adapter.test/billing/return?gw=icici", customerEmail: "a@b.c", customerName: "A", customerPhone: "9999999999" });
    assert.equal(out.redirectUrl, "https://pay.example/authRedirect?tranCtx=CTX-1");
    const { url, body } = stub.calls[0];
    assert.equal(url, "https://pgpayuat.icicibank.com/tsp/pg/api/v2/initiateSale");
    assert.equal(body.amount, "2299.00");
    assert.equal(body.currencyCode, "356");
    assert.equal(body.transactionType, "SALE");
    assert.match(body.txnDate, /^\d{14}$/);
    assert.equal(body.secureHash, icici.secureHash(body, "test-secret"));
  } finally { stub.restore(); }
});

test("createPayment: a non-R1000 answer is an error", async () => {
  const stub = stubFetch(() => ({ json: { responseCode: "P1006", respDescription: "Validation error" } }));
  try {
    await assert.rejects(() => icici.createPayment({ merchantTxnNo: "FLP2", totalMinor: 100, currency: "INR" }, { returnUrl: "https://x" }), /P1006/);
  } finally { stub.restore(); }
});

test("checkStatus: STATUS command with a fresh reference; SUC is paid, REJ failed, REQ and P0030 pending", async () => {
  const order = { merchantTxnNo: "FLP3", totalMinor: 100, currency: "INR" };
  const answers = [
    { responseCode: "0000", txnStatus: "SUC", txnResponseCode: "0000", amount: "1.00", txnID: "7700230880347", oth_charge: "1.00" },
    { responseCode: "0000", txnStatus: "REJ", txnResponseCode: "039", txnRespDescription: "Declined", amount: "1.00" },
    { responseCode: "0000", txnStatus: "REQ", amount: "1.00" },
    { responseCode: "P0030", respDescription: "Awaiting user action" },
  ];
  const stub = stubFetch(() => ({ json: answers.shift() }));
  try {
    const paid = await icici.checkStatus(order);
    assert.equal(paid.status, "paid");
    assert.equal(paid.amountMinor, 100, "amount is the base amount, not including the bank's service charge");
    assert.equal(paid.gatewayRef, "7700230880347");
    assert.equal((await icici.checkStatus(order)).status, "failed");
    assert.equal((await icici.checkStatus(order)).status, "pending", "responseCode 0000 with txnStatus REQ is still pending");
    assert.equal((await icici.checkStatus(order)).status, "pending");
    const first = stub.calls[0];
    assert.equal(first.url, "https://pgpayuat.icicibank.com/tsp/pg/api/command?reqType=JSON");
    assert.equal(first.body.transactionType, "STATUS");
    assert.equal(first.body.originalTxnNo, "FLP3");
    assert.notEqual(first.body.merchantTxnNo, "FLP3");
    assert.notEqual(stub.calls[0].body.merchantTxnNo, stub.calls[1].body.merchantTxnNo, "every call needs its own reference");
    assert.equal(first.body.secureHash, icici.secureHash(first.body, "test-secret"));
  } finally { stub.restore(); }
});

test("checkStatus: an HTTP error from the bank is thrown (the order stays pending and is re-checked later)", async () => {
  const stub = stubFetch(() => ({ status: 403, json: "<html>403 Forbidden</html>" }));
  try {
    await assert.rejects(() => icici.checkStatus({ merchantTxnNo: "FLP4", totalMinor: 100, currency: "INR" }), /HTTP 403/);
  } finally { stub.restore(); }
});

test("refund: accepted (R1000) means processing under the refund's own reference; the bank's later answer settles it", async () => {
  const stub = stubFetch((url, body) => (body.transactionType === "REFUND"
    ? { json: { responseCode: "R1000", merchantTxnNo: body.merchantTxnNo, txnID: "7700230880348" } }
    : { json: { responseCode: "0000", txnStatus: "REJ", txnResponseCode: "039", txnRespDescription: "ICORE FAILURE : Transaction not permitted to card holder" } }));
  try {
    const started = await icici.refund({ merchantTxnNo: "FLP5" }, 40, "0b8f6f1e-1234-4abc-8def-001122334455");
    assert.equal(started.status, "processing");
    assert.match(started.gatewayRef, /^RF[0-9A-F]+$/);
    const sent = stub.calls[0].body;
    assert.equal(sent.transactionType, "REFUND");
    assert.equal(sent.amount, "0.40");
    assert.equal(sent.originalTxnNo, "FLP5");
    assert.equal(sent.merchantTxnNo, started.gatewayRef);
    const settled = await icici.settleRefund({ gateway_ref: started.gatewayRef });
    assert.equal(settled.status, "failed");
    assert.match(settled.reason, /not permitted/);
    assert.equal(stub.calls[1].body.originalTxnNo, started.gatewayRef, "the refund is followed by its own reference");
  } finally { stub.restore(); }
});

test("refund: a request the bank does not accept is an error", async () => {
  const stub = stubFetch(() => ({ json: { responseCode: "P1112", respDescription: "Refund not allowed" } }));
  try {
    await assert.rejects(() => icici.refund({ merchantTxnNo: "FLP6" }, 100, "0b8f6f1e-1234-4abc-8def-001122334455"), /P1112/);
  } finally { stub.restore(); }
});
