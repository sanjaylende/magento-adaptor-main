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
    if (body.transactionType === "REFUND") return reply({ responseCode: "R1000", respDescription: "Request accepted" });
    if (body.transactionType === "STATUS") {
      if (String(body.originalTxnNo).startsWith("RF")) return reply({ responseCode: "0000", txnStatus: "SUC", txnResponseCode: "0000" });
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
    uninstall() { setFetchForTests(null); },
  };
}

module.exports = { ENV, install };
