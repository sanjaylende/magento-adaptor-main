// T5 renditions and images, T6 regeneration and image replacement, T7 overlay, T8 uploaded images.
// The mock engine renders real videos from the images it is sent, so the colours in the finished video's frames are compared with the colours of the
// product's own pictures. Credit for generations comes from a paid Pro plan (bought through the pretend bank). Lifestyle videos now go through the same job/poll
// path as Hero Product, so the mock engine covers them too (the real LTX prompt and picture quality are not covered; see M4).
const media = require('../lib/media');

const GALLERY = ['qa-red.jpg', 'qa-green.jpg', 'qa-blue.jpg', 'qa-yellow.jpg'];
const RATIOS = ['16:9', '9:16', '1:1', '5:4'];

module.exports = async function video({ stack, run, connectStore, waitStatus }) {
  const store = stack.store;
  const A = await connectStore(stack, { name: 'Video A' });
  const B = await connectStore(stack, { name: 'Video B', siteSuffix: 'other' });
  const storeId = async (c) => (await stack.db('select s.id from stores s join installations i on i.id = s.installation_id where i.install_key = $1 order by s.id limit 1', [c.creds.installKey]))[0].id;
  const idA = await storeId(A);
  const tagOf = async (c, i = 0) => (await c.get('/api/products')).body.products[i].uniqueTag;
  const tagA = await tagOf(A, 0);
  const enc = encodeURIComponent;

  // credit: a paid Pro plan
  const co = await A.post('/api/billing/checkout', { kind: 'plan', tier: 'pro', cycle: 'monthly', currency: 'USD' });
  const txn = (await stack.db('select merchant_txn_no from payment_orders where id = $1', [co.body.orderId]))[0].merchant_txn_no;
  await stack.pay(txn, 'paid');
  const top = await A.post('/api/billing/checkout', { kind: 'topup', packUsdCents: 5000, currency: 'USD' });
  await stack.pay((await stack.db('select merchant_txn_no from payment_orders where id = $1', [top.body.orderId]))[0].merchant_txn_no, 'paid');

  const imagesOf = async (c, tag) => (await c.get('/api/product-images/' + enc(tag))).body.images;
  const generate = async (c, body) => { await stack.engineReset(); const g = await c.post('/api/generate', body); return g; };
  const lastEngineRequest = async () => { const r = await stack.engineRequests(); return r.filter((x) => x.path === '/generate').pop(); };
  const finish = async (c, tag, type) => waitStatus(c, tag, type, ['ready', 'error']);
  const frames = async (st, secondsList) => { const f = await media.download(st.videoUrl); return { file: f, info: media.probe(f), colours: secondsList.map((s) => media.frameColour(f, s).name) }; };

  // ------------------------------------------------------------------ T5 renditions and images (Case I)
  run.section('T5', 'Renditions: product pictures -> engine request -> video frames, 4 sizes x 3 video types');
  const rows = [];
  const shown = await imagesOf(A, tagA);
  const urls = shown.map((i) => i.url);
  run.check('the picker lists all 4 real pictures of the product, in gallery order', urls.length === 4 && urls.every((u, i) => u.endsWith(GALLERY[i])), urls.map((u) => u.split('/').pop()).join(','));
  const shownColours = [];
  for (const i of shown) { const r = await fetch(stack.base + i.displayUrl); shownColours.push(media.imageColour(Buffer.from(await r.arrayBuffer())).name); }
  run.check('the pictures the merchant sees in the picker (through the adapter) are the product\'s own pictures', shownColours.join(',') === 'red,green,blue,yellow', shownColours.join(','));
  for (const type of ['image_transition', 'hero_product', 'lifestyle']) {
    for (const ratio of RATIOS) {
      const slot = await tagOf(A, type === 'image_transition' ? 0 : 0);
      const body = type === 'image_transition' ? { uniqueTag: slot, videoType: type, aspectRatio: ratio, startImageUrls: urls } : { uniqueTag: slot, videoType: type, aspectRatio: ratio, startImageUrl: urls[0] };
      const g = await generate(A, body);
      if (g.status !== 200) { run.check(`${type} ${ratio}: generation accepted`, false, `HTTP ${g.status} ${g.text.slice(0, 100)}`); continue; }
      const st = await finish(A, slot, type);
      const req = await lastEngineRequest();
      const sent = req ? (req.body.start_image_urls || [req.body.start_image_url || (req.body.source && (req.body.source.url || req.body.source.image_data)) || req.body.source_image_url]).filter(Boolean) : [];
      const ok = st.status === 'ready';
      let f = { info: { width: 0, height: 0 }, colours: [] };
      if (ok) f = await frames(st, type === 'image_transition' ? [0.5, 2.5, 4.5, 6.5] : [1]);
      const gotRatio = ok ? media.ratioOf(f.info.width, f.info.height) : '-';
      const wantColours = type === 'image_transition' ? 'red,green,blue,yellow' : 'red';
      rows.push([type, ratio, String(req && req.body.aspect_ratio), ok ? `${f.info.width}x${f.info.height} (${gotRatio})` : st.status, sent.map((u) => u.split('/').pop().replace('qa-', '').replace('.jpg', '')).join(','), f.colours.join(','), wantColours]);
      run.check(`${type} ${ratio}: the video is ready`, ok, st.status + (st.error ? ' ' + String(st.error).slice(0, 80) : ''));
      run.check(`${type} ${ratio}: the engine received the product's own pictures, in order`, sent.join('|') === (type === 'image_transition' ? urls : [urls[0]]).join('|'), sent.length + ' pictures');
      run.check(`${type} ${ratio}: video frames show those pictures (colour match)`, ok && f.colours.join(',') === wantColours, f.colours.join(','), wantColours);
      const asked = req && req.body.aspect_ratio;
      if (ratio === '5:4' && type !== 'lifestyle') {
        run.known(`${type} 5:4: the engine is asked for a 5:4 video`, asked === '5:4', `engine was asked for ${asked}, video is ${gotRatio}`, 'adapter sends 16:9 for 5:4 (videoEngineClient.js lists only 9:16, 16:9, 1:1)');
      } else {
        run.check(`${type} ${ratio}: engine asked for ${ratio} and the video is ${ratio}`, asked === ratio && gotRatio === ratio, `asked ${asked}, video ${gotRatio}`);
      }
      await A.del(`/api/generated/${enc(slot)}/${type}`); // keep one slot at a time
    }
  }
  run.table('Case I: pictures -> request -> video', ['video type', 'asked size', 'engine asked', 'video size', 'sent to engine', 'video frames', 'expected frames'], rows);
  const usage = Number((await stack.db('select count(*)::int as n from usage_events where store_id = $1', [idA]))[0].n);
  run.check('every finished video was charged exactly once', usage === rows.filter((r) => /x/.test(r[3])).length, `${usage} charges for ${rows.length} videos`);

  // ------------------------------------------------------------------ T6 regeneration and image replacement
  run.section('T6', 'Regeneration, version history, replaced pictures');
  const type = 'image_transition';
  const gen = async (extra = {}) => { const g = await generate(A, { uniqueTag: tagA, videoType: type, aspectRatio: '16:9', startImageUrls: urls, ...extra }); if (g.status !== 200) throw new Error('generate ' + g.status + g.text); return finish(A, tagA, type); };
  const before = Number((await stack.db('select count(*)::int as n from usage_events where store_id = $1', [idA]))[0].n);
  const v1 = await gen();
  const f1 = await frames(v1, [0.5]);
  run.check('first generation is ready and shows the red picture first', v1.status === 'ready' && f1.colours[0] === 'red', f1.colours.join(','));
  const second = await A.post('/api/generate', { uniqueTag: tagA, videoType: type, aspectRatio: '16:9', startImageUrls: urls });
  const racing = await A.post('/api/generate', { uniqueTag: tagA, videoType: type, aspectRatio: '16:9', startImageUrls: urls });
  run.check('a second generation while one is running is refused (409), not run twice', second.status === 200 && racing.status === 409, `HTTP ${second.status} then ${racing.status}`);
  const v2s = await finish(A, tagA, type);
  run.check('regeneration produces a new version and charges once more', v2s.versionNo === 2 && Number((await stack.db('select count(*)::int as n from usage_events where store_id = $1', [idA]))[0].n) === before + 2, `version ${v2s.versionNo}`);
  const vers = (await A.get(`/api/generated/${enc(tagA)}/${type}/versions`)).body.versions;
  run.check('history lists both versions', vers.filter((v) => v.status === 'ready').length === 2, vers.map((v) => `${v.versionNo}:${v.status}`).join(','));
  // replace a picture in the store: the NEXT generation must use the new one
  store.setImage('qa-red.jpg', 'magenta');
  const refreshed = await A.post('/api/refresh');
  await stack.engineReset();
  const v3 = await gen();
  const f3 = await frames(v3, [0.5, 2.5]);
  run.check('after the store replaced the first picture (same file name), the new video shows the NEW picture', f3.colours[0] === 'magenta' && f3.colours[1] === 'green', f3.colours.join(','), 'magenta,green');
  const viewed = await imagesOf(A, tagA);
  const r = await fetch(stack.base + viewed[0].displayUrl);
  const seen = media.imageColour(Buffer.from(await r.arrayBuffer())).name;
  run.known('the picker shows the NEW picture after it was replaced in the store (no stale copy)', seen === 'magenta', `picker shows ${seen} (refresh answered ${refreshed.status})`, 'check the /img proxy cache');
  // restore version 1 and check it plays the OLD picture
  const first = vers.find((v) => v.versionNo === 1);
  const restored = await A.post(`/api/generated/${enc(tagA)}/${type}/versions/${first.id}/restore`);
  const now = (await A.get(`/api/status/${enc(tagA)}/${type}`)).body;
  const fr = await frames(now, [0.5]);
  run.check('restoring version 1 shows version 1 again (red first)', restored.status === 200 && now.versionNo === 1 && fr.colours[0] === 'red', `v${now.versionNo} ${fr.colours.join(',')}`);
  store.setImage('qa-red.jpg', 'red');
  const del = await A.del(`/api/generated/${enc(tagA)}/${type}/versions/${vers.find((v) => v.versionNo === 2).id}`);
  run.check('a version can be deleted and then disappears from the history', del.status === 200 && !(await A.get(`/api/generated/${enc(tagA)}/${type}/versions`)).body.versions.some((v) => v.versionNo === 2));
  const other = (await B.get(`/api/status/${enc(await tagOf(B, 0))}/${type}`)).body;
  run.check('another store sees none of these videos', other.status === 'none', other.status);

  // ------------------------------------------------------------------ T7 overlay
  run.section('T7', 'Overlay text: generate, Update Overlay, persistence, isolation');
  const tag2 = await tagOf(A, 1);
  const ov = { ProductName: 'Pears Special', Offer: '10% off today', SalePrice: '$12.00' };
  await stack.engineReset();
  const og = await A.post('/api/generate', { uniqueTag: tag2, videoType: 'hero_product', aspectRatio: '16:9', startImageUrl: (await imagesOf(A, tag2))[0].url, overlayFamily: 'Offer Banner', overlayStyle: 'custom', variableValues: ov });
  const o1 = await finish(A, tag2, 'hero_product');
  const req1 = await lastEngineRequest();
  run.check('hero video with an overlay is generated', og.status === 200 && o1.status === 'ready', `${og.status} ${o1.status}`);
  run.check('the engine received the overlay family and every value typed by the merchant', req1 && req1.body.no_overlay === false && Object.entries(ov).every(([k, v]) => (req1.body.overlay_values || {})[k] === v), JSON.stringify(req1 && req1.body.overlay_values));
  run.check('the overlay values are stored on the version', o1.overlayValues && o1.overlayValues.values && o1.overlayValues.values.Offer === ov.Offer, JSON.stringify(o1.overlayValues));
  const ov2 = { ...ov, Offer: '20% off this week' };
  await stack.engineReset();
  const up = await A.post('/api/update-overlay', { uniqueTag: tag2, videoType: 'hero_product', variableValues: ov2 });
  const o2 = await finish(A, tag2, 'hero_product');
  const req2 = await lastEngineRequest();
  run.check('Update Overlay re-uses the engine project instead of a new generation', up.status === 200 && req2 && req2.body.project_id === o1.projectId, `project ${req2 && req2.body.project_id}`);
  run.check('Update Overlay sends the NEW text', req2 && (req2.body.overlay_values || {}).Offer === ov2.Offer, JSON.stringify(req2 && req2.body.overlay_values));
  run.check('Update Overlay makes a new version holding the new text', o2.versionNo === 2 && o2.overlayValues.values.Offer === ov2.Offer, `v${o2.versionNo}`);
  const again = await connectStoreAgain(A);
  const kept = (await again.get(`/api/status/${enc(tag2)}/hero_product`)).body;
  run.check('after signing in again the overlay text is still there', kept.overlayValues && kept.overlayValues.values.Offer === ov2.Offer, JSON.stringify(kept.overlayValues).slice(0, 80));
  const tagB2 = await tagOf(B, 1);
  const leak = (await B.get(`/api/status/${enc(tagB2)}/hero_product`)).body;
  run.check('another store sees neither the video nor its overlay text', leak.status === 'none' && !JSON.stringify(leak).includes('20% off'), leak.status);
  const noBase = await A.post('/api/update-overlay', { uniqueTag: tagA, videoType: 'hero_product', variableValues: ov });
  run.check('Update Overlay without an existing overlay video is refused with a clear message', noBase.status === 400, `HTTP ${noBase.status} ${String(noBase.body && noBase.body.error).slice(0, 60)}`);
  run.blocked('Overlay text rendered inside the picture (legible, not cut off)', 'the mock engine does not draw overlays; checked by the manual checklist with the real engine');

  // ------------------------------------------------------------------ T8 uploaded images
  run.section('T8', 'Uploaded pictures: valid, too big, wrong type, hostile name');
  const png = require('fs').readFileSync(await makePng('blue'));
  const upload = (body, name, tag = tagA, type = 'application/octet-stream') => fetch(`${stack.base}/api/upload-still-image?uniqueTag=${enc(tag)}${name !== undefined ? '&filename=' + enc(name) : ''}`, { method: 'POST', headers: { Authorization: 'Bearer ' + A.token, 'Content-Type': type, 'Idempotency-Key': 'up-' + Math.random() }, body });
  const ok = await upload(png, 'my photo.png');
  const okJson = await ok.json();
  run.check('a real PNG is accepted and answered with a link', ok.status === 200 && /\/up\//.test(okJson.url || ''), `HTTP ${ok.status}`);
  const served = await fetch(okJson.url);
  run.check('the link serves the same picture with safe headers', served.status === 200 && served.headers.get('content-type') === 'image/png' && served.headers.get('x-content-type-options') === 'nosniff' && media.imageColour(Buffer.from(await served.arrayBuffer())).name === 'blue', `${served.status} ${served.headers.get('content-type')}`);
  const big = await upload(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(15 * 1024 * 1024 + 10)]), 'huge.jpg');
  run.check('a picture over 15 MB is refused (413)', big.status === 413, `HTTP ${big.status}`);
  const txt = await upload(Buffer.from('<script>alert(1)</script> this is not a picture at all'), 'x.png');
  run.check('a non-image renamed .png is refused (415)', txt.status === 415, `HTTP ${txt.status}`);
  const svg = await upload(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'), 'x.svg');
  run.check('an SVG (can carry scripts) is refused (415)', svg.status === 415, `HTTP ${svg.status}`);
  const empty = await upload(Buffer.alloc(0), 'empty.png');
  run.check('an empty upload is refused (400)', empty.status === 400, `HTTP ${empty.status}`);
  const hostile = await upload(png, '../../<script>alert(1)</script>.png');
  const hostileRow = (await stack.db('select filename from uploaded_images order by created_at desc limit 1'))[0];
  run.check('a hostile file name is cleaned before it is stored', hostile.status === 200 && !/[</>\\]/.test(hostileRow.filename), hostileRow.filename);
  const nobody = await fetch(`${stack.base}/api/upload-still-image?uniqueTag=${enc(tagA)}`, { method: 'POST', body: png });
  run.check('uploading without signing in is refused', nobody.status === 401 || nobody.status === 403, `HTTP ${nobody.status}`);
  const missing = await upload(png, 'a.png', 'no-such-product');
  run.check('uploading for a product that does not exist is refused (404)', missing.status === 404, `HTTP ${missing.status}`);
  // the upload as a video frame
  const tag3 = await tagOf(A, 2);
  const mine = [okJson.url, ...(await imagesOf(A, tag3)).map((i) => i.url), (await imagesOf(A, tag3))[0].url, (await imagesOf(A, tag3))[0].url].slice(0, 4);
  await stack.engineReset();
  const ug = await A.post('/api/generate', { uniqueTag: tag3, videoType: 'image_transition', aspectRatio: '16:9', startImageUrls: mine });
  const us = await finish(A, tag3, 'image_transition');
  const uf = us.status === 'ready' ? await frames(us, [0.5, 2.5]) : { colours: [] };
  run.check('an uploaded picture used as frame 1 appears first in the video (blue, then the product picture)', ug.status === 200 && uf.colours[0] === 'blue' && uf.colours[1] === 'cyan', uf.colours.join(',') + ' ' + (us.error || ''), 'blue,cyan');
  const rate = await B.get('/api/billing/status');
  run.check('the second store is unaffected (still Free with no videos)', rate.body.freeVideosUsed === 0, `free videos used ${rate.body.freeVideosUsed}, plan ${rate.body.currentPlan}, usage rows ${(await stack.db('select store_id, count(*)::int as n from usage_events group by store_id order by store_id')).map((r) => `store ${r.store_id}: ${r.n}`).join(', ')}`);

  async function connectStoreAgain(c) { const s = await (await fetch(stack.base + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ launch: c.launch() }) })).json(); const auth = { Authorization: 'Bearer ' + s.token }; return { get: async (p) => { const r = await fetch(stack.base + p, { headers: auth }); return { status: r.status, body: await r.json().catch(() => null) }; } }; }
  async function makePng(colour) { const f = require('path').join(require('os').tmpdir(), `qa-${colour}.png`); require('child_process').execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=0x${store.COLOURS[colour]}:s=800x800`, '-frames:v', '1', f]); return f; }
};
