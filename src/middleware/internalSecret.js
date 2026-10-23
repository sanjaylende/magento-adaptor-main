// Server-to-server authentication for /internal/* routes (callers: LTX's backend, never a browser): the shared secret INTERNAL_API_SECRET
// in the X-Internal-Secret header, compared in constant time. Fails closed: when the secret is not configured, nobody gets in.
const config = require("../config");
const logger = require("../utils/logger");
const { safeEqual } = require("../utils/crypto");

function requireInternalSecret(req, res, next) {
  const expected = config.internalApiSecret;
  const provided = req.get("X-Internal-Secret") || "";
  if (!expected || !safeEqual(provided, expected)) {
    logger.warn(`Internal route refused: ${expected ? "wrong or missing secret" : "INTERNAL_API_SECRET is not configured"}`, { path: req.path, ip: req.ip, requestId: req.id });
    return res.status(401).json({ error: "Invalid internal secret" });
  }
  next();
}

module.exports = { requireInternalSecret };
