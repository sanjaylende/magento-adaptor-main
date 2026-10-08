// Tiny server-side HTML helpers for the few pages this service renders itself (payment return, mock gateway, invoices).
const escapeHtml = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const CURRENCY_SYMBOL = { USD: "$", INR: "₹" };
const money = (minor, currency) => `${CURRENCY_SYMBOL[currency] || currency + " "}${(minor / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Plain centered card page.
function page(title, body, { script = "" } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { --bg:#f6f7f9; --card:#fff; --fg:#16202c; --muted:#5a6877; --line:#dde2e8; --accent:#534ab7; --ok:#1d6b3a; --bad:#a3262a; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0f151c; --card:#17202a; --fg:#e6ebf0; --muted:#9aa8b6; --line:#2a3643; --accent:#8d85f0; --ok:#6fd18f; --bad:#ff8f92; } }
  body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif; display:flex; justify-content:center; padding:32px 16px; }
  main { width:100%; max-width:560px; background:var(--card); border:1px solid var(--line); border-radius:12px; padding:28px; }
  h1 { font-size:20px; margin:0 0 10px; } p { margin:0 0 12px; color:var(--muted); }
  .ok { color:var(--ok); } .bad { color:var(--bad); }
  table { width:100%; border-collapse:collapse; margin:12px 0; } td { padding:6px 0; border-bottom:1px solid var(--line); } td:last-child { text-align:right; }
  button { font:inherit; padding:9px 16px; border-radius:8px; border:1px solid var(--line); background:var(--card); color:var(--fg); cursor:pointer; }
  button.primary { background:var(--accent); border-color:var(--accent); color:#fff; } form { display:inline; }
  .row { display:flex; gap:8px; flex-wrap:wrap; margin-top:16px; }
</style></head><body><main>${body}</main>${script ? `<script>${script}</script>` : ""}</body></html>`;
}

module.exports = { escapeHtml, money, page };
