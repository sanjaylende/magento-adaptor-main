// Serves the single-page UI shell. It holds no data: boot.js exchanges the launch token for a session, then loads
// everything through /api/bootstrap.
const fs = require("fs");
const path = require("path");
const { query, asSystem } = require("../db/connection");

const template = fs.readFileSync(path.join(__dirname, "..", "..", "views", "index.html"), "utf8");

let originsCache = { at: 0, value: [] };

// The shell may only be framed by the Magento admins of registered installations.
async function frameAncestors() {
  if (Date.now() - originsCache.at > 60 * 1000) {
    const { rows } = await asSystem(() => query("SELECT base_url FROM installations WHERE status = 'active'"));
    originsCache = { at: Date.now(), value: [...new Set(rows.map((r) => { try { return new URL(r.base_url).origin; } catch { return null; } }).filter(Boolean))] };
  }
  return ["'self'", ...originsCache.value].join(" ");
}

async function index(req, res) {
  res.set("Content-Security-Policy", `frame-ancestors ${await frameAncestors()}`);
  res.set("Cache-Control", "no-store");
  res.send(template);
}

module.exports = { index };
