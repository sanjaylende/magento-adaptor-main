// Lifestyle generation goes through the video-engine job/poll path (same as Hero Product / Image Transitions), no database needed.
process.env.LOG_TO_FILE = "false";
process.env.OUTBOUND_ALLOWED_HOSTS = "127.0.0.1"; // the fake engine below
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { generateLifestyleVideo } = require("../src/integrations/videoEngineClient");
const { generateVideo } = require("../src/services/videoEngineService");

function engine(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => { seen.push({ method: req.method, url: req.url, body: raw ? JSON.parse(raw) : null, auth: req.headers.authorization }); handler(req, res, seen); });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, seen, base: `http://127.0.0.1:${server.address().port}` })));
}
const accept = (req, res) => { res.writeHead(202, { "Content-Type": "application/json" }); res.end(JSON.stringify({ job_id: "job-1", status_url: "/x" })); };
const product = { name: "Red Apples", category: "Fruits", uniqueTag: "t-1", image: "https://cdn.example/apples.jpg", price: 10 };

test("generateLifestyleVideo posts a lifestyle job to the video engine and returns the job id", async () => {
  const e = await engine(accept);
  try {
    const out = await generateLifestyleVideo({
      baseUrl: e.base, apiKey: "k", productName: "Red Apples", category: "Fruits", aspectRatio: "5:4",
      sourceImageUrl: "https://cdn.example/apples.jpg", overlayFamily: "Offer Banner", noOverlay: false, brandId: "b1",
      retailerName: "Shop", sourceRef: "t-1", overlayValues: { v1: "x" }, theme: "the full prompt", promptIsFinal: true,
    });
    assert.equal(out.job_id, "job-1");
    const r = e.seen[0];
    assert.equal(r.url, "/api/v2/video-engine/generate");
    assert.equal(r.auth, "Bearer k");
    const b = r.body;
    assert.equal(b.video_type, "lifestyle");
    assert.equal(b.aspect_ratio, "5:4");
    assert.equal(b.theme, "the full prompt");
    assert.equal(b.prompt_is_final, true);
    assert.equal(b.force_new_project, true);
    assert.equal("project_id" in b, false);
    assert.equal(b.no_overlay, false);
    assert.equal(b.overlay_family, "Offer Banner");
    assert.equal(b.brand_id, "b1");
    assert.equal(b.brand_name, "Shop");
    assert.equal(b.source_ref, "t-1");
    assert.deepEqual(b.overlay_values, { v1: "x" });
    assert.deepEqual(b.source, { type: "image", image_data: "https://cdn.example/apples.jpg" });
    assert.equal(b.start_image_url, undefined, "like Shopify, Lifestyle does not send a starting frame");
    assert.match(b.callback_url, /\/api\/webhooks\/video-engine$/);
  } finally { e.server.close(); }
});

test("generateLifestyleVideo: no image is fine, an unknown ratio falls back to 16:9, a theme is required unless refreshing", async () => {
  const e = await engine(accept);
  try {
    await generateLifestyleVideo({ baseUrl: e.base, apiKey: "k", productName: "Apples", aspectRatio: "3:2", theme: "t" });
    assert.equal("source" in e.seen[0].body, false);
    assert.equal(e.seen[0].body.aspect_ratio, "16:9");
    assert.equal(e.seen[0].body.prompt_is_final, false);
    await assert.rejects(generateLifestyleVideo({ baseUrl: e.base, apiKey: "k", productName: "Apples" }), /theme is required/);
    await generateLifestyleVideo({ baseUrl: e.base, apiKey: "k", productName: "Apples", projectId: "p-9" });
    assert.equal(e.seen[1].body.project_id, "p-9");
    assert.equal(e.seen[1].body.force_new_project, false);
    await assert.rejects(generateLifestyleVideo({ baseUrl: e.base, apiKey: "", productName: "Apples", theme: "t" }), /baseUrl and apiKey/);
  } finally { e.server.close(); }
});

test("generateLifestyleVideo reports an engine error", async () => {
  const e = await engine((req, res) => { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "bad ratio" })); });
  try {
    await assert.rejects(generateLifestyleVideo({ baseUrl: e.base, apiKey: "k", productName: "Apples", theme: "t" }), /Lifestyle video generation failed \(400\): bad ratio/);
  } finally { e.server.close(); }
});

test("generateVideo returns a job (not a finished video) for lifestyle, like hero_product", async () => {
  const e = await engine(accept);
  try {
    const options = { videoEngineBaseUrl: e.base, videoEngineApiKey: "k", retailerName: "Shop" };
    const result = await generateVideo(product, { videoType: "lifestyle", prompt: "my prompt", aspectRatio: "16:9", startImageUrl: "https://cdn.example/s.png", noOverlay: true, overlayStyle: "custom", variableValues: { v1: "a" } }, options);
    assert.deepEqual(result, { kind: "job", jobId: "job-1" });
    const b = e.seen[0].body;
    assert.equal(b.theme, "my prompt");
    assert.equal(b.prompt_is_final, true);
    assert.equal(b.no_overlay, true);
    assert.equal(b.brand_name, "Shop");
    assert.equal(b.overlay_values.v1, "a");
    assert.equal(b.overlay_values.v2, "");
    assert.equal(b.start_image_url, undefined);
    // no prompt: the short category theme is used and the engine wraps it itself
    await generateVideo(product, { videoType: "lifestyle", aspectRatio: "16:9" }, options);
    assert.equal(e.seen[1].body.theme, "Fresh Produce");
    assert.equal(e.seen[1].body.prompt_is_final, false);
  } finally { e.server.close(); }
});

test("generateVideo lifestyle 'Update Overlay' (refresh) reuses the project and needs no theme", async () => {
  const e = await engine(accept);
  try {
    const odd = { ...product, category: "No Such Category" };
    const result = await generateVideo(odd, { videoType: "lifestyle", mode: "refresh", aspectRatio: "16:9" }, { videoEngineBaseUrl: e.base, videoEngineApiKey: "k", projectId: "p-7" });
    assert.deepEqual(result, { kind: "job", jobId: "job-1" });
    const b = e.seen[0].body;
    assert.equal(b.project_id, "p-7");
    assert.equal(b.force_new_project, false);
    assert.equal("theme" in b, false);
    assert.equal(b.prompt_is_final, false);
  } finally { e.server.close(); }
});
