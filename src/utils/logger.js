// Dependency-free structured logger.
//   LOG_LEVEL   debug | info | warn | error   (default info; debug in development)
//   LOG_FORMAT  text | json                   (default text; use json in production so a log shipper can parse it)
// Usage: logger.info("message", { key: "value" })  -- a trailing plain object is treated as structured context.
// Secrets (keys, tokens, signatures, passwords) found in context objects are redacted before anything is written.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[String(process.env.LOG_LEVEL || (process.env.NODE_ENV === "production" ? "info" : "debug")).toLowerCase()] || LEVELS.info;
const asJson = String(process.env.LOG_FORMAT || "text").toLowerCase() === "json";
const SENSITIVE = /(secret|token|password|authorization|signature|api_?key|credential)/i;

function redact(value, depth = 0) {
  if (value == null || depth > 4) return value;
  if (value instanceof Error) return { name: value.name, message: value.message, status: value.status, code: value.code, stack: value.stack };
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE.test(k) ? "[redacted]" : redact(v, depth + 1);
    return out;
  }
  return typeof value === "string" ? value.replace(/(consumer_(?:key|secret)=)[^&\s]+/gi, "$1[redacted]") : value;
}

function write(level, args) {
  if (LEVELS[level] < threshold) return;
  const last = args[args.length - 1];
  const hasContext = args.length > 1 && last && typeof last === "object" && !(last instanceof Error) && !Array.isArray(last);
  const context = hasContext ? redact(last) : undefined;
  const parts = (hasContext ? args.slice(0, -1) : args).map((a) => (a instanceof Error ? a.stack || a.message : typeof a === "object" ? JSON.stringify(redact(a)) : String(a)));
  const message = parts.join(" ").replace(/(consumer_(?:key|secret)=)[^&\s]+/gi, "$1[redacted]");
  const time = new Date().toISOString();
  const sink = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  sink(asJson ? JSON.stringify({ time, level, message, ...(context ? { context } : {}) }) : `${time} ${level}: ${message}${context ? ` ${JSON.stringify(context)}` : ""}`);
}

module.exports = {
  debug: (...args) => write("debug", args),
  info: (...args) => write("info", args),
  warn: (...args) => write("warn", args),
  error: (...args) => write("error", args),
};
