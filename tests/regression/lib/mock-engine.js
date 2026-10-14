// A stand-in for the Flipick video engine for automated tests. It speaks the same API the adapters use (/api/v2/video-engine/*), and it renders
// REAL videos with ffmpeg from the images the adapter sends, so a test can compare the frames of the finished video with the images that were sent.
//   image_transition: the 4 start_image_urls, 2 s each (8 s clip), in the order sent
//   hero_product:     start_image_url if given, else source.image_data / source_image_url / source.url (the product's own photo), 4 s
// The output size follows aspect_ratio (9:16, 16:9, 1:1, 5:4). Every request body is kept for the test to read (GET /_requests).
// Env: PORT (3999), MOCK_RENDER_SECONDS (how long a job stays "rendering", default 3), MOCK_DIR (work folder).
// Needs ffmpeg and ffprobe on the PATH. Never contacts anything but the image addresses it is given.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const PORT = Number(process.env.PORT || 3999);
const KEY = process.env.MOCK_ENGINE_KEY || 'test-key';
const RENDER_MS = Number(process.env.MOCK_RENDER_SECONDS || 3) * 1000;
const DIR = process.env.MOCK_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'mock-engine-'));
fs.mkdirSync(DIR, { recursive: true });
const SIZES = { '16:9': [1280, 720], '9:16': [720, 1280], '1:1': [1080, 1080], '5:4': [1080, 864] };
const jobs = {};
const requests = [];
let sequence = 0;
const signedQs = () => '?X-Goog-Date=' + new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z/, 'Z') + '&X-Goog-Expires=604800&X-Goog-Signature=mock';
const host = (req) => `http://${req.headers.host}`;
const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const run = (cmd, args) => new Promise((resolve, reject) => execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024 }, (err, out, errOut) => (err ? reject(new Error(`${cmd} failed: ${String(errOut).slice(-300)}`)) : resolve(out))));

// A 1x1 grey JPEG used when an image cannot be fetched (the failure is recorded on the job, never hidden).
async function fetchImage(url, file) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`image ${url} answered ${res.status}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

async function render(job, body) {
  const [w, h] = SIZES[job.aspect] || SIZES['16:9'];
  const base = path.join(DIR, job.id);
  fs.mkdirSync(base, { recursive: true });
  const urls = job.images;
  const files = [];
  for (let i = 0; i < urls.length; i++) {
    const f = path.join(base, `in${i}.img`);
    // an address nobody answers on (network error) gets the grey placeholder, like a CDN that serves a default; an HTTP error still fails the job
    try { await fetchImage(urls[i], f); files.push(f); } catch (e) { if (/answered d+/.test(e.message)) throw e; job.warnings = (job.warnings || []).concat(`${urls[i]}: ${e.message}`); }
  }
  // no picture sent at all (a store product without photos): a plain grey placeholder so the job still finishes; pictures that WERE sent must load
  if (!files.length) { const g = path.join(base, 'grey.jpg'); await run('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x808080:s=640x360', '-frames:v', '1', g]); files.push(g); }
  job.fetched = files.length;
  const out = path.join(DIR, `${job.id}.mp4`);
  const secondsEach = job.type === 'image_transition' ? 2 : 4;
  const fit = `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=25,format=yuv420p`;
  const inputs = files.flatMap((f) => ['-loop', '1', '-t', String(secondsEach), '-i', f]);
  const filter = files.map((_, i) => `[${i}:v]${fit}[v${i}]`).join(';') + ';' + files.map((_, i) => `[v${i}]`).join('') + `concat=n=${files.length}:v=1:a=0[out]`;
  await run('ffmpeg', ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', filter, '-map', '[out]', '-movflags', '+faststart', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', out]);
  const still = path.join(DIR, `${job.id}.jpg`);
  await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', out, '-frames:v', '1', still]);
  job.video = out; job.thumb = still;
}

function serveFile(req, res, file, type) {
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  const size = fs.statSync(file).size;
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  let start = 0, end = size - 1, code = 200;
  if (m) { code = 206; start = m[1] === '' ? size - Number(m[2]) : Number(m[1]); end = m[2] === '' || m[1] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
  res.writeHead(code, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, ...(code === 206 ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) });
  fs.createReadStream(file, { start, end }).pipe(res);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, host(req));
  // the four candidate pictures that /preview-images points to: plain colour images made on first use
  const still = /^\/media\/still([1-4])\.jpg$/.exec(url.pathname);
  if (still) {
    const file = path.join(DIR, `still${still[1]}.jpg`);
    const colour = ['E02020', '20B020', '2040E0', 'F0D020'][Number(still[1]) - 1];
    const send = () => serveFile(req, res, file, 'image/jpeg');
    if (fs.existsSync(file)) return send();
    return run('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=0x${colour}:s=1024x576`, '-frames:v', '1', file]).then(send, () => { res.writeHead(500); res.end(); });
  }
  if (url.pathname.startsWith('/media/') && url.pathname.endsWith('.mp4')) { const j = jobs[url.pathname.slice(7, -4)]; return serveFile(req, res, j && j.video, 'video/mp4'); }
  if (url.pathname.startsWith('/media/') && url.pathname.endsWith('.jpg')) { const j = jobs[url.pathname.slice(7, -4)]; return serveFile(req, res, j && j.thumb, 'image/jpeg'); }
  if (url.pathname === '/_requests') return json(res, 200, requests);
  if (url.pathname === '/_reset') { requests.length = 0; return json(res, 200, { ok: true }); }
  if (req.headers.authorization !== `Bearer ${KEY}`) return json(res, 401, { error: 'Invalid API key' });
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {};
    const p = url.pathname.replace('/api/v2/video-engine', '');
    if (req.method !== 'GET') requests.push({ at: new Date().toISOString(), path: p, body });
    if (p === '/projects/refresh-urls') {
      const out = {};
      (body.project_ids || []).forEach((id) => { const j = Object.values(jobs).find((x) => x.projectId === id); out[id] = j ? { videoUrl: `${host(req)}/media/${j.id}.mp4${signedQs()}`, thumbnailUrl: `${host(req)}/media/${j.id}.jpg${signedQs()}`, refreshed: false } : { error: 'unknown project' }; });
      return json(res, 200, { results: out });
    }
    if (p === '/category-defaults') return json(res, 200, { category_matched: true, suggested_prompt: `A hero product video featuring slow rotation, macro close-up, matte studio background for ${url.searchParams.get('category')}.`, vo_tone_default: 'warm' });
    if (p === '/overlay-families') return json(res, 200, { families: [{ name: 'Offer Banner', isSystem: false, sizes: [], anySize: true, variables: ['ProductName', 'SalePrice', 'StrikethroughPrice', 'Offer'] }, { name: 'System Default', isSystem: true, variables: [] }] });
    if (p.startsWith('/overlay-families/') && p.endsWith('/preview')) { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')); }
    if (p === '/preview-images') {
      if (!body.category || !body.product_name || !body.aspect_ratio) return json(res, 400, { error: 'Missing required field(s)' });
      return json(res, 200, { images: [1, 2, 3, 4].map((i) => ({ url: `${host(req)}/media/still${i}.jpg` })) });
    }
    if (p === '/generate') {
      const missing = [];
      if (!body.video_type) missing.push('video_type');
      if (body.video_type === 'image_transition' && !body.project_id && (body.start_image_urls || []).length !== 4) missing.push('start_image_urls (array of exactly 4 URLs)');
      if (body.video_type === 'hero_product' && !body.source && !body.project_id && !body.source_image_url && !body.start_image_url) missing.push('source');
      if (missing.length) return json(res, 400, { error: 'Missing required field(s)', fields: missing });
      const id = `job${++sequence}${Date.now().toString(36)}`;
      const refresh = !!body.project_id; // "Update Overlay": re-uses the finished base video of that project
      const base = refresh ? Object.values(jobs).find((x) => x.projectId === body.project_id) : null;
      const images = body.video_type === 'image_transition' ? (body.start_image_urls || []) : [body.start_image_url || (body.source && (body.source.image_data || body.source.url)) || body.source_image_url].filter(Boolean);
      jobs[id] = { id, t0: Date.now(), type: body.video_type, aspect: body.aspect_ratio || '16:9', images, projectId: `proj-${id}`, refresh, base, overlay: body.overlay_values || null, state: 'rendering', body };
      if (refresh && base) { jobs[id].projectId = base.projectId; jobs[id].video = base.video; jobs[id].thumb = base.thumb; jobs[id].state = 'ready'; jobs[id].ready = true; }
      else render(jobs[id], body).then(() => { jobs[id].ready = true; }).catch((e) => { jobs[id].state = 'error'; jobs[id].error = e.message; });
      return json(res, 202, { job_id: id, status_url: `/api/v2/video-engine/jobs/${id}` });
    }
    if (p.startsWith('/jobs/')) {
      const j = jobs[p.slice(6)];
      if (!j) return json(res, 404, { error: 'Job not found' });
      if (j.state === 'error') return json(res, 200, { job_id: j.id, status: 'failed', progress_pct: 0, error: { message: j.error } });
      const waited = Date.now() - j.t0 >= RENDER_MS;
      if (!j.ready || !waited) return json(res, 200, { job_id: j.id, status: 'rendering', progress_pct: Math.min(90, Math.round((Date.now() - j.t0) / RENDER_MS * 90)), project_id: null, video_url: null, thumbnail_url: null, error: null });
      return json(res, 200, { job_id: j.id, status: 'completed', progress_pct: 100, project_id: j.projectId, video_url: `${host(req)}/media/${j.id}.mp4${signedQs()}`, thumbnail_url: `${host(req)}/media/${j.id}.jpg${signedQs()}`, error: null });
    }
    json(res, 404, { error: 'Not found' });
  });
});
if (require.main === module) server.listen(PORT, '127.0.0.1', () => console.log(`mock engine on ${PORT}, work folder ${DIR}`));
module.exports = { server, DIR };
