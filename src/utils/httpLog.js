// fetch() with a timeout and one log line per call (method, host + path, status, duration; never the query string or headers).
// A network failure or timeout is logged and rethrown with a message that says which service was being called.
const logger = require("./logger");

async function loggedFetch(service, url, options = {}) {
  const { timeoutMs = 60000, ...init } = options;
  const target = new URL(url);
  const label = `${service} ${(init.method || "GET").toUpperCase()} ${target.host}${target.pathname}`;
  const startedAt = Date.now();
  try {
    const res = await fetch(url, { ...init, signal: init.signal || AbortSignal.timeout(timeoutMs) });
    const ms = Date.now() - startedAt;
    if (res.status >= 500) logger.error(`${label} -> ${res.status}`, { ms });
    else if (res.status >= 400) logger.warn(`${label} -> ${res.status}`, { ms });
    else logger.debug(`${label} -> ${res.status}`, { ms });
    return res;
  } catch (err) {
    const timedOut = err && (err.name === "TimeoutError" || err.name === "AbortError");
    logger.error(`${label} ${timedOut ? "timed out" : "failed"}`, { ms: Date.now() - startedAt, error: err.message });
    throw Object.assign(new Error(`${service} request ${timedOut ? "timed out" : "failed"}: ${err.cause?.message || err.message}`), { status: 502, cause: err });
  }
}

module.exports = { loggedFetch };
