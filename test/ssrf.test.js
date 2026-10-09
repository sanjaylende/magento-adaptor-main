// Outbound request protection (H5): private and loopback addresses, DNS rebinding, redirects, size caps, timeouts, allow-lists.
// No database needed. A local server stands in for "the internet"; production-only checks are switched on per test.
const { describe, it, before, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");

Object.assign(process.env, { ADAPTER_SECRET_KEY: "11".repeat(32), NODE_ENV: "test", LOG_TO_FILE: "false", LOG_LEVEL: "error" });
const config = require("../src/config");
const netGuard = require("../src/utils/netGuard");
const { safeFetch, hostAllowed, setFetchForTests } = require("../src/utils/safeFetch");

describe("netGuard.isPrivateAddress", () => {
  const blocked = [
    "127.0.0.1", "127.1.2.3", "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1",
    "224.0.0.1", "255.255.255.255", "198.18.0.1", "::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:169.254.169.254", "::ffff:10.1.2.3", "not-an-ip",
  ];
  const allowed = ["93.184.216.34", "8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"];
  for (const ip of blocked) it(`blocks ${ip}`, () => assert.equal(netGuard.isPrivateAddress(ip), true));
  for (const ip of allowed) it(`allows ${ip}`, () => assert.equal(netGuard.isPrivateAddress(ip), false));
});

describe("safeFetch in production mode", () => {
  let server, port, hits;
  before(async () => {
    server = http.createServer((req, res) => {
      hits.push({ url: req.url, authorization: req.headers.authorization || null, host: req.headers.host });
      if (req.url.startsWith("/redirect-forever")) { res.writeHead(302, { Location: "/redirect-forever" }); return res.end(); }
      if (req.url.startsWith("/redirect-to-other-host")) { res.writeHead(302, { Location: `http://localhost:${port}/landed` }); return res.end(); }
      if (req.url.startsWith("/big")) { res.writeHead(200, { "Content-Type": "text/plain" }); return res.end("x".repeat(2 * 1024 * 1024)); }
      if (req.url.startsWith("/declared-big")) { res.writeHead(200, { "Content-Length": String(50 * 1024 * 1024) }); return res.write("x"); }
      if (req.url.startsWith("/hang")) return; // never answers
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = server.address().port;
  });
  after(() => { server.closeAllConnections(); server.close(); });
  afterEach(() => { config.isProduction = false; netGuard.setResolver(null); hits.length = 0; });
  hits = [];

  const production = () => { config.isProduction = true; };

  it("refuses private, loopback and metadata addresses given as literals", async () => {
    production();
    for (const url of ["https://127.0.0.1/", "https://10.0.0.5/x", "https://169.254.169.254/latest/meta-data/", "https://[::1]/", "https://[::ffff:127.0.0.1]/", "https://0.0.0.0/", "https://192.168.0.10:8443/"]) {
      await assert.rejects(() => safeFetch(url), /not allowed/i, url);
    }
  });

  it("refuses plain http and addresses with a user name in production", async () => {
    production();
    netGuard.setResolver(async () => [{ address: "93.184.216.34", family: 4 }]);
    await assert.rejects(() => safeFetch("http://shop.example.com/"), /https/);
    await assert.rejects(() => safeFetch("https://user:pass@shop.example.com/"), /user name/);
  });

  it("refuses a host name that resolves to a private address, or to a mix of public and private addresses", async () => {
    production();
    netGuard.setResolver(async () => [{ address: "10.1.2.3", family: 4 }]);
    await assert.rejects(() => safeFetch("https://internal.example.com/"), /not allowed/i);
    netGuard.setResolver(async () => [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }]);
    await assert.rejects(() => safeFetch("https://mixed.example.com/"), /not allowed/i);
    netGuard.setResolver(async () => { throw new Error("ENOTFOUND"); });
    await assert.rejects(() => safeFetch("https://missing.example.com/"), /could not be resolved/i);
  });

  it("DNS rebinding: a name that is public at the first check but private when the connection opens is refused", async () => {
    production();
    let lookups = 0;
    netGuard.setResolver(async () => (++lookups === 1 ? [{ address: "93.184.216.34", family: 4 }] : [{ address: "127.0.0.1", family: 4 }]));
    await assert.rejects(() => safeFetch(`http://rebind.example.com:${port}/secret`, {}, { requireHttps: false }), (err) => /fetch failed|not allowed/i.test(err.message) || (err.cause && /not allowed/i.test(err.cause.message)));
    assert.equal(hits.length, 0, "the local server was never reached");
    assert.ok(lookups >= 2, "the address was checked again when connecting");
  });

  it("a redirect to a private address is refused and never followed", async () => {
    production();
    const calls = [];
    setFetchForTests(async (url) => { calls.push(String(url)); return calls.length === 1 ? new Response(null, { status: 302, headers: { Location: "http://169.254.169.254/latest/meta-data/" } }) : new Response("secret", { status: 200 }); });
    netGuard.setResolver(async () => [{ address: "93.184.216.34", family: 4 }]);
    try {
      await assert.rejects(() => safeFetch("https://shop.example.com/redirector"), /not allowed|https/i);
      assert.equal(calls.length, 1, "the second request was never made");
    } finally { setFetchForTests(null); }
  });

  it("only hosts on the allow-list can be called", async () => {
    production();
    netGuard.setResolver(async () => [{ address: "93.184.216.34", family: 4 }]);
    await assert.rejects(() => safeFetch("https://evil.example.com/", {}, { allowHosts: ["pgpay.icicibank.com"] }), /allow-list/);
    assert.equal(hostAllowed("pgpay.icicibank.com", ["pgpay.icicibank.com"]), true);
    assert.equal(hostAllowed("a.b.icicibank.com", ["*.icicibank.com"]), true);
    assert.equal(hostAllowed("icicibank.com.evil.test", ["*.icicibank.com"]), false);
    assert.equal(hostAllowed("evilpgpay.icicibank.com.evil.test", ["pgpay.icicibank.com"]), false);
  });

  it("the payment gateway never calls a host that is not ICICI", async () => {
    production();
    const icici = require("../src/payments/IciciGateway");
    Object.assign(process.env, { ICICI_PG_MERCHANT_ID: "M", ICICI_PG_AGGREGATOR_ID: "A", ICICI_PG_SECRET_KEY: "k" });
    config.payment.icici.merchantId = "M"; config.payment.icici.aggregatorId = "A"; config.payment.icici.secretKey = "k";
    const saved = config.payment.icici.baseUrl;
    config.payment.icici.baseUrl = "https://attacker.example.com";
    try {
      await assert.rejects(() => icici.checkStatus({ merchantTxnNo: "X1", totalMinor: 100, currency: "INR" }), /allow-list|could not be reached/i);
    } finally { config.payment.icici.baseUrl = saved; }
  });
});

describe("safeFetch limits (outside production, local server)", () => {
  let server, port, hits;
  before(async () => {
    hits = [];
    server = http.createServer((req, res) => {
      hits.push({ url: req.url, authorization: req.headers.authorization || null });
      if (req.url.startsWith("/redirect-forever")) { res.writeHead(302, { Location: "/redirect-forever" }); return res.end(); }
      if (req.url.startsWith("/redirect-to-other-host")) { res.writeHead(302, { Location: `http://localhost:${port}/landed` }); return res.end(); }
      if (req.url.startsWith("/big")) { res.writeHead(200, { "Content-Type": "text/plain" }); return res.end("x".repeat(2 * 1024 * 1024)); }
      if (req.url.startsWith("/declared-big")) { res.writeHead(200, { "Content-Length": String(50 * 1024 * 1024) }); return res.write("x"); }
      if (req.url.startsWith("/hang")) return;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = server.address().port;
  });
  after(() => { server.closeAllConnections(); server.close(); });
  const url = (path) => `http://127.0.0.1:${port}${path}`;

  it("a normal answer passes through", async () => {
    const res = await safeFetch(url("/ok"));
    assert.deepEqual(await res.json(), { ok: true });
  });

  it("stops after too many redirects; a fixed service (maxRedirects 0) treats any redirect as an error", async () => {
    await assert.rejects(() => safeFetch(url("/redirect-forever")), /Too many redirects/);
    await assert.rejects(() => safeFetch(url("/redirect-forever"), {}, { maxRedirects: 0 }), /redirect/i);
  });

  it("drops the Authorization header when a redirect moves to another host", async () => {
    hits.length = 0;
    const res = await safeFetch(url("/redirect-to-other-host"), { headers: { Authorization: "Bearer secret-token" } });
    assert.equal(res.status, 200);
    const first = hits.find((h) => h.url === "/redirect-to-other-host");
    const landed = hits.find((h) => h.url === "/landed");
    assert.equal(first.authorization, "Bearer secret-token");
    assert.equal(landed.authorization, null, "the token is not sent to the other host");
  });

  it("an answer larger than the cap is cut off; an oversized Content-Length is refused at once", async () => {
    const res = await safeFetch(url("/big"), {}, { maxBytes: 1024 * 1024 });
    await assert.rejects(() => res.arrayBuffer(), /larger than the allowed/);
    await assert.rejects(() => safeFetch(url("/declared-big"), {}, { maxBytes: 1024 * 1024 }), /larger than the allowed/);
  });

  it("a server that never answers is abandoned after the timeout", async () => {
    const started = Date.now();
    await assert.rejects(() => safeFetch(url("/hang"), {}, { timeoutMs: 300 }), (err) => err.name === "TimeoutError" || err.name === "AbortError");
    assert.ok(Date.now() - started < 3000);
  });
});

describe("callers use the guard", () => {
  afterEach(() => { config.isProduction = false; netGuard.setResolver(null); });

  it("the Magento client refuses a private store address in production without retrying", async () => {
    config.isProduction = true;
    const { magentoRequest } = require("../src/integrations/magentoClient");
    const started = Date.now();
    await assert.rejects(() => magentoRequest("https://10.0.0.5/rest/V1/store/websites", "token"), (err) => err.status === 400 && /not allowed/i.test(err.message));
    assert.ok(Date.now() - started < 1500, "no retry back-off for a refused address");
  });

  it("registration refuses private store URLs, plain http and unresolvable names in production", async () => {
    config.isProduction = true;
    netGuard.setResolver(async (host) => (host === "good.example.com" ? [{ address: "93.184.216.34", family: 4 }] : [{ address: "192.168.1.20", family: 4 }]));
    const { register } = require("../src/services/registrationService");
    await assert.rejects(() => register({ baseUrl: "https://intranet.example.com", magentoToken: "t" }), /publicly reachable/);
    await assert.rejects(() => register({ baseUrl: "https://192.168.1.20", magentoToken: "t" }), /publicly reachable/);
    await assert.rejects(() => register({ baseUrl: "http://good.example.com", magentoToken: "t" }), /https/);
  });

  it("calls to the video engine are limited to the configured hosts", async () => {
    const { loggedFetch } = require("../src/utils/httpLog");
    const savedBase = config.flipick.videoEngineBaseUrl;
    config.flipick.videoEngineBaseUrl = "http://engine.internal.example:3000";
    try {
      await assert.rejects(() => loggedFetch("video-engine", "http://169.254.169.254/latest/meta-data/"), /allow-list|failed/);
    } finally { config.flipick.videoEngineBaseUrl = savedBase; }
  });
});
