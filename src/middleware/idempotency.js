// Idempotency-Key support for POSTs that create work or move money. The first request with a key runs normally and its
// response is stored; a repeat with the same key and body replays that response; a repeat with a different body is
// rejected; a repeat while the first is still running gets 409.
const { query, asSystem } = require("../db/connection");
const { sha256Hex } = require("../utils/crypto");

function idempotent() {
  return async (req, res, next) => {
    const idemKey = req.get("Idempotency-Key");
    if (!idemKey || !req.installation) return next();
    try {
      const hash = sha256Hex(`${req.method} ${req.originalUrl}\n${req.rawBody || ""}`);
      const inserted = await asSystem(() => query(
        "INSERT INTO idempotency_keys (installation_id, idem_key, request_hash) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
        [req.installation.id, idemKey, hash]
      ));
      if (!inserted.rowCount) {
        const { rows: [prior] } = await asSystem(() => query("SELECT * FROM idempotency_keys WHERE installation_id = $1 AND idem_key = $2", [req.installation.id, idemKey]));
        if (prior.request_hash !== hash) return res.status(422).json({ error: "Idempotency-Key was already used with a different request" });
        if (prior.status_code == null) return res.status(409).json({ error: "A request with this Idempotency-Key is still being processed" });
        res.set("Idempotent-Replay", "true");
        return res.status(prior.status_code).json(prior.response_body);
      }
      const originalJson = res.json.bind(res);
      res.json = (body) => {
        asSystem(() => query("UPDATE idempotency_keys SET status_code = $3, response_body = $4 WHERE installation_id = $1 AND idem_key = $2", [req.installation.id, idemKey, res.statusCode, JSON.stringify(body)]))
          .catch(() => {});
        return originalJson(body);
      };
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = idempotent;
