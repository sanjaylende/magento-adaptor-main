// Reads colours and sizes from images and videos with ffmpeg/ffprobe (no extra packages). The centre of a frame is used, so black bars added around
// a picture to fit another aspect ratio do not disturb the colour.
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PALETTE = { red: [224, 32, 32], green: [32, 176, 32], blue: [32, 64, 224], yellow: [240, 208, 32], magenta: [208, 32, 208], cyan: [32, 208, 208], orange: [240, 128, 32], black: [0, 0, 0] };
const nearest = (rgb) => { let best = null; for (const [name, c] of Object.entries(PALETTE)) { const d = Math.hypot(rgb[0] - c[0], rgb[1] - c[1], rgb[2] - c[2]); if (!best || d < best.d) best = { name, d: Math.round(d) }; } return best; };

function rgbFromRaw(buf) { return [buf[0], buf[1], buf[2]]; }
// Colour of the centre quarter of an image held in memory.
function imageColour(buffer) {
  const r = spawnSync('ffmpeg', ['-loglevel', 'error', '-i', 'pipe:0', '-vf', 'crop=iw/4:ih/4,scale=1:1', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { input: buffer, maxBuffer: 1 << 20 });
  if (r.status !== 0 || !r.stdout || r.stdout.length < 3) throw new Error('could not read the image: ' + String(r.stderr).slice(-200));
  return nearest(rgbFromRaw(r.stdout));
}
function frameColour(videoFile, seconds) {
  const out = execFileSync('ffmpeg', ['-loglevel', 'error', '-ss', String(seconds), '-i', videoFile, '-vf', 'crop=iw/4:ih/4,scale=1:1', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { maxBuffer: 1 << 20 });
  return nearest(rgbFromRaw(out));
}
function probe(file) {
  const j = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-show_entries', 'format=duration', '-of', 'json', file], { encoding: 'utf8' }));
  return { width: j.streams[0].width, height: j.streams[0].height, duration: Number(j.format.duration) };
}
const ratioOf = (w, h) => { const r = w / h; const known = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '5:4': 5 / 4 }; for (const [k, v] of Object.entries(known)) if (Math.abs(r - v) < 0.02) return k; return `${w}x${h}`; };
async function download(url, name) { const res = await fetch(url); if (!res.ok) throw new Error(`download ${url} answered ${res.status}`); const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dl-')), name || 'video.mp4'); fs.writeFileSync(f, Buffer.from(await res.arrayBuffer())); return f; }
module.exports = { imageColour, frameColour, probe, ratioOf, download, nearest, PALETTE };
