// Fixed-window rate limiter backed by Postgres, so the limit holds across several adapter processes.
// Counted per installation and per store; expensive routes get a smaller budget under their own bucket name.
const { query, asSystem } = require("../db/connection");
const logger = require("../utils/logger");

const WINDOW_SECONDS = 60;
// Load tests multiply every budget so the handlers, not the limiter, are what gets measured. Ignored in production, so the real limits cannot be loosened.
const SCALE = process.env.NODE_ENV !== "production" && Number(process.env.RATE_LIMIT_SCALE) > 0 ? Number(process.env.RATE_LIMIT_SCALE) : 1;

// bucketKey(req) -> string identifying who is being limited; limit = requests per window.
function rateLimit({ name, limit: baseLimit, key }) {
  const limit = baseLimit * SCALE;
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

// Several budgets of one request (the installation's and the store's) counted in ONE statement: one round trip instead of one per budget.
// The buckets are written in a fixed order so two requests can never wait on each other's rows. The headers describe the LAST budget
// listed (the store's), and the first budget that is over its limit answers 429, as when they were separate middleware.
function rateLimitAll(budgets) {
  return async (req, res, next) => {
    try {
      const active = budgets.map((b) => ({ ...b, who: b.key(req), limit: b.limit * SCALE })).filter((b) => b.who);
      if (!active.length) return next();
      const windowStart = new Date(Math.floor(Date.now() / 1000 / WINDOW_SECONDS) * WINDOW_SECONDS * 1000);
      const buckets = active.map((b) => `${b.name}:${b.who}`);
      const order = [...buckets].sort();
      const { rows } = await asSystem(() => query(
        `INSERT INTO rate_limits (bucket, window_start, hits) VALUES ${order.map((_, i) => `($${i + 2}, $1, 1)`).join(", ")}
         ON CONFLICT (bucket, window_start) DO UPDATE SET hits = rate_limits.hits + 1 RETURNING bucket, hits`,
        [windowStart, ...order]
      ));
      const hits = Object.fromEntries(rows.map((r) => [r.bucket, r.hits]));
      const last = active[active.length - 1];
      res.set("X-RateLimit-Limit", String(last.limit));
      res.set("X-RateLimit-Remaining", String(Math.max(0, last.limit - hits[`${last.name}:${last.who}`])));
      const over = active.find((b) => hits[`${b.name}:${b.who}`] > b.limit);
      if (over) {
        const bucket = `${over.name}:${over.who}`;
        const retry = Math.ceil((windowStart.getTime() + WINDOW_SECONDS * 1000 - Date.now()) / 1000);
        res.set("Retry-After", String(Math.max(1, retry)));
        if (hits[bucket] === over.limit + 1) logger.warn("Rate limit reached", { bucket, limit: over.limit, path: req.path, requestId: req.id });
        return res.status(429).json({ error: "Too many requests. Try again shortly.", retryAfterSeconds: retry });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
const perTenant = (installationLimit, storeName, storeLimit) => rateLimitAll([
  { name: "inst", limit: installationLimit, key: (req) => req.installation && req.installation.id },
  { name: storeName, limit: storeLimit, key: (req) => req.store && req.store.id },
]);

const perInstallation = (limit) => rateLimit({ name: "inst", limit, key: (req) => req.installation && req.installation.id });
const perStore = (name, limit) => rateLimit({ name, limit, key: (req) => req.store && req.store.id });
const perIp = (name, limit) => rateLimit({ name, limit, key: (req) => req.ip });

module.exports = { rateLimit, perTenant, perInstallation, perStore, perIp };
