// Log rotation: daily at 00:05:00, and at once above the size limit. Files are zipped, a new one is started, nothing is lost.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { RotatingFile, nextBoundary, crc32 } = require("../src/utils/logRotation");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "logrot-"));
const clock = (iso) => { let t = new Date(iso); return { now: () => new Date(t), set: (v) => { t = new Date(v); } }; };

// Reads a one-file zip the way any unzip tool would, and checks its CRC.
function readZip(file) {
  const buf = fs.readFileSync(file);
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, "end of central directory");
  assert.equal(buf.readUInt16LE(eocd + 10), 1, "one entry");
  const cen = buf.readUInt32LE(eocd + 16);
  assert.equal(buf.readUInt32LE(cen), 0x02014b50);
  const nameLen = buf.readUInt16LE(cen + 28);
  const name = buf.toString("utf8", cen + 46, cen + 46 + nameLen);
  const lh = buf.readUInt32LE(cen + 42);
  assert.equal(buf.readUInt32LE(lh), 0x04034b50);
  const compSize = buf.readUInt32LE(lh + 18), size = buf.readUInt32LE(lh + 22);
  const start = lh + 30 + buf.readUInt16LE(lh + 26) + buf.readUInt16LE(lh + 28);
  const data = zlib.inflateRawSync(buf.subarray(start, start + compSize));
  assert.equal(data.length, size);
  assert.equal(crc32(data), buf.readUInt32LE(cen + 16), "crc matches");
  return { name, text: data.toString("utf8") };
}
const zips = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith(".zip")).sort();

test("nextBoundary: 00:05:00 today if not reached, otherwise tomorrow", () => {
  assert.equal(nextBoundary(new Date(2026, 9, 8, 0, 4, 59), "00:05").getTime(), new Date(2026, 9, 8, 0, 5, 0).getTime());
  assert.equal(nextBoundary(new Date(2026, 9, 8, 0, 5, 0), "00:05").getTime(), new Date(2026, 9, 9, 0, 5, 0).getTime());
  assert.equal(nextBoundary(new Date(2026, 9, 8, 23, 59, 59), "00:05").getTime(), new Date(2026, 9, 9, 0, 5, 0).getTime());
  assert.equal(nextBoundary(new Date(2026, 11, 31, 12, 0, 0), "00:05").getTime(), new Date(2027, 0, 1, 0, 5, 0).getTime(), "across a year end");
});

test("daily: nothing happens before 00:05:00, at 00:05:00 the day is zipped and a new file starts", async () => {
  const dir = tmp(), c = clock(new Date(2026, 9, 8, 9, 0, 0));
  const log = new RotatingFile({ dir, name: "app", now: c.now, timer: false });
  log.write("line one\n");
  c.set(new Date(2026, 9, 8, 23, 59, 59)); log.write("line two\n");
  c.set(new Date(2026, 9, 9, 0, 4, 59)); log.write("line three\n");
  await log.flush();
  assert.deepEqual(zips(dir), [], "no rotation at 00:04:59");
  c.set(new Date(2026, 9, 9, 0, 5, 0)); log.write("line four\n");
  await log.flush();
  assert.deepEqual(zips(dir), ["app-2026-10-08.zip"]);
  const z = readZip(path.join(dir, "app-2026-10-08.zip"));
  assert.equal(z.name, "app-2026-10-08.log");
  assert.equal(z.text, "line one\nline two\nline three\n");
  assert.equal(fs.readFileSync(path.join(dir, "app.log"), "utf8"), "line four\n", "new file holds only what came after");
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes("rotating") || f.endsWith(".tmp")), [], "no temporary files left");
});

test("daily rotation happens once per day, again the next day", async () => {
  const dir = tmp(), c = clock(new Date(2026, 9, 8, 12, 0, 0));
  const log = new RotatingFile({ dir, name: "app", now: c.now, timer: false });
  log.write("a\n");
  c.set(new Date(2026, 9, 9, 0, 5, 0)); log.write("b\n");
  c.set(new Date(2026, 9, 9, 18, 0, 0)); log.write("c\n");
  await log.flush();
  assert.equal(zips(dir).length, 1);
  c.set(new Date(2026, 9, 10, 0, 5, 1)); log.write("d\n");
  await log.flush();
  assert.deepEqual(zips(dir), ["app-2026-10-08.zip", "app-2026-10-09.zip"]);
  assert.equal(readZip(path.join(dir, "app-2026-10-09.zip")).text, "b\nc\n");
});

test("size: a file that would pass the limit is zipped at once and a new one is started", async () => {
  const dir = tmp(), c = clock(new Date(2026, 9, 8, 10, 0, 0));
  const log = new RotatingFile({ dir, name: "app", maxBytes: 1000, now: c.now, timer: false });
  const line = `${"x".repeat(99)}\n`; // 100 bytes
  for (let i = 0; i < 10; i++) log.write(line);
  await log.flush();
  assert.deepEqual(zips(dir), [], "exactly at the limit is still one file");
  c.set(new Date(2026, 9, 8, 10, 0, 30));
  log.write("the eleventh line\n");
  await log.flush();
  assert.equal(zips(dir).length, 1);
  assert.match(zips(dir)[0], /^app-2026-10-08-100030\.zip$/);
  assert.equal(readZip(path.join(dir, zips(dir)[0])).text, line.repeat(10));
  assert.equal(fs.readFileSync(path.join(dir, "app.log"), "utf8"), "the eleventh line\n");
});

test("size: several rotations in the same second get distinct archive names", async () => {
  const dir = tmp(), c = clock(new Date(2026, 9, 8, 10, 0, 0));
  const log = new RotatingFile({ dir, name: "app", maxBytes: 50, now: c.now, timer: false });
  for (let i = 0; i < 6; i++) log.write(`${"y".repeat(40)}\n`);
  await log.flush();
  assert.equal(zips(dir).length, 5);
  assert.equal(new Set(zips(dir)).size, 5);
  const all = zips(dir).map((f) => readZip(path.join(dir, f)).text).join("") + fs.readFileSync(path.join(dir, "app.log"), "utf8");
  assert.equal(all.length, 6 * 41, "no line lost");
});

test("a file left over from before the last 00:05 (process was down) is rotated on start", async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "app.log"), "old line\n");
  const old = new Date(2026, 9, 7, 22, 0, 0);
  fs.utimesSync(path.join(dir, "app.log"), old, old);
  const c = clock(new Date(2026, 9, 8, 8, 0, 0));
  const log = new RotatingFile({ dir, name: "app", now: c.now, timer: false });
  await log.flush();
  assert.equal(zips(dir).length, 1);
  assert.equal(readZip(path.join(dir, zips(dir)[0])).text, "old line\n");
  assert.ok(!fs.existsSync(path.join(dir, "app.log")) || fs.statSync(path.join(dir, "app.log")).size === 0);
});

test("a file written today is kept on start", async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "app.log"), "today\n");
  const log = new RotatingFile({ dir, name: "app", timer: false }); // real clock
  await log.flush();
  assert.deepEqual(zips(dir), []);
  log.write("more\n");
  assert.equal(fs.readFileSync(path.join(dir, "app.log"), "utf8"), "today\nmore\n");
});

test("a renamed file left by a crash is zipped on the next start", async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "app.log.rotating-20261007-235900-1"), "half rotated\n");
  const log = new RotatingFile({ dir, name: "app", timer: false });
  await log.flush();
  assert.equal(zips(dir).length, 1);
  assert.equal(readZip(path.join(dir, zips(dir)[0])).text, "half rotated\n");
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes("rotating")), []);
});

test("retention: archives older than the limit are deleted, newer ones kept", async () => {
  const dir = tmp(), c = clock(new Date(2026, 9, 20, 9, 0, 0));
  for (const [name, daysAgo] of [["app-2026-09-01.zip", 40], ["app-2026-10-15.zip", 5]]) {
    const p = path.join(dir, name); fs.writeFileSync(p, "x");
    const t = new Date(c.now().getTime() - daysAgo * 86400000); fs.utimesSync(p, t, t);
  }
  const log = new RotatingFile({ dir, name: "app", retentionDays: 30, maxBytes: 10, now: c.now, timer: false });
  log.write("0123456789\n"); log.write("trigger a rotation\n");
  await log.flush();
  assert.ok(!zips(dir).includes("app-2026-09-01.zip"));
  assert.ok(zips(dir).includes("app-2026-10-15.zip"));
});

test("the logger writes app.log and error.log, redacted, and rotates through the same code", async () => {
  const dir = tmp();
  const saved = { ...process.env };
  Object.assign(process.env, { LOG_DIR: dir, LOG_TO_FILE: "true", LOG_MAX_BYTES: "400", LOG_LEVEL: "debug" });
  delete require.cache[require.resolve("../src/utils/logger")];
  const logger = require("../src/utils/logger");
  const out = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    logger.info("hello", { token: "TOPSECRET" });
    logger.error("it broke", { error: new Error("kaput") });
    for (let i = 0; i < 12; i++) logger.info(`filler ${i} ${"z".repeat(60)}`);
    await logger.flush();
  } finally {
    Object.assign(console, out);
    logger.close();
    for (const k of ["LOG_DIR", "LOG_TO_FILE", "LOG_MAX_BYTES", "LOG_LEVEL"]) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    delete require.cache[require.resolve("../src/utils/logger")];
  }
  const appZips = zips(dir).filter((f) => f.startsWith("app-"));
  assert.ok(appZips.length >= 1, "size rotation happened through the logger");
  const everything = appZips.map((f) => readZip(path.join(dir, f)).text).join("") + fs.readFileSync(path.join(dir, "app.log"), "utf8");
  assert.match(everything, /hello/);
  assert.ok(!everything.includes("TOPSECRET"));
  const errors = fs.readFileSync(path.join(dir, "error.log"), "utf8");
  assert.match(errors, /it broke/);
  assert.ok(!/hello/.test(errors), "error.log holds warnings and errors only");
});
