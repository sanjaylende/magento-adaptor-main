/* global openModal, cancelModal -- these run inside the browser page (page.evaluate) */
// T12 Products with several images (the catalogue of a real Magento store has many photos per product): the adapter lists all of them in order
// (the first four go into the Image Transitions picker, the rest stay reachable through Change Image), serves each one through its signed image
// link, handles a gallery of 7, of 25 and of one, and a photo uploaded for the product is offered again, for that product only.
// Photos uploaded by earlier cases of the same run are allowed: only the store's own photos are counted exactly, uploads are counted relatively.
// Needs Playwright like T11. Uses the fake store's seven colour images (solid colours, so every picture is told apart by its bytes).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function loadPlaywright() {
  const tries = [() => require('playwright-core'), () => require(path.join(process.env.PLAYWRIGHT_DIR || '', 'node_modules', 'playwright-core')), () => require('D:/Magento-Vanilla/docker/uitest/node_modules/playwright-core')];
  for (const t of tries) { try { return t(); } catch { /* next */ } }
  return null;
}
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
// a tiny but valid PNG (1x1) for the upload
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

module.exports = async function images({ stack, run, connectStore, reportDir }) {
  run.section('T12', 'Products with several images: listing, image links, picker, Change Image, uploads');
  const store = stack.store;
  const all7 = ['qa-red.jpg', 'qa-green.jpg', 'qa-blue.jpg', 'qa-yellow.jpg', 'qa-magenta.jpg', 'qa-cyan.jpg', 'qa-orange.jpg'];
  const c = await connectStore(stack, { name: 'Images Store' });
  const refresh = async () => (await c.post('/api/refresh', {})).status;
  const tagOf = async (name) => ((await c.get('/api/products')).body.products.find((p) => p.name === name) || {}).uniqueTag;
  const listing = async (tag) => (await c.get('/api/product-images/' + encodeURIComponent(tag))).body.images || [];
  const storeOnly = (list) => list.filter((i) => !i.uploaded);
  const uploadedOnly = (list) => list.filter((i) => i.uploaded);

  // ---- a product with 7 images, one with 25 (the same seven again and again), one with a single image
  store.setGallery(1, all7);
  store.setGallery(2, ['qa-magenta.jpg']);
  store.setGallery(3, Array.from({ length: 25 }, (_, i) => all7[i % 7]));
  run.check('catalog refresh after the galleries changed', (await refresh()) === 200);
  const seven = await tagOf('Apples'), one = await tagOf('Pears'), many = await tagOf('Mangoes');
  const full7 = await listing(seven);
  const list7 = storeOnly(full7);
  const uploaded7 = uploadedOnly(full7).length; // photos other cases of this run uploaded for the same product (0 on a fresh run)
  run.check('a product with 7 images lists all 7 of the store\'s photos, in the store\'s order', list7.length === 7 && list7.every((i) => i.source === 'real' && /^\/img\//.test(i.displayUrl) && /^https?:\/\//.test(i.url)), `${list7.length} store photos, ${uploaded7} uploaded earlier`);
  run.check('the listed addresses end with the files in the store\'s order', list7.map((i) => i.url.split('/').pop()).join(',') === all7.join(','), list7.map((i) => i.url.split('/').pop()).join(','));
  const bytes = [];
  for (const img of list7) {
    const r = await fetch(stack.base + img.displayUrl);
    bytes.push(r.status === 200 && /^image\//.test(r.headers.get('content-type') || '') ? sha(Buffer.from(await r.arrayBuffer())) : `HTTP ${r.status}`);
  }
  run.check('each of the 7 images is served through its signed link, and they are 7 different pictures', bytes.every((b) => /^[0-9a-f]{64}$/.test(b)) && new Set(bytes).size === 7, bytes.map((b) => b.slice(0, 6)).join(' '));
  const oneBefore = await listing(one);
  run.check('a product with one image lists exactly one of the store\'s photos', storeOnly(oneBefore).length === 1);
  const listMany = storeOnly(await listing(many));
  run.check('a product with 25 images lists them all without error', listMany.length >= 7 && listMany.length <= 25, `${listMany.length} images (repeats of the same address may be collapsed)`);
  const boot = (await c.get('/api/bootstrap')).body;
  const bp = boot.products.find((p) => p.uniqueTag === seven);
  run.check('the catalog the page loads carries the 7 images and shows the first as the product picture', bp && bp.images.length === 7 && bp.image === bp.images[0], bp ? `${bp.images.length} images` : 'product missing');
  run.check('every picture of the catalog goes to the browser through the adapter image link', bp && bp.images.every((u) => /^\/img\//.test(u)), bp ? bp.images.slice(0, 2).join(' ') : '');

  // ---- the picker in a browser
  const pw = loadPlaywright();
  if (!pw) { run.blocked('picker with 7 images', 'Playwright is not installed (see docs/testing/HOW-TO-RUN.md)'); return; }
  const out = path.join(reportDir, 'images'); fs.mkdirSync(out, { recursive: true });
  const browser = await pw.chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', headless: true });
  try {
    const page = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
    const problems = [];
    page.on('pageerror', (e) => problems.push(e.message.slice(0, 120)));
    page.on('dialog', (d) => d.dismiss());
    await page.goto(`${stack.base}/?embed=1&launch=${encodeURIComponent(c.launch())}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#rows tr', { timeout: 60000 });
    const openPicker = async (tag) => {
      await page.evaluate((t) => openModal(t, 'image_transition'), tag);
      await page.waitForSelector('#submitBtn', { timeout: 30000 });
      await page.locator('#submitBtn').click();
      await page.waitForSelector('#productImagesRoot .preview-tile[data-source="real"]', { timeout: 30000 });
      await page.waitForTimeout(800);
    };
    const closePicker = async () => { await page.evaluate(() => { if (typeof cancelModal === 'function') cancelModal(); }); await page.waitForTimeout(500); };
    const storeTiles = () => page.locator('.modal .preview-tile[data-source="real"]:not(:has(.tile-tag))');
    const tagged = () => page.locator('.modal .tile-tag', { hasText: 'Uploaded' });
    await openPicker(seven);
    run.check('the Image Transitions picker offers the product\'s first four store photos', (await storeTiles().count()) === 4, `${await storeTiles().count()} store tiles`);
    run.check('photos uploaded earlier for this product are in the picker too, tagged Uploaded (at most four)', (await tagged().count()) === Math.min(uploaded7, 4), `${await tagged().count()} tagged, ${uploaded7} exist`);
    await page.screenshot({ path: path.join(out, 'picker-7-images.png') });
    // Change Image on the first store tile offers the three store photos that are not in the picker (and any upload beyond the four shown)
    await storeTiles().first().hover();
    await storeTiles().first().locator('.tile-overlay-btn').click();
    await page.waitForSelector('.tile-overlay-picker .tile-overlay-pick', { timeout: 15000 });
    const others = await page.locator('.tile-overlay-picker .tile-overlay-pick').count();
    run.check('Change Image offers the 3 store photos that are not in the picker yet, and no photo that is already in it', others === 3 + Math.max(0, uploaded7 - 4), `${others} offered, ${uploaded7} uploaded exist`);
    await page.screenshot({ path: path.join(out, 'change-image-3-others.png') });
    await page.locator('.tile-overlay-picker .tile-overlay-pick').nth(2).click();
    await page.waitForTimeout(500);
    const srcs = await page.locator('.modal .preview-tile[data-source="real"] img').evaluateAll((els) => els.map((e) => e.getAttribute('src')));
    run.check('picking another photo replaces that tile: the same number of tiles, no duplicates', srcs.length === 4 + Math.min(uploaded7, 4) && new Set(srcs).size === srcs.length, `${srcs.length} tiles, ${new Set(srcs).size} different`);
    // upload a photo for this product
    await page.setInputFiles('input[type=file]', { name: 'my-own.png', mimeType: 'image/png', buffer: PNG }).catch(() => {});
    await page.waitForTimeout(1500);
    run.check('an uploaded photo shows as one more tile tagged Uploaded', (await tagged().count()) === Math.min(uploaded7, 4) + 1, `${await tagged().count()} tagged tiles`);
    await closePicker();
    await openPicker(seven);
    run.check('opened again for the same product: the uploaded photo is offered again (the newest uploads, at most four)', (await tagged().count()) === Math.min(uploaded7 + 1, 4), `${await tagged().count()} tagged`);
    await closePicker();
    await openPicker(one);
    const uploadedOneNow = uploadedOnly(await listing(one)).length;
    run.check('another product does not get that upload', uploadedOneNow === uploadedOnly(oneBefore).length && (await storeTiles().count()) === 1, `${uploadedOneNow} uploads, ${await storeTiles().count()} store tile(s)`);
    await closePicker();
    await openPicker(many);
    run.check('a product with 25 photos shows four store tiles, not a wall of pictures', (await storeTiles().count()) === 4, `${await storeTiles().count()} store tiles`);
    run.check('no page errors while using the picker with many images', problems.length === 0, problems.join(' | '));
  } finally {
    await browser.close();
  }
};
