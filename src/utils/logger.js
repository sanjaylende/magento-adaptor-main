// Dependency-free structured logger: console + rotating files.
//   LOG_LEVEL           debug | info | warn | error     (default info; debug in development)
//   LOG_FORMAT          text | json                     (default text; use json in production so a log shipper can parse it)
//   LOG_TO_FILE         true | false                    (default true; off under NODE_ENV=test)
//   LOG_DIR             folder for the files            (default <project>/logs)
//   LOG_MAX_BYTES       size that triggers a rotation   (default 10485760 = 10 MB)
//   LOG_ROTATE_AT       daily rotation time HH:MM       (default 00:05, server local time)
//   LOG_RETENTION_DAYS  delete archives older than this (default 0 = keep everything)
//
// Files: app.log (every line) and error.log (warn and error only). Each is rotated at LOG_ROTATE_AT every day and whenever it
// passes LOG_MAX_BYTES; the old file is zipped (app-2026-10-08.zip, app-2026-10-08-153012.zip) and a new one is started.
// Usage: logger.info("message", { key: "value" })  -- a trailing plain object is treated as structured context.
// Secrets (keys, tokens, signatures, passwords) found in context objects are redacted before anything is written.
const path = require("path");
const { RotatingFile } = require("./logRotation");

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[String(process.env.LOG_LEVEL || (process.env.NODE_ENV === "production" ? "info" : "debug")).toLowerCase()] || LEVELS.info;
const asJson = String(process.env.LOG_FORMAT || "text").toLowerCase() === "json";
const SENSITIVE = /(secret|token|password|authorization|signature|api_?key|credential|consumer_?key)/i;

function redact(value, depth = 0) {
  if (value == null || depth > 4) return value;
  if (value instanceof Error) return { name: value.name, message: value.message, status: value.status, code: value.code, stack: value.stack };
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE.test(k) ? "[redacted]" : redact(v, depth + 1);
    return out;
  }
  // Credentials embedded in a URL query string must never reach a log.
  return typeof value === "string" ? value.replace(/(consumer_(?:key|secret)=)[^&\s]+/gi, "$1[redacted]") : value;
}

// ---- file sinks (created on first use; a failure to write a file never breaks the application)
let sinks = null;
let fileLoggingBroken = false;

function fileLoggingEnabled() {
  const flag = process.env.LOG_TO_FILE;
  if (flag != null && flag !== "") return !/^(0|false|no|off)$/i.test(flag);
  return process.env.NODE_ENV !== "test" && !process.env.NODE_TEST_CONTEXT; // the node test runner marks its child processes
}

function getSinks() {
  if (sinks || fileLoggingBroken || !fileLoggingEnabled()) return sinks;
  try {
    const options = {
      dir: process.env.LOG_DIR || path.join(__dirname, "..", "..", "logs"),
      maxBytes: Number(process.env.LOG_MAX_BYTES) || 10 * 1024 * 1024,
      rotateAt: process.env.LOG_ROTATE_AT || "00:05",
      retentionDays: Number(process.env.LOG_RETENTION_DAYS) || 0,
      onError: (err) => console.error(`${new Date().toISOString()} error: log rotation: ${err.message}`),
    };
    sinks = { all: new RotatingFile({ ...options, name: "app" }), errors: new RotatingFile({ ...options, name: "error" }) };
  } catch (err) {
    fileLoggingBroken = true;
    console.error(`${new Date().toISOString()} error: log files disabled, using the console only: ${err.message}`);
  }
  return sinks;
}

function toFile(level, line) {
  const s = getSinks();
  if (!s) return;
  try {
    s.all.write(`${line}\n`);
    if (LEVELS[level] >= LEVELS.warn) s.errors.write(`${line}\n`);
  } catch (err) {
    fileLoggingBroken = true;
    sinks = null;
    console.error(`${new Date().toISOString()} error: log files disabled after a write failure: ${err.message}`);
  }
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
  const line = asJson ? JSON.stringify({ time, level, message, ...(context ? { context } : {}) }) : `${time} ${level}: ${message}${context ? ` ${JSON.stringify(context)}` : ""}`;
  sink(line);
  toFile(level, line);
}

module.exports = {
  debug: (...args) => write("debug", args),
  info: (...args) => write("info", args),
  warn: (...args) => write("warn", args),
  error: (...args) => write("error", args),
  // for tests and shutdown: wait for pending zips / stop timers
  async flush() { if (sinks) await Promise.all([sinks.all.flush(), sinks.errors.flush()]); },
  close() { if (sinks) { sinks.all.close(); sinks.errors.close(); } },
};
