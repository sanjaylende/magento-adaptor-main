// refreshGeneratedVideoUrls / refreshVersionUrls: only links that are close to expiring are re-signed, and a refreshed link is saved
// only when it actually changed (re-signing every ready video on every page load cost an engine call and a database write each time).
const test = require("node:test");
const assert = require("node:assert/strict");

function load({ stale, engineAnswer }) {
  const calls = { engine: [], persisted: [], set: [] };
  const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; return p; };
  const target = require.resolve("../src/services/videoUrlService");
  const paths = {
    engine: stub("../src/integrations/videoEngineClient", {
      refreshProjectVideoUrls: async (arg) => { calls.engine.push(arg.projectIds); return engineAnswer(arg.projectIds); },
      isVideoUrlStale: (u) => stale(u),
    }),
    repo: stub("../src/repositories/VideoVersionRepository", { updateVersionAndMirror: async (id, patch) => { calls.persisted.push({ id, patch }); } }),
    state: stub("../src/services/generatedState", { _all: {}, all() { return this._all; }, set(k, v) { calls.set.push([k, v]); this._all[k] = v; } }),
    config: stub("../src/config", { flipick: { videoEngineBaseUrl: "http://engine", videoEngineApiKey: "k" } }),
  };
  delete require.cache[target];
  const service = require("../src/services/videoUrlService");
  const state = require(paths.state);
  const restore = () => { delete require.cache[target]; for (const p of Object.values(paths)) delete require.cache[p]; };
  return { service, state, calls, restore };
}
const ready = (over = {}) => ({ status: "ready", projectId: "p1", currentVersionId: 7, videoUrl: "https://v/fresh.mp4", thumbnailUrl: "https://t/fresh.jpg", ...over });

test("links that are not close to expiring cause no engine call and no write", async () => {
  const { service, state, calls, restore } = load({ stale: () => false, engineAnswer: () => ({}) });
  state._all = { "a::hero_product": ready() };
  await service.refreshGeneratedVideoUrls();
  restore();
  assert.deepEqual(calls.engine, []);
  assert.deepEqual(calls.persisted, []);
});

test("an expiring link is re-signed and the new link is saved", async () => {
  const { service, state, calls, restore } = load({ stale: (u) => u.includes("old"), engineAnswer: () => ({ p1: { videoUrl: "https://v/new.mp4", thumbnailUrl: "https://t/new.jpg" } }) });
  state._all = { "a::hero_product": ready({ videoUrl: "https://v/old.mp4" }), "b::lifestyle": ready({ projectId: "p2", videoUrl: "https://v/fine.mp4" }) };
  await service.refreshGeneratedVideoUrls();
  await new Promise((r) => setImmediate(r));
  restore();
  assert.deepEqual(calls.engine, [["p1"]], "only the expiring video's project is asked for");
  assert.equal(calls.persisted.length, 1);
  assert.equal(calls.persisted[0].patch.videoUrl, "https://v/new.mp4");
});

test("a re-signed link that came back unchanged is not written again", async () => {
  const { service, state, calls, restore } = load({ stale: () => true, engineAnswer: () => ({ p1: { videoUrl: "https://v/fresh.mp4", thumbnailUrl: "https://t/fresh.jpg" } }) });
  state._all = { "a::hero_product": ready() };
  await service.refreshGeneratedVideoUrls();
  await new Promise((r) => setImmediate(r));
  restore();
  assert.equal(calls.engine.length, 1);
  assert.deepEqual(calls.persisted, []);
});

test("the version history is refreshed only for expiring links", async () => {
  const { service, calls, restore } = load({ stale: (u) => u.includes("old"), engineAnswer: () => ({ p9: { videoUrl: "https://v/new.mp4", thumbnailUrl: "https://t/new.jpg" } }) });
  const versions = [{ status: "ready", projectId: "p9", videoUrl: "https://v/old.mp4", thumbnailUrl: "t" }, { status: "ready", projectId: "p8", videoUrl: "https://v/fine.mp4", thumbnailUrl: "t" }];
  await service.refreshVersionUrls(versions);
  restore();
  assert.deepEqual(calls.engine, [["p9"]]);
  assert.equal(versions[0].videoUrl, "https://v/new.mp4");
  assert.equal(versions[1].videoUrl, "https://v/fine.mp4");
});
