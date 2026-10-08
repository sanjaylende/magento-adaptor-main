// Printable invoice / credit note page, opened from a short-lived signed link.
const config = require("../config");
const logger = require("../utils/logger");
const { verifyToken } = require("../utils/crypto");
const { query, asSystem } = require("../db/connection");
const { escapeHtml, money } = require("../utils/html");

function renderInvoice(inv) {
  const buyer = inv.buyer || {};
  const isNote = inv.kind === "credit_note";
  const tax = inv.tax_rate_bp ? `${inv.tax_rate_bp / 100}% GST` : "No tax";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(inv.number)}</title>
<style>
  body { font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; color:#16202c; background:#fff; margin:0; padding:32px 16px; }
  .sheet { max-width:720px; margin:0 auto; } h1 { font-size:22px; margin:0 0 4px; } .muted { color:#5a6877; }
  .head { display:flex; justify-content:space-between; gap:24px; flex-wrap:wrap; margin-bottom:28px; }
  table { width:100%; border-collapse:collapse; margin-top:20px; } th, td { text-align:left; padding:10px 8px; border-bottom:1px solid #dde2e8; }
  th:last-child, td:last-child { text-align:right; } .total td { font-weight:700; border-bottom:0; }
</style></head><body><div class="sheet">
  <div class="head">
    <div><h1>${isNote ? "Credit note" : "Tax invoice"}</h1><div class="muted">${escapeHtml(inv.number)}<br>Issued ${new Date(inv.issued_at).toISOString().slice(0, 10)}</div></div>
    <div><b>${escapeHtml(config.billing.sellerName)}</b><br><span class="muted">${escapeHtml(config.billing.sellerAddress)}${config.billing.sellerGstNumber ? `<br>GSTIN ${escapeHtml(config.billing.sellerGstNumber)}` : ""}</span></div>
  </div>
  <div><b>Billed to</b><br>${escapeHtml(buyer.name)}${buyer.address ? `<br>${escapeHtml(buyer.address)}` : ""}${buyer.gst ? `<br>GSTIN ${escapeHtml(buyer.gst)}` : ""}${buyer.email ? `<br>${escapeHtml(buyer.email)}` : ""}</div>
  <table>
    <tr><th>Description</th><th>Amount</th></tr>
    <tr><td>${escapeHtml(inv.description)}</td><td>${money(inv.subtotal_minor, inv.currency.trim())}</td></tr>
    <tr><td>${escapeHtml(tax)}</td><td>${money(inv.tax_minor, inv.currency.trim())}</td></tr>
    <tr class="total"><td>Total (${escapeHtml(inv.currency.trim())})</td><td>${money(inv.total_minor, inv.currency.trim())}</td></tr>
  </table>
  <p class="muted">Payment reference: ${escapeHtml(inv.order_id)}</p>
</div></body></html>`;
}

async function show(req, res) {
  try {
    const claims = verifyToken(req.params.token);
    if (!claims || claims.typ !== "inv") return res.status(401).send("This invoice link has expired. Open it again from Plans & Billing.");
    const { rows: [inv] } = await asSystem(() => query("SELECT * FROM invoices WHERE id = $1", [claims.id]));
    if (!inv) return res.status(404).send("Invoice not found");
    res.send(renderInvoice(inv));
  } catch (err) {
    logger.error("Could not render an invoice", { requestId: req.id, error: err });
    res.status(500).send("This invoice could not be shown right now. Please try again.");
  }
}

module.exports = { show, renderInvoice };
