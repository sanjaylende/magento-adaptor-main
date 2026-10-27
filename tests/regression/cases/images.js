/* global openModal, cancelModal -- these run inside the browser page (page.evaluate) */
// T12 Products with several images (the catalogue of a real Magento store has many photos per product): the adapter lists all of them in order
// (the first four go into the Image Transitions picker, the rest stay reachable through Change Image), serves each one through its signed image
// link, handles a gallery of 7, of 25 and of one, and a photo uploaded for the product is offered again, for that product only.
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

  // ---- a product with 7 images, one with 25 (the same seven again and again), one with a single image
  store.setGallery(1, all7);
  store.setGallery(2, ['qa-magenta.jpg']);
  store.setGallery(3, Array.from({ length: 25 }, (_, i) => all7[i % 7]));
  run.check('catalog refresh after the galleries changed', (await refresh()) === 200);
  const seven = await tagOf('Apples'), one = await tagOf('Pears'), many = await tagOf('Mangoes');
  const list7 = (await c.get('/api/product-images/' + encodeURIComponent(seven))).body.images || [];
  run.check('a product with 7 images lists all 7, in the store\'s order', list7.length === 7 && list7.every((i) => i.source === 'real' && /^\/img\//.test(i.displayUrl) && /^https?:\/\//.test(i.url)), `${list7.length} images`);
  run.check('the listed addresses end with the files in the store\'s order', list7.map((i) => i.url.split('/').pop()).join(',') === all7.join(','), list7.map((i) => i.url.split('/').pop()).join(','));
  const bytes = [];
  for (const img of list7) {
    const r = await fetch(stack.base + img.displayUrl);
    bytes.push(r.status === 200 && /^image\//.test(r.headers.get('content-type') || '') ? sha(Buffer.from(await r.arrayBuffer())) : `HTTP ${r.status}`);
  }
  run.check('each of the 7 images is served through its signed link, and they are 7 different pictures', bytes.every((b) => /^[0-9a-f]{64}$/.test(b)) && new Set(bytes).size === 7, bytes.map((b) => b.slice(0, 6)).join(' '));
  run.check('a product with one image lists exactly one', ((await c.get('/api/product-images/' + encodeURIComponent(one))).body.images || []).length === 1);
  const listMany = (await c.get('/api/product-images/' + encodeURIComponent(many))).body.images || [];
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
    await openPicker(seven);
    const real = () => page.locator('.modal .preview-tile[data-source="real"]');
    run.check('the Image Transitions picker offers the product\'s first four photos', (await real().count()) === 4, `${await real().count()} real tiles`);
    await page.screenshot({ path: path.join(out, 'picker-7-images.png') });
    // Change Image on the first tile offers the other three
    await real().first().hover();
    await real().first().locator('.tile-overlay-btn').click();
    await page.waitForSelector('.tile-overlay-picker .tile-overlay-pick', { timeout: 15000 });
    const others = await page.locator('.tile-overlay-picker .tile-overlay-pick').count();
    run.check('Change Image offers the 3 photos that are not in the picker yet', others === 3, `${others} offered`);
    await page.screenshot({ path: path.join(out, 'change-image-3-others.png') });
    await page.locator('.tile-overlay-picker .tile-overlay-pick').nth(2).click();
    await page.waitForTimeout(500);
    const srcs = await page.locator('.modal .preview-tile[data-source="real"] img').evaluateAll((els) => els.map((e) => e.getAttribute('src')));
    run.check('picking another photo replaces that tile, still four tiles, no duplicates', srcs.length === 4 && new Set(srcs).size === 4, `${srcs.length} tiles, ${new Set(srcs).size} different`);
    // upload a photo for this product
    await page.setInputFiles('input[type=file]', { name: 'my-own.png', mimeType: 'image/png', buffer: PNG }).catch(() => {});
    await page.waitForTimeout(1500);
    const tagged = await page.locator('.modal .tile-tag', { hasText: 'Uploaded' }).count();
    run.check('an uploaded photo shows as a tile tagged Uploaded', tagged === 1, `${tagged} tagged tiles`);
    await page.evaluate(() => { if (typeof cancelModal === 'function') cancelModal(); });
    await page.waitForTimeout(500);
    await openPicker(seven);
    run.check('opened again for the same product: the uploaded photo is offered again (after the four store photos)', (await page.locator('.modal .tile-tag', { hasText: 'Uploaded' }).count()) === 1);
    await page.evaluate(() => { if (typeof cancelModal === 'function') cancelModal(); });
    await page.waitForTimeout(500);
    await openPicker(one);
    run.check('another product does not get that upload', (await page.locator('.modal .tile-tag', { hasText: 'Uploaded' }).count()) === 0 && (await real().count()) === 1, `${await real().count()} real tile(s)`);
    await page.evaluate(() => { if (typeof cancelModal === 'function') cancelModal(); });
    await page.waitForTimeout(500);
    await openPicker(many);
    run.check('a product with 25 photos shows four tiles, not a wall of pictures', (await real().count()) === 4, `${await real().count()} real tiles`);
    run.check('no page errors while using the picker with many images', problems.length === 0, problems.join(' | '));
  } finally {
    await browser.close();
  }
};
