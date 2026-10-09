// validate({ body, params, query }) -> middleware. A request that does not match the schemas is answered with 400 and a short
// list of what is wrong (field name and rule, never the submitted value) before any controller or database code runs.
// A valid body replaces req.body with the parsed data (trimmed to the declared fields).
const logger = require("../utils/logger");

function validate({ body, params, query } = {}) {
  return (req, res, next) => {
    const problems = [];
    const check = (schema, value, where) => {
      const result = schema.safeParse(value);
      if (result.success) return result.data;
      for (const issue of result.error.issues.slice(0, 6)) problems.push({ in: where, field: issue.path.join(".") || undefined, problem: issue.message });
      return undefined;
    };
    if (body) {
      const raw = req.body === undefined || req.body === null ? {} : req.body;
      const data = check(body, raw, "body");
      if (data !== undefined) req.body = data;
    }
    if (params) check(params, req.params, "path");
    if (query) check(query, req.query, "query");
    if (problems.length) {
      logger.warn(`Invalid request on ${req.method} ${req.path}`, { requestId: req.id, ip: req.ip, problems });
      return res.status(400).json({ error: "Invalid request", details: problems, requestId: req.id });
    }
    next();
  };
}

// Idempotency-Key must look like a key (so nothing odd is stored): 1-120 letters, digits, dot, colon, dash, underscore.
function idempotencyKeyShape(req, res, next) {
  const key = req.get("Idempotency-Key");
  if (key !== undefined && !/^[A-Za-z0-9._:-]{1,120}$/.test(key)) {
    return res.status(400).json({ error: "Invalid request", details: [{ in: "header", field: "Idempotency-Key", problem: "must be 1-120 letters, digits . : - _" }], requestId: req.id });
  }
  next();
}

// Per-route cap on the request body (the global parser allows 1 MB; most routes need a few hundred bytes).
function limitBody(maxBytes) {
  return (req, res, next) => {
    if (Buffer.byteLength(req.rawBody || "", "utf8") > maxBytes) {
      return res.status(413).json({ error: "Request body is too large", requestId: req.id });
    }
    next();
  };
}

module.exports = { validate, idempotencyKeyShape, limitBody };
