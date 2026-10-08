// Authenticates a request and puts its tenant (installation + store + Magento connection) into the ambient context.
//
// Two ways in:
//   1. Signed server-to-server request from the Magento extension (PHP):
//        X-Flipick-Key        install key
//        X-Flipick-Timestamp  unix seconds, accepted within +-5 minutes
//        X-Flipick-Nonce      random, single use
//        X-Flipick-Signature  hex HMAC-SHA256(secret, `${ts}\n${nonce}\n${METHOD}\n${originalUrl}\n${sha256(rawBody)}`)
//        X-Flipick-Website    Magento website id the call is for
//   2. Browser session: "Authorization: Bearer <session token>" obtained from POST /api/session with a launch token that
//      the extension signed (see sessionController).
const { runWithTenant } = require("../context");
const tenants = require("../services/tenantService");
const { hmacHex, sha256Hex, safeEqual, verifyToken } = require("../utils/crypto");
const { query, asSystem } = require("../db/connection");

const MAX_SKEW_SECONDS = 300;

const logger = require("../utils/logger");

// Every refusal is logged with the reason and caller address (never the signature, secret or token) to spot probing.
const fail = (res, status, message, req) => {
  logger.warn(`Auth refused: ${message}`, { status, ip: req && req.ip, path: req && req.path, requestId: req && req.id, installKey: req && req.get && req.get("X-Flipick-Key") });
  return res.status(status).json({ error: message });
};

async function fromSignature(req) {
  const key = req.get("X-Flipick-Key");
  const ts = Number(req.get("X-Flipick-Timestamp"));
  const nonce = req.get("X-Flipick-Nonce");
  const signature = req.get("X-Flipick-Signature");
  if (!key || !ts || !nonce || !signature) return { status: 401, message: "Missing authentication headers" };
  if (Math.abs(Date.now() / 1000 - ts) > MAX_SKEW_SECONDS) return { status: 401, message: "Request timestamp is outside the allowed window" };

  const installation = await tenants.getInstallationByKey(key);
  if (!installation) return { status: 401, message: "Unknown install key" };
  const expected = hmacHex(installation.secret, `${ts}\n${nonce}\n${req.method}\n${req.originalUrl}\n${sha256Hex(req.rawBody || "")}`);
  if (!safeEqual(signature, expected)) return { status: 401, message: "Invalid signature" };
  if (installation.status !== "active") return { status: 403, message: `Installation is ${installation.status}` };

  // Single-use nonce: a replayed request fails here even with a valid signature.
  const inserted = await asSystem(() => query(
    "INSERT INTO request_nonces (installation_id, nonce, expires_at) VALUES ($1, $2, now() + interval '10 minutes') ON CONFLICT DO NOTHING",
    [installation.id, nonce]
  ));
  if (!inserted.rowCount) return { status: 401, message: "Request was already used" };
  return { installation, websiteId: req.get("X-Flipick-Website") };
}

async function fromSession(req) {
  const token = (req.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const claims = verifyToken(token);
  if (!claims || claims.typ !== "session") return { status: 401, message: "Session expired. Reopen Video Generator from the Magento admin." };
  const installation = await tenants.getInstallation(claims.inst);
  if (!installation || installation.status !== "active") return { status: 403, message: "Installation is not active" };
  return { installation, websiteId: claims.web };
}

// Resolves { installation, store } for the request, or answers with an error.
function tenantAuth({ requireStore = true } = {}) {
  return async (req, res, next) => {
    try {
      const bearer = /^Bearer\s+/i.test(req.get("Authorization") || "");
      const result = await (bearer ? fromSession(req) : fromSignature(req));
      if (result.status) return fail(res, result.status, result.message, req);
      const { installation, websiteId } = result;
      req.installation = installation;
      req.authKind = bearer ? "session" : "signature";
      if (!requireStore) return next();

      const store = websiteId != null ? await tenants.getStore(installation.id, websiteId) : null;
      if (!store || store.status !== "active") return fail(res, 404, "Unknown store for this installation", req);
      req.store = store;
      const magento = await tenants.magentoConfigFor(installation, store);
      req.tenant = { installation, store, magento };
      runWithTenant(req.tenant, () => next());
    } catch (err) {
      next(err);
    }
  };
}

module.exports = tenantAuth;
