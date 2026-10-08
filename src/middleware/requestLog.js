// Request logging + correlation id. Every response carries X-Request-Id (reusing the caller's when it sends one), and one
// line is written when the response finishes: method, path (no query string: it may hold tokens), status, duration.
// 5xx -> error, 4xx -> warn, everything else -> debug (quiet in production at LOG_LEVEL=info).
const crypto = require("crypto");
const logger = require("../utils/logger");

const SKIP = /^\/(static|favicon)/;

module.exports = function requestLog(req, res, next) {
  const incoming = String(req.get("X-Request-Id") || "");
  req.id = /^[\w.-]{8,64}$/.test(incoming) ? incoming : crypto.randomUUID();
  res.set("X-Request-Id", req.id);
  if (SKIP.test(req.path)) return next();
  const startedAt = process.hrtime.bigint();
  res.on("finish", () => {
    const ms = Number((process.hrtime.bigint() - startedAt) / 1000000n);
    const line = `${req.method} ${req.path} -> ${res.statusCode}`;
    const context = { requestId: req.id, ms, ip: req.ip, ...(req.installation ? { installationId: req.installation.id } : {}), ...(req.store ? { storeId: req.store.id } : {}) };
    if (res.statusCode >= 500) logger.error(line, context);
    else if (res.statusCode >= 400) logger.warn(line, context);
    else logger.debug(line, context);
  });
  next();
};
