// Fixed-window rate limiter backed by Postgres, so the limit holds across several adapter processes.
// Counted per installation and per store; expensive routes get a smaller budget under their own bucket name.
const { query, asSystem } = require("../db/connection");
const logger = require("../utils/logger");

const WINDOW_SECONDS = 60;

// bucketKey(req) -> string identifying who is being limited; limit = requests per window.
function rateLimit({ name, limit, key }) {
  return async (req, res, next) => {
    try {
      const who = key(req);
      if (!who) return next();
      const windowStart = new Date(Math.floor(Date.now() / 1000 / WINDOW_SECONDS) * WINDOW_SECONDS * 1000);
      const { rows: [row] } = await asSystem(() => query(
        `INSERT INTO rate_limits (bucket, window_start, hits) VALUES ($1, $2, 1)
         ON CONFLICT (bucket, window_start) DO UPDATE SET hits = rate_limits.hits + 1 RETURNING hits`,
        [`${name}:${who}`, windowStart]
      ));
      res.set("X-RateLimit-Limit", String(limit));
      res.set("X-RateLimit-Remaining", String(Math.max(0, limit - row.hits)));
      if (row.hits > limit) {
        const retry = Math.ceil((windowStart.getTime() + WINDOW_SECONDS * 1000 - Date.now()) / 1000);
        res.set("Retry-After", String(Math.max(1, retry)));
        if (row.hits === limit + 1) logger.warn("Rate limit reached", { bucket: `${name}:${who}`, limit, path: req.path, requestId: req.id });
        return res.status(429).json({ error: "Too many requests. Try again shortly.", retryAfterSeconds: retry });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

const perInstallation = (limit) => rateLimit({ name: "inst", limit, key: (req) => req.installation && req.installation.id });
const perStore = (name, limit) => rateLimit({ name, limit, key: (req) => req.store && req.store.id });
const perIp = (name, limit) => rateLimit({ name, limit, key: (req) => req.ip });

module.exports = { rateLimit, perInstallation, perStore, perIp };
