// Log files with rotation, no dependencies.
//
//   * Every day at 00:05:00 (server local time, LOG_ROTATE_AT) the current file is closed, zipped and a new one is started.
//   * Whenever a file passes 10 MB (LOG_MAX_BYTES) it is zipped at once and a new file is started, whatever the time.
//   * Archives are named  <name>-YYYY-MM-DD.zip  (daily; the date the file was started)  or  <name>-YYYY-MM-DD-HHmmss.zip  (size).
//
// A rotation renames the live file first (atomic), so no line is lost or split; the zip is written next to it and the renamed
// file is removed only after the zip is complete. A crash in between leaves the renamed file behind, and the next start zips it.
// Rotation is also checked on every write, so a sleeping process or a missed timer never skips a day.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const pad = (n, w = 2) => String(n).padStart(w, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hms = (d) => `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// A zip archive holding one file (deflate). Written to <zip>.tmp and renamed, so a half-written archive is never visible.
async function zipSingleFile(sourcePath, zipPath, entryName, modified = new Date()) {
  const data = await fs.promises.readFile(sourcePath);
  const compressed = await new Promise((resolve, reject) => zlib.deflateRaw(data, { level: 9 }, (e, r) => (e ? reject(e) : resolve(r))));
  const name = Buffer.from(entryName, "utf8");
  const crc = crc32(data);
  const dosTime = (modified.getHours() << 11) | (modified.getMinutes() << 5) | (modified.getSeconds() >> 1);
  const dosDate = (Math.max(modified.getFullYear(), 1980) - 1980) << 9 | (modified.getMonth() + 1) << 5 | modified.getDate();
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
  local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12); local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(8, 10);
  central.writeUInt16LE(dosTime, 12); central.writeUInt16LE(dosDate, 14); central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
  const offset = local.length + name.length + compressed.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(offset, 16);
  const tmp = `${zipPath}.tmp`;
  await fs.promises.writeFile(tmp, Buffer.concat([local, name, compressed, central, name, end]));
  await fs.promises.rename(tmp, zipPath);
}

// The first moment after `from` that is HH:MM:00 local time.
function nextBoundary(from, at = "00:05") {
  const [h, m] = String(at).split(":").map((x) => Number(x));
  const candidate = new Date(from);
  candidate.setHours(Number.isFinite(h) ? h : 0, Number.isFinite(m) ? m : 5, 0, 0);
  if (candidate <= from) candidate.setDate(candidate.getDate() + 1);
  return candidate;
}

class RotatingFile {
  constructor({ dir, name, maxBytes = 10 * 1024 * 1024, rotateAt = "00:05", retentionDays = 0, now = () => new Date(), onError = () => {}, timer = true }) {
    this.dir = dir;
    this.name = name;
    this.maxBytes = maxBytes;
    this.rotateAt = rotateAt;
    this.retentionDays = retentionDays;
    this.now = now;
    this.onError = onError;
    this.file = path.join(dir, `${name}.log`);
    this.size = 0;
    this.openedOn = null;
    this.pending = new Set(); // zips still being written (flush() waits for them)
    this.seq = 0;
    this.reserved = new Set(); // archive names handed out whose zip may not be on disk yet
    fs.mkdirSync(dir, { recursive: true });
    this.recover();
    this.nextAt = nextBoundary(this.now(), rotateAt);
    if (timer) this.schedule();
  }

  // On start: zip what a crash left behind, and rotate a file from before the last 00:05 that was never rotated (process was down).
  recover() {
    for (const f of fs.readdirSync(this.dir)) {
      if (f.startsWith(`${this.name}.log.rotating-`)) this.archive(path.join(this.dir, f), this.dateFromTempName(f) || this.now(), "daily");
    }
    let stat;
    try { stat = fs.statSync(this.file); } catch { return; }
    if (stat.size === 0) return;
    const now = this.now();
    const lastBoundary = new Date(nextBoundary(now, this.rotateAt)); lastBoundary.setDate(lastBoundary.getDate() - 1);
    this.size = stat.size;
    this.openedOn = new Date(stat.birthtimeMs && stat.birthtimeMs < stat.mtimeMs ? stat.birthtimeMs : stat.mtimeMs);
    if (stat.mtime < lastBoundary) this.rotate("daily", true);
  }

  dateFromTempName(f) {
    const m = /rotating-(\d{4})(\d{2})(\d{2})/.exec(f);
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
  }

  schedule() {
    clearTimeout(this.timeout);
    const delay = Math.max(1000, this.nextAt - this.now());
    this.timeout = setTimeout(() => {
      try { this.rotate("daily"); } catch (err) { this.onError(err); }
      this.schedule();
    }, Math.min(delay, 2 ** 31 - 1));
    if (this.timeout.unref) this.timeout.unref(); // a pending rotation must not keep the process alive
  }

  write(text) {
    const t = this.now();
    if (t >= this.nextAt) this.rotate("daily"); // the timer is a convenience; this check is the guarantee
    const bytes = Buffer.byteLength(text);
    if (this.size > 0 && this.size + bytes > this.maxBytes) this.rotate("size");
    if (this.size === 0) this.openedOn = this.now();
    fs.appendFileSync(this.file, text);
    this.size += bytes;
  }

  rotate(reason, startup = false) {
    const t = this.now();
    this.nextAt = nextBoundary(t, this.rotateAt);
    if (this.size === 0) return null;
    const stamp = `${ymd(t).replace(/-/g, "")}-${hms(t)}-${++this.seq}`;
    const tmp = `${this.file}.rotating-${stamp}`;
    fs.renameSync(this.file, tmp); // atomic: new lines go to a fresh file from here on
    const opened = this.openedOn || t;
    this.size = 0;
    this.openedOn = null;
    return this.archive(tmp, opened, reason, t, startup);
  }

  archiveName(opened, reason, t) {
    const base = reason === "size" ? `${this.name}-${ymd(t)}-${hms(t)}` : `${this.name}-${ymd(opened)}`;
    let candidate = base, n = 1;
    // A zip is written asynchronously, so a name is also reserved in memory: two rotations in the same second never share one.
    while (this.reserved.has(candidate) || fs.existsSync(path.join(this.dir, `${candidate}.zip`))) candidate = `${base}-${++n}`;
    this.reserved.add(candidate);
    return candidate;
  }

  archive(tmpPath, opened, reason, t = this.now()) {
    const base = this.archiveName(opened, reason, t);
    const zipPath = path.join(this.dir, `${base}.zip`);
    const job = zipSingleFile(tmpPath, zipPath, `${base}.log`, t)
      .then(() => fs.promises.unlink(tmpPath))
      .then(() => this.prune())
      .catch((err) => this.onError(new Error(`could not zip ${path.basename(tmpPath)}: ${err.message}`)))
      .finally(() => { this.pending.delete(job); this.reserved.delete(base); });
    this.pending.add(job);
    return zipPath;
  }

  prune() {
    if (!this.retentionDays) return;
    const limit = this.now().getTime() - this.retentionDays * 86400000;
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.startsWith(`${this.name}-`) || !f.endsWith(".zip")) continue;
      const p = path.join(this.dir, f);
      try { if (fs.statSync(p).mtimeMs < limit) fs.unlinkSync(p); } catch { /* already gone */ }
    }
  }

  async flush() {
    await Promise.all([...this.pending]);
  }

  close() {
    clearTimeout(this.timeout);
  }
}

module.exports = { RotatingFile, zipSingleFile, nextBoundary, crc32 };
