// Serves the single-page UI shell. It holds no data: boot.js exchanges the launch token for a session, then loads
// everything through /api/bootstrap.
const fs = require("fs");
const path = require("path");
const { query, asSystem } = require("../db/connection");
const logger = require("../utils/logger");

const template = fs.readFileSync(path.join(__dirname, "..", "..", "views", "index.html"), "utf8");

let originsCache = { at: 0, value: [] };

// The shell may only be framed by the Magento admins of registered installations.
async function frameAncestors() {
  if (Date.now() - originsCache.at > 60 * 1000) {
    const { rows } = await asSystem(() => query("SELECT base_url FROM installations WHERE status = 'active'"));
    originsCache = { at: Date.now(), value: [...new Set(rows.map((r) => { try { return new URL(r.base_url).origin; } catch (err) { logger.warn("Installation has an invalid base URL; it cannot frame the app", { baseUrl: r.base_url }); return null; } }).filter(Boolean))] };
  }
  return ["'self'", ...originsCache.value].join(" ");
}

async function index(req, res) {
  // Own scripts and styles only (the UI uses inline event handlers, hence 'unsafe-inline' for scripts); product images and
  // videos may come from the store or the video engine over http(s). Framed only by registered Magento admins.
  res.set("Content-Security-Policy", [
    "default-src 'self'", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https: http:", "media-src 'self' blob: https: http:", "font-src 'self' data:",
    "connect-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'",
    `frame-ancestors ${await frameAncestors()}`,
  ].join("; "));
  res.set("Cache-Control", "no-store");
  res.send(template);
}

module.exports = { index };
