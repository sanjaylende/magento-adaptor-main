// Stills picker helpers and the Lifestyle default prompt (real prompt from the engine, with a safe fallback), no database needed.
process.env.LOG_TO_FILE = "false";
process.env.OUTBOUND_ALLOWED_HOSTS = "127.0.0.1"; // the fake engine below
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { sniffImageType } = require("../src/controllers/stillImageController");
const { getPromptDefault } = require("../src/services/videoEngineService");
const { generateVvpVideo } = require("../src/integrations/flipickClient");

test("sniffImageType recognises JPEG, PNG, GIF and WebP by their first bytes, and nothing else", () => {
  const pad = Buffer.alloc(16);
  assert.equal(sniffImageType(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), pad])), "image/jpeg");
  assert.equal(sniffImageType(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pad])), "image/png");
  assert.equal(sniffImageType(Buffer.concat([Buffer.from("GIF89a"), pad])), "image/gif");
  assert.equal(sniffImageType(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 "), pad])), "image/webp");
  assert.equal(sniffImageType(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>")), null, "SVG can carry script and is refused");
  assert.equal(sniffImageType(Buffer.from("<html>")), null);
  assert.equal(sniffImageType(Buffer.alloc(3)), null);
  assert.equal(sniffImageType(null), null);
});

function engine(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => { seen.push({ method: req.method, url: req.url, body: raw }); handler(req, res, seen); });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, seen, base: `http://127.0.0.1:${server.address().port}` })));
}
const product = { name: "Red Apples", category: "Fruits", uniqueTag: "t-1" };

test("Lifestyle's default prompt is the engine's real prompt", async () => {
  const e = await engine((req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ prompt: "A cinematic shot of Red Apples..." })); });
  try {
    const prompt = await getPromptDefault(product, "lifestyle", { videoEngineBaseUrl: e.base, videoEngineApiKey: "k" });
    assert.equal(prompt, "A cinematic shot of Red Apples...");
    assert.match(e.seen[0].url, /^\/api\/v2\/video-engine\/default-prompt\?/);
    assert.match(e.seen[0].url, /video_type=lifestyle/);
    assert.match(e.seen[0].url, /product_name=Red\+Apples/);
  } finally { e.server.close(); }
});

test("against an engine without /default-prompt, Lifestyle falls back to the old category theme", async () => {
  const e = await engine((req, res) => { res.writeHead(404, { "Content-Type": "application/json" }); res.end("{}"); });
  try {
    const prompt = await getPromptDefault(product, "lifestyle", { videoEngineBaseUrl: e.base, videoEngineApiKey: "k" });
    assert.equal(prompt, "Fresh Produce");
  } finally { e.server.close(); }
  // and when the engine is not reachable at all
  assert.equal(await getPromptDefault(product, "lifestyle", { videoEngineBaseUrl: "http://127.0.0.1:1", videoEngineApiKey: "k" }), "Fresh Produce");
});

test("a submitted prompt is sent with prompt_is_final so the engine does not wrap it a second time", async () => {
  const e = await engine((req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ video_url: "https://v/x.mp4" })); });
  try {
    const call = (extra) => generateVvpVideo({ baseUrl: e.base, apiKey: "k", tenantId: "t", externalRef: "x", theme: "my prompt", category: "Fruits", name: "Apples", ...extra });
    await call({ promptIsFinal: true });
    await call({});
    assert.equal(JSON.parse(e.seen[0].body).prompt_is_final, true);
    assert.equal("prompt_is_final" in JSON.parse(e.seen[1].body), false, "absent unless set: an older engine never sees it");
  } finally { e.server.close(); }
});
