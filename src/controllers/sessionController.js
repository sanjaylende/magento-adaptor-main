// Browser sessions for the embedded UI. The Magento extension (server side) signs a short-lived "launch token" with the
// installation secret and puts it in the iframe URL; this endpoint verifies it once and returns a session token the page
// sends as "Authorization: Bearer" on every call.
//
//   launch token = base64url(JSON { k: installKey, w: websiteId, e: expiresUnix, n: nonce }) + "." + hex HMAC-SHA256(secret, thatBase64)
const tenants = require("../services/tenantService");
const { hmacHex, safeEqual, signToken } = require("../utils/crypto");
const { query, asSystem } = require("../db/connection");

const SESSION_SECONDS = 8 * 3600;

async function exchange(req, res) {
  const launch = String((req.body || {}).launch || "");
  const [body, sig] = launch.split(".");
  let claims;
  try {
    claims = JSON.parse(Buffer.from(body || "", "base64url").toString("utf8"));
  } catch {
    return res.status(401).json({ error: "Invalid launch token" });
  }
  const installation = claims.k ? await tenants.getInstallationByKey(claims.k) : null;
  if (!installation || !sig || !safeEqual(sig, hmacHex(installation.secret, body))) return res.status(401).json({ error: "Invalid launch token" });
  if (installation.status !== "active") return res.status(403).json({ error: `Installation is ${installation.status}` });
  if (!claims.e || claims.e < Math.floor(Date.now() / 1000)) return res.status(401).json({ error: "Launch link expired. Reopen Video Generator from the Magento admin." });

  const fresh = await asSystem(() => query(
    "INSERT INTO request_nonces (installation_id, nonce, expires_at) VALUES ($1, $2, now() + interval '15 minutes') ON CONFLICT DO NOTHING",
    [installation.id, `launch:${claims.n}`]
  ));
  if (!fresh.rowCount) return res.status(401).json({ error: "Launch link was already used. Reopen Video Generator from the Magento admin." });

  const store = await tenants.getStore(installation.id, claims.w);
  if (!store || store.status !== "active") return res.status(404).json({ error: "Unknown store for this installation" });
  await tenants.touchInstallation(installation.id);
  res.json({ token: signToken({ typ: "session", inst: installation.id, web: store.externalId }, SESSION_SECONDS), expiresIn: SESSION_SECONDS, store: { name: store.name, code: store.code } });
}

module.exports = { exchange };
