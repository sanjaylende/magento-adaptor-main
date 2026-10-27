// A pretend ICICI bank for automated tests. It answers the same calls the adapter makes to the ICICI sandbox (start a sale,
// status, refund) with the same field names and codes, and signs the browser return the way the bank does. Nothing here
// reaches the real bank, and the secret below is made up. Calls to any other address go through unchanged.
// App code is loaded inside install(), after the test settings are in place (config reads the environment once, when first loaded).

const ENV = {
  ICICI_PG_BASE_URL: "https://pgpayuat.icicibank.com",
  ICICI_PG_MERCHANT_ID: "100000000000001",
  ICICI_PG_AGGREGATOR_ID: "A100000000000001",
  ICICI_PG_SECRET_KEY: "test-secret",
};

function install() {
  const { setFetchForTests } = require("../src/utils/safeFetch");
  const sales = new Map(); // merchantTxnNo -> { amount, result: "paid" | "failed" | "pending" }
  // How the bank treats refunds. mode (the answer to the REFUND request): accept (R1000, default) | decline | pending | immediate |
  // timeout (no answer at all) | http503. status (the answer to a STATUS on the refund reference): success (default) | rejected | pending | declined | unfamiliar.
  const refund = { mode: "accept", status: "success", calls: [] };
  const faults = { statusDown: false, refuseNext: 0 }; // statusDown: the bank cannot be reached for STATUS checks of a sale; refuseNext: the next n STATUS checks get ICICI's load-balancer 403
  const statusCalls = []; // the originalTxnNo of every STATUS check of a sale that reached the bank
  const realFetch = global.fetch;
  const reply = (json) => ({ ok: true, status: 200, text: async () => JSON.stringify(json) });
  const gateway = require("../src/payments/IciciGateway");

  setFetchForTests(async (url, init) => {
    const u = new URL(url);
    if (!/(^|\.)icicibank\.com$/.test(u.hostname)) return realFetch(url, init);
    const body = JSON.parse(init.body);
    if (u.pathname.endsWith("/v2/initiateSale")) {
      sales.set(body.merchantTxnNo, { amount: body.amount, result: "pending" });
      return reply({ responseCode: "R1000", redirectURI: "https://pgpayuat.icici.bank.in/tsp/pg/api/v2/authRedirect", tranCtx: body.merchantTxnNo });
    }
    if (body.transactionType === "REFUND") {
      refund.calls.push({ merchantTxnNo: body.merchantTxnNo, originalTxnNo: body.originalTxnNo, amount: body.amount, signed: gateway.secureHash(body, ENV.ICICI_PG_SECRET_KEY) === body.secureHash });
      if (refund.mode === "timeout") throw new Error("socket hang up");
      if (refund.mode === "http503") return { ok: false, status: 503, text: async () => "upstream timed out" };
      if (refund.mode === "decline") return reply({ responseCode: "E1100", respDescription: "Refund amount exceeds the transaction" });
      if (refund.mode === "pending") return reply({ responseCode: "P0030", respDescription: "Awaiting action" });
      if (refund.mode === "immediate") return reply({ responseCode: "0000", txnStatus: "SUC", txnResponseCode: "0000", txnID: `BANKRF-${body.merchantTxnNo}` });
      return reply({ responseCode: "R1000", respDescription: "Request accepted", txnID: `BANKRF-${body.merchantTxnNo}`, secureHash: "must-never-be-stored" });
    }
    if (body.transactionType === "STATUS") {
      if (String(body.originalTxnNo).startsWith("RF")) {
        if (refund.status === "rejected") return reply({ responseCode: "0000", txnStatus: "REJ", txnResponseCode: "039", txnRespDescription: "Refund rejected by the issuer" });
        if (refund.status === "pending") return reply({ responseCode: "P0030", respDescription: "Awaiting action" });
        // as the UAT sandbox answered after accepting a refund: a decline code and a description, and no txnStatus
        if (refund.status === "declined") return reply({ responseCode: "039", respDescription: "Transaction Declined", merchantTxnNo: body.originalTxnNo, amount: "27.50", paymentMode: "Card", acqName: "PayPhi" });
        if (refund.status === "unfamiliar") return reply({ responseCode: "E9999", respDescription: "Something the adapter does not know" });
        return reply({ responseCode: "0000", txnStatus: "SUC", txnResponseCode: "0000", txnID: `BANKRF-${body.originalTxnNo}` });
      }
      if (faults.statusDown) throw new Error("socket hang up");
      if (faults.refuseNext > 0) {
        faults.refuseNext--;
        return { ok: false, status: 403, headers: { get: (n) => ({ server: "awselb/2.0", "content-type": "text/html" })[n] || null }, text: async () => "<html><head><title>403 Forbidden</title></head><body><center><h1>403 Forbidden</h1></center></body></html>" };
      }
      statusCalls.push(body.originalTxnNo);
      const sale = sales.get(body.originalTxnNo);
      if (!sale || sale.result === "pending") return reply({ responseCode: "P0030", respDescription: "Awaiting user action" });
      if (sale.result === "failed") return reply({ responseCode: "0000", txnStatus: "REJ", txnResponseCode: "039", txnRespDescription: "Card declined", amount: sale.amount });
      return reply({ responseCode: "0000", txnStatus: "SUC", txnResponseCode: "0000", amount: sale.amount, txnID: `BANK-${body.originalTxnNo}` });
    }
    return { ok: false, status: 404, text: async () => "unexpected request" };
  });

  return {
    // The customer finishes (or abandons) the payment on the bank page.
    setResult(txn, result) { if (!sales.has(txn)) sales.set(txn, { amount: "0.00", result }); else sales.get(txn).result = result; },
    // The signed form the bank's page posts to the adapter's return address.
    returnForm(txn, result) {
      const fields = { merchantTxnNo: txn, responseCode: result === "paid" ? "0000" : result === "failed" ? "039" : "P0030", txnID: `BANK-${txn}` };
      return { ...fields, secureHash: gateway.secureHash(fields, ENV.ICICI_PG_SECRET_KEY) };
    },
    // Settles the sale at the bank and has the browser come back, as a real payment does. Returns the adapter's result page.
    async pay(baseUrl, txn, result) {
      this.setResult(txn, result);
      const res = await realFetch(`${baseUrl}/billing/return?gw=icici`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(this.returnForm(txn, result)) });
      return res.text();
    },
    // Refund behaviour switches and the log of refund requests the bank received (see the comment on `refund` above).
    setRefundMode(mode) { refund.mode = mode; },
    setRefundStatus(status) { refund.status = status; },
    refundCalls() { return refund.calls; },
    resetRefund() { refund.mode = "accept"; refund.status = "success"; refund.calls.length = 0; faults.statusDown = false; faults.refuseNext = 0; statusCalls.length = 0; },
    setStatusRefuseNext(n) { faults.refuseNext = n; },
    statusCount(txn) { return statusCalls.filter((t) => t === txn).length; },
    setStatusDown(down) { faults.statusDown = !!down; },
    uninstall() { setFetchForTests(null); },
  };
}

module.exports = { ENV, install };
