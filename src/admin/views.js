// Layout and small components for the staff console (server-rendered, no client framework).
const { escapeHtml: e, money } = require("../utils/html");

const STYLE = `
  :root { --bg:#f6f7f9; --card:#fff; --fg:#16202c; --muted:#5a6877; --line:#dde2e8; --accent:#534ab7; --ok:#1d6b3a; --okbg:#e1f2e6; --bad:#a3262a; --badbg:#fbe5e5; --warn:#8a5a00; --warnbg:#fbf0d9; --head:#eef1f4; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0f151c; --card:#17202a; --fg:#e6ebf0; --muted:#9aa8b6; --line:#2a3643; --accent:#8d85f0; --ok:#6fd18f; --okbg:#163322; --bad:#ff8f92; --badbg:#3a1b1d; --warn:#f0b94d; --warnbg:#33290f; --head:#1d2833; } }
  * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; }
  header { background:var(--card); border-bottom:1px solid var(--line); padding:0 20px; display:flex; align-items:center; gap:24px; flex-wrap:wrap; }
  header b { padding:14px 0; } nav a { color:var(--muted); text-decoration:none; padding:14px 4px; display:inline-block; margin-right:12px; } nav a.on, nav a:hover { color:var(--accent); }
  header .who { margin-left:auto; color:var(--muted); font-size:13px; } main { max-width:1200px; margin:0 auto; padding:24px 16px 64px; }
  h1 { font-size:22px; margin:0 0 16px; } h2 { font-size:16px; margin:28px 0 10px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:12px; margin-bottom:8px; }
  .stat { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:14px 16px; } .stat b { display:block; font-size:22px; font-variant-numeric:tabular-nums; } .stat span { color:var(--muted); font-size:12px; }
  .wrap { overflow-x:auto; background:var(--card); border:1px solid var(--line); border-radius:8px; } table { width:100%; border-collapse:collapse; }
  th,td { text-align:left; padding:9px 12px; border-bottom:1px solid var(--line); vertical-align:top; } th { background:var(--head); font-size:11.5px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); white-space:nowrap; }
  tr:last-child td { border-bottom:0; } td.n, th.n { text-align:right; font-variant-numeric:tabular-nums; }
  a { color:var(--accent); } .tag { display:inline-block; padding:1px 8px; border-radius:999px; font-size:12px; background:var(--head); }
  .tag.ok { background:var(--okbg); color:var(--ok); } .tag.bad { background:var(--badbg); color:var(--bad); } .tag.warn { background:var(--warnbg); color:var(--warn); }
  form.inline { display:flex; gap:8px; flex-wrap:wrap; align-items:end; background:var(--card); border:1px solid var(--line); border-radius:8px; padding:12px; margin:8px 0; }
  label { display:flex; flex-direction:column; gap:3px; font-size:12px; color:var(--muted); } input, select { font:inherit; padding:7px 9px; border:1px solid var(--line); border-radius:6px; background:var(--bg); color:var(--fg); min-width:0; }
  button { font:inherit; padding:8px 14px; border-radius:6px; border:1px solid var(--accent); background:var(--accent); color:#fff; cursor:pointer; } button.sec { background:transparent; color:var(--accent); }
  .msg { padding:10px 14px; border-radius:6px; margin-bottom:16px; } .msg.ok { background:var(--okbg); color:var(--ok); } .msg.bad { background:var(--badbg); color:var(--bad); }
  .muted { color:var(--muted); } .kv { display:grid; grid-template-columns:160px 1fr; gap:4px 12px; background:var(--card); border:1px solid var(--line); border-radius:8px; padding:12px 16px; } .kv div:nth-child(odd) { color:var(--muted); }
  @media (max-width:640px) { .kv { grid-template-columns:1fr; } }
`;

function layout({ title, user, active, body, flash }) {
  const links = [["/admin", "Overview"], ["/admin/merchants", "Merchants"], ["/admin/stores", "Stores"], ["/admin/payments", "Payments"], ["/admin/refunds", "Refunds"], ["/admin/plans", "Plans"], ["/admin/audit", "Audit log"]];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${e(title)} · Flipick admin</title><style>${STYLE}</style></head><body>
<header><b>Flipick Video Admin</b><nav>${links.map(([href, label]) => `<a href="${href}" class="${active === href ? "on" : ""}">${label}</a>`).join("")}</nav>
<span class="who">${e(user.email)} (${e(user.role)}) · <a href="/admin/logout">Sign out</a></span></header>
<main>${flash ? `<div class="msg ${flash.kind}">${e(flash.text)}</div>` : ""}${body}</main></body></html>`;
}

// Same sign-in screen as the Shopify adapter's /admin/login; only the name differs.
const LOGIN_STYLE = `
  * { box-sizing: border-box; }
  body { margin: 0; background: #f9f9f7; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; color: #0b0b0b;
         min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
  .card { width: 100%; max-width: 380px; background: #fcfcfb; border: 1px solid #e1e0d9; border-radius: 12px; padding: 36px 32px; }
  h1 { margin: 0 0 6px; font-size: 19px; font-weight: 700; }
  p.sub { margin: 0 0 24px; font-size: 13.5px; color: #52514e; line-height: 1.5; }
  label { display: flex; flex-direction: column; gap: 6px; font-size: 13px; font-weight: 600; color: #52514e; margin-bottom: 14px; }
  input { font-size: 14px; padding: 10px 12px; border: 1px solid #c3c2b7; border-radius: 7px; font-family: inherit; }
  input:focus { outline: 2px solid #2a78d6; outline-offset: 1px; }
  button { width: 100%; margin-top: 6px; font-size: 14px; font-weight: 700; color: #fcfcfb; background: #2a78d6;
           border: none; padding: 11px 16px; border-radius: 7px; cursor: pointer; }
  button:hover { background: #184f95; }
  .error { font-size: 13px; color: #d03b3b; background: #fbeaea; border: 1px solid #f0c9c9; padding: 9px 12px; border-radius: 7px; margin-bottom: 14px; }
  .foot { margin: 22px 0 0; font-size: 12px; color: #898781; line-height: 1.5; }
`;

function loginPage(error) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Magento Adaptor · Admin</title><style>${LOGIN_STYLE}</style></head><body>
  <div class="card">
    <h1>Magento Adaptor · Admin</h1>
    <p class="sub">Sign in with your LTX account. Access is limited to Flipick superadmins and this deployment's own tenant admins.</p>
    ${error ? `<div class="error">${e(error)}</div>` : ""}
    <form method="post" action="/admin/login">
      <label>Email<input type="email" name="email" autocomplete="username" required autofocus></label>
      <label>Password<input type="password" name="password" autocomplete="current-password" required></label>
      <button type="submit">Log in</button>
    </form>
    <p class="foot">This forwards your credentials to LTX's own sign-in -- no separate password is stored here.</p>
  </div>
</body></html>`;
}

const table = (head, rows, empty = "Nothing to show") =>
  `<div class="wrap"><table><thead><tr>${head.map((h) => `<th class="${h.n ? "n" : ""}">${e(h.label || h)}</th>`).join("")}</tr></thead><tbody>${
    rows.length ? rows.map((r) => `<tr>${r.map((c, i) => `<td class="${head[i] && head[i].n ? "n" : ""}">${c}</td>`).join("")}</tr>`).join("") : `<tr><td colspan="${head.length}" class="muted">${e(empty)}</td></tr>`
  }</tbody></table></div>`;

const statusTag = (s) => `<span class="tag ${["paid", "succeeded", "active"].includes(s) ? "ok" : ["failed", "expired", "canceled", "refunded"].includes(s) ? "bad" : ["pending", "grace", "partially_refunded", "requested", "processing", "created"].includes(s) ? "warn" : ""}">${e(s)}</span>`;
const date = (d) => (d ? e(new Date(d).toISOString().replace("T", " ").slice(0, 16)) : "—");

module.exports = { layout, loginPage, table, statusTag, date, e, money };
