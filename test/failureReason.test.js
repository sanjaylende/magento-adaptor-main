// What a merchant may read about a failed video: the engine's reason as one short line, never an address, a path or a raw data dump.
const test = require("node:test");
const assert = require("node:assert/strict");
const { toDto } = require("../src/models/VideoVersion");

const reason = (error) => toDto({ id: 1, storeId: 1, values: { status: "error", error } }, { values: { uniqueTag: "t", videoType: "lifestyle" } }).error;

test("a plain reason from the engine is kept", () => {
  assert.equal(reason("Lifestyle video generation failed (400): Content blocked by safety policy"), "Lifestyle video generation failed (400): Content blocked by safety policy");
});

test("web addresses, IP addresses with a port, host:port and file paths are replaced", () => {
  assert.equal(reason("fetch to https://engine.internal/x?k=1 failed"), "fetch to [link] failed");
  assert.equal(reason("connect ECONNREFUSED 10.0.0.5:8080"), "connect ECONNREFUSED [address]");
  assert.equal(reason("connect ETIMEDOUT db.internal:5432"), "connect ETIMEDOUT [address]");
  assert.equal(reason("ENOENT /srv/app/data/file.json"), "ENOENT [path]");
  assert.equal(reason("C:\\apps\\x\\y.js crashed"), "[path] crashed");
});

test("a raw JSON body is not shown", () => {
  assert.equal(reason('failed (500): {"error":"boom","trace":"at x"}'), "The video service could not finish this video.");
});

test("nothing, and very long text", () => {
  assert.equal(reason(null), null);
  assert.equal(reason(""), null);
  assert.ok(reason("a".repeat(500)).length <= 200);
});
