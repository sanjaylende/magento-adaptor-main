#!/usr/bin/env node
// Guided check of ICICI refund and cancel against ICICI's UAT (sandbox) -- run by a person, never by the automatic test run.
//
//   node scripts/icici_uat_refund_test.js            guided run: a payment, a partial refund, the remaining refund, then an unpaid payment and
//                                                     the cancel decision (asks you to confirm before every step that sends something)
//   node scripts/icici_uat_refund_test.js status  <merchantTxnNo>
//   node scripts/icici_uat_refund_test.js refund  <merchantTxnNo> <amountInRupeesOrDollars>
//
// Safety: it stops unless ICICI_PG_BASE_URL is the UAT host (pgpayuat.icicibank.com). It reads ICICI_PG_MERCHANT_ID, ICICI_PG_AGGREGATOR_ID and
// ICICI_PG_SECRET_KEY from .env through the adapter's own config, uses the adapter's own ICICI gateway code (the same signing and answer
// mapping as the service), and prints only non-secret fields of the bank's answers. A real payment needs a person: the script gives you the
// bank page address and waits while you pay with an ICICI UAT test card. Test amounts are tiny (INR 10.00).
const readline = require("readline");
const config = require("../src/config");
const icici = require("../src/payments/IciciGateway");

const UAT_HOST = "pgpayuat.icicibank.com";
const c = config.payment.icici;

function refuseUnlessUat() {
  let host = "";
  try { host = new URL(c.baseUrl).host; } catch { /* reported below */ }
  if (host !== UAT_HOST) {
    console.error(`Refusing to run: ICICI_PG_BASE_URL must be the UAT address (${UAT_HOST}), not "${host || "unset"}". This script never talks to production.`);
    process.exit(2);
  }
  const missing = [["ICICI_PG_MERCHANT_ID", c.merchantId], ["ICICI_PG_AGGREGATOR_ID", c.aggregatorId], ["ICICI_PG_SECRET_KEY", c.secretKey]].filter(([, v]) => !v).map(([n]) => n);
  if (missing.length) {
    console.error(`Refusing to run: ${missing.join(", ")} not set in .env (names only are shown; values are never printed).`);
    process.exit(2);
  }
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((resolve) => rl.question(q, resolve));
const confirm = async (q) => /^y(es)?$/i.test((await ask(`${q} [y/N] `)).trim());
const show = (label, obj) => console.log(`  ${label}:`, JSON.stringify(icici.redact(obj)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const money = (minor) => (minor / 100).toFixed(2);
const newOrder = () => ({ merchantTxnNo: `UAT${Date.now().toString(36).toUpperCase()}`, totalMinor: 1000, currency: "INR" });

async function statusOf(order) {
  const result = await icici.checkStatus(order);
  console.log(`  status of ${order.merchantTxnNo}: ${result.status}${result.failureReason ? ` (${result.failureReason})` : ""}`);
  show("bank answer", result.raw || {});
  return result;
}

// Starts a refund and follows it until the bank decides (or a few minutes pass): the same two steps the service takes.
async function refundAndFollow(order, amountMinor) {
  const refundId = require("crypto").randomUUID();
  console.log(`  refunding ${money(amountMinor)} of ${order.merchantTxnNo} ...`);
  let started;
  try {
    started = await icici.refund(order, amountMinor, refundId);
  } catch (err) {
    console.log(`  the bank DECLINED the refund: ${err.message}`);
    if (err.gatewayResponse) show("bank answer", err.gatewayResponse);
    return "declined";
  }
  console.log(`  request ${started.unconfirmed ? "got no answer (outcome unknown; the same reference is asked about below)" : `answered: ${started.status}`}; reference ${started.gatewayRef}${started.gatewayTxnId ? `, bank transaction ${started.gatewayTxnId}` : ""}`);
  if (started.raw) show("bank answer", started.raw);
  if (started.status === "succeeded") return "succeeded";
  for (let i = 1; i <= 12; i++) {
    await sleep(10000);
    const settled = await icici.settleRefund({ gateway_ref: started.gatewayRef });
    console.log(`  check ${i}: ${settled.status}${settled.reason ? ` (${settled.reason})` : ""}`);
    if (settled.status !== "processing") return settled.status;
  }
  console.log("  still processing after 2 minutes: ask again later with the 'status' command on the reference above.");
  return "processing";
}

async function guided() {
  console.log(`ICICI UAT guided check (merchant ${c.merchantId.slice(0, 3)}…, ${UAT_HOST}). Nothing is sent until you confirm.\n`);
  if (!(await confirm("1. Start a UAT payment of INR 10.00?"))) return;
  const paid = newOrder();
  const started = await icici.createPayment(paid, { returnUrl: `${config.publicBaseUrl}/billing/return?gw=icici`, customerEmail: "uat-test@example.com", customerName: "UAT Test", customerPhone: "" });
  console.log(`\n  Open this address, pay with an ICICI UAT test card, then come back here:\n  ${started.redirectUrl}\n`);
  await ask("  Press Enter after you have paid on the bank page... ");
  const sale = await statusOf(paid);
  if (sale.status !== "paid") { console.log("  The bank does not report this payment as paid, so nothing can be refunded. Stopping."); return; }

  if (await confirm("2. Refund a PART (INR 4.00) of that payment?")) await refundAndFollow(paid, 400);
  if (await confirm("3. Refund the REST (INR 6.00)?")) await refundAndFollow(paid, 600);
  if (await confirm("   Try to refund more than was paid (INR 1.00 extra)? The bank should decline it.")) await refundAndFollow(paid, 100);

  if (!(await confirm("4. Start a second payment but do NOT pay it, to try the cancel decision?"))) return;
  const unpaid = newOrder();
  const second = await icici.createPayment(unpaid, { returnUrl: `${config.publicBaseUrl}/billing/return?gw=icici`, customerEmail: "uat-test@example.com", customerName: "UAT Test", customerPhone: "" });
  console.log(`  (bank page, do not pay: ${second.redirectUrl})`);
  const pending = await statusOf(unpaid);
  console.log(pending.status === "paid"
    ? "  The bank says it is PAID: the service would record it as paid and refuse to cancel (refund instead)."
    : pending.status === "failed"
      ? "  The bank says it FAILED: the service would record it as failed."
      : "  The bank says it is NOT paid: the service would cancel the order. (ICICI has no cancel call in this API; the cancel is ours, after this check.)");
}

(async () => {
  refuseUnlessUat();
  const [cmd, txn, amount] = process.argv.slice(2);
  if (!cmd) await guided();
  else if (cmd === "status" && txn) await statusOf({ merchantTxnNo: txn, totalMinor: 0, currency: "INR" });
  else if (cmd === "refund" && txn && Number(amount) > 0) await refundAndFollow({ merchantTxnNo: txn, totalMinor: 0, currency: "INR" }, Math.round(Number(amount) * 100));
  else console.log("Usage: node scripts/icici_uat_refund_test.js [status <txn> | refund <txn> <amount>]");
  rl.close();
})().catch((err) => { console.error("Failed:", err.message); rl.close(); process.exit(1); });
