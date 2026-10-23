// Serves the single-page UI shell. It holds no data: boot.js exchanges the launch token for a session, then loads
// everything through /api/bootstrap.
const fs = require("fs");
const path = require("path");
const { query, asSystem } = require("../db/connection");
const logger = require("../utils/logger");
const config = require("../config");
const tenants = require("../services/tenantService");
const { hmacHex, safeEqual } = require("../utils/crypto");

const template = fs.readFileSync(path.join(__dirname, "..", "..", "views", "index.html"), "utf8");

let originsCache = { at: 0, value: [] };

// The store that is opening the page right now: its signed launch link (made by the extension with the installation secret) names it. It may
// frame the page at once, even if the cached list below was read before the store connected: a store that has just been connected is
// sent straight back to its admin page, which frames this one, and must not have to wait for the cache to expire. The link is
// verified here (signature and expiry) but not used up: the session exchange still consumes it.
async function originOfLaunchingStore(launch) {
  try {
    const [body, sig] = String(launch || "").split(".");
    if (!body || !sig) return null;
    const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!claims.k || !claims.e || claims.e < Math.floor(Date.now() / 1000)) return null;
    const installation = await tenants.getInstallationByKey(claims.k);
    if (!installation || installation.status !== "active" || !safeEqual(sig, hmacHex(installation.secret, body))) return null;
    return new URL(installation.baseUrl).origin;
  } catch {
    return null; // anything odd in the link: the page is simply served with the cached list
  }
}

// The shell may only be framed by the Magento admins of registered installations.
async function frameAncestors(launch) {
  if (Date.now() - originsCache.at > 60 * 1000) {
    const { rows } = await asSystem(() => query("SELECT base_url FROM installations WHERE status = 'active'"));
    originsCache = { at: Date.now(), value: [...new Set(rows.map((r) => { try { return new URL(r.base_url).origin; } catch (err) { logger.warn("Installation has an invalid base URL; it cannot frame the app", { baseUrl: r.base_url }); return null; } }).filter(Boolean))] };
  }
  const origins = ["'self'", ...originsCache.value];
  const own = await originOfLaunchingStore(launch);
  if (own && !origins.includes(own)) origins.push(own);
  return origins.join(" ");
}

async function index(req, res) {
  // Own scripts and styles only (the UI uses inline event handlers, hence 'unsafe-inline' for scripts); product images and
  // videos may come from the store or the video engine over http(s). Framed only by registered Magento admins.
  res.set("Content-Security-Policy", [
    "default-src 'self'", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline'",
    // Plain-http photos and videos are allowed only while developing against a local store; production is https only.
    `img-src 'self' data: blob: https:${config.isProduction ? "" : " http:"}`, `media-src 'self' blob: https:${config.isProduction ? "" : " http:"}`, "font-src 'self' data:",
    "connect-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'",
    `frame-ancestors ${await frameAncestors(req.query.launch)}`,
  ].join("; "));
  res.set("Cache-Control", "no-store");
  res.send(template);
}

module.exports = { index };
