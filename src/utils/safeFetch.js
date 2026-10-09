// The only way the adapter makes outbound HTTP requests (H5). It protects against SSRF (a caller steering the server at internal
// addresses) and against oversized or never-ending answers:
//
//   * http(s) only; https only in production; no user:password@ in the address
//   * optional allow-list of host names (the video engine, ICICI)
//   * production: the address is checked before the request AND again at connection time, for the address actually used, so a
//     host name that switches to a private address between the two checks (DNS rebinding) is refused too
//   * redirects are followed by hand, at most `maxRedirects` (0 for fixed services), every hop is checked again, and the
//     Authorization header is dropped when a redirect leaves the original host
//   * a timeout, and a cap on the number of bytes read (Content-Length and the real stream)
//
// Outside production, private addresses are allowed so the adapter can talk to a local Magento and a local video engine.
const { Agent, fetch: undiciFetch } = require("undici");
const config = require("../config");
const { assertPublicHost, BlockedAddressError } = require("./netGuard");

// Production requests go through undici's own fetch so the connection-time address check (dispatcher) is used; outside production
// the built-in fetch is used. Tests may replace either with a stub.
let testFetch = null;
const setFetchForTests = (fn) => { testFetch = fn; };

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const NO_BODY = new Set([101, 204, 205, 304]);

class OutboundError extends Error {
  constructor(message, status = 502) { super(message); this.name = "OutboundError"; this.status = status; }
}

// Connection-time check: the address used to open the socket is the one that was just validated.
function guardedLookup(hostname, options, callback) {
  if (typeof options === "function") { callback = options; options = {}; }
  assertPublicHost(hostname).then((addresses) => {
    if (options && options.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  }, (err) => callback(err));
}
const publicAgent = new Agent({ connect: { lookup: guardedLookup, timeout: 10000 } });

function hostAllowed(host, allowHosts) {
  const h = host.toLowerCase();
  return allowHosts.some((entry) => {
    const e = String(entry).toLowerCase();
    return e.startsWith("*.") ? h.endsWith(e.slice(1)) : h === e;
  });
}

async function checkUrl(url, { allowHosts, requireHttps, enforcePublic }) {
  if (url.protocol !== "https:" && !(url.protocol === "http:" && !requireHttps)) {
    throw new OutboundError(`Only https addresses are allowed (${url.protocol.replace(":", "")} refused)`, 400);
  }
  if (url.username || url.password) throw new OutboundError("Addresses with a user name or password are not allowed", 400);
  if (allowHosts && allowHosts.length && !hostAllowed(url.hostname, allowHosts)) throw new OutboundError(`Host ${url.hostname} is not on the allow-list`, 400);
  if (enforcePublic) await assertPublicHost(url.hostname);
}

// Reads at most maxBytes: an oversized Content-Length is refused at once, a stream that grows past the limit is cut.
function limited(res, maxBytes) {
  if (!res.headers || typeof res.headers.get !== "function") return res; // not a real Response (a test double)
  const declared = Number(res.headers.get("content-length") || 0);
  if (declared > maxBytes) throw new OutboundError(`Response is larger than the allowed ${maxBytes} bytes`);
  if (!res.body || NO_BODY.has(res.status)) return res;
  let seen = 0;
  const counted = res.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > maxBytes) controller.error(new OutboundError(`Response is larger than the allowed ${maxBytes} bytes`));
      else controller.enqueue(chunk);
    },
  }));
  return new Response(counted, { status: res.status, statusText: res.statusText, headers: res.headers });
}

const stripCredentials = (headers) => {
  const copy = new Headers(headers || {});
  for (const name of ["authorization", "cookie", "proxy-authorization"]) copy.delete(name);
  return copy;
};

/**
 * safeFetch(url, init, policy) -> Response
 *   policy.allowHosts   host names that may be called ("api.example.com" or "*.example.com"); omitted = any public host
 *   policy.maxBytes     largest accepted response body (default 25 MB)
 *   policy.timeoutMs    whole-request timeout (default 30 s)
 *   policy.maxRedirects redirects followed (default 3; 0 = a redirect is an error, for fixed services)
 */
async function safeFetch(url, init = {}, policy = {}) {
  const { allowHosts, maxBytes = 25 * 1024 * 1024, timeoutMs = 30000, maxRedirects = 3 } = policy;
  const settings = { allowHosts, requireHttps: policy.requireHttps ?? config.isProduction, enforcePublic: policy.enforcePublic ?? config.isProduction };
  let current;
  try { current = new URL(url); } catch (err) { throw new OutboundError("Not a valid address", 400); }
  let requestInit = { ...init };
  const signal = init.signal || AbortSignal.timeout(timeoutMs);

  for (let hop = 0; ; hop++) {
    await checkUrl(current, settings);
    const res = settings.enforcePublic
      ? await (testFetch || undiciFetch)(current.href, { ...requestInit, redirect: "manual", signal, dispatcher: publicAgent })
      : await (testFetch || fetch)(current.href, { ...requestInit, redirect: "manual", signal });
    if (REDIRECTS.has(res.status) && res.headers && res.headers.get && res.headers.get("location")) {
      if (hop >= maxRedirects) throw new OutboundError(maxRedirects === 0 ? "Unexpected redirect from the service" : "Too many redirects");
      const method = String(requestInit.method || "GET").toUpperCase();
      if (method !== "GET" && method !== "HEAD") throw new OutboundError("Redirect on a request that changes data was refused");
      await res.arrayBuffer().catch(() => {});
      const next = new URL(res.headers.get("location"), current);
      // Credentials follow a redirect only within the same host and never onto plain http (an http -> https upgrade is fine).
      if (next.hostname !== current.hostname || (current.protocol === "https:" && next.protocol !== "https:")) requestInit = { ...requestInit, headers: stripCredentials(requestInit.headers) };
      current = next;
      continue;
    }
    return limited(res, maxBytes);
  }
}

// Host names of the configured fixed services (video engine, Flipick API) plus any OUTBOUND_ALLOWED_HOSTS, as an allow-list.
function configuredServiceHosts() {
  const urls = [config.flipick.baseUrl, config.flipick.videoEngineBaseUrl];
  const hosts = urls.filter(Boolean).map((u) => { try { return new URL(u).hostname; } catch (err) { return null; } }).filter(Boolean);
  const extra = String(process.env.OUTBOUND_ALLOWED_HOSTS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return [...new Set([...hosts, ...extra])];
}

module.exports = { safeFetch, setFetchForTests, configuredServiceHosts, OutboundError, BlockedAddressError, hostAllowed };
