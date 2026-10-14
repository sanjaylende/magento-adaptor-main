// A fake Magento or WooCommerce store for the regression suite: REST answers like the real ones for what the adapters call, products with
// SEVERAL real images (solid colours, so a video frame can be matched to its source by colour), and the image files themselves are served.
// Controls for tests: setImage(file, colour) replaces an image's bytes, setGallery(sku, [files]) changes a product's images, hits() counts image
// downloads, puts() lists what the adapter wrote back (the video URL on the product).
// Needs ffmpeg (makes the colour images once). Listens on 127.0.0.1 only.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const COLOURS = { red: 'E02020', green: '20B020', blue: '2040E0', yellow: 'F0D020', magenta: 'D020D0', cyan: '20D0D0', orange: 'F08020' };

function makeImage(dir, colour, size = '1200x1200') {
  const file = path.join(dir, `${colour}-${size}.jpg`);
  if (!fs.existsSync(file)) execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=0x${COLOURS[colour]}:s=${size}`, '-frames:v', '1', file]);
  return fs.readFileSync(file);
}

async function startFakeStore({ platform, port, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-store-')) }) {
  fs.mkdirSync(dir, { recursive: true });
  // image name -> colour name (the bytes are made from the colour; setImage changes the mapping)
  const files = { 'qa-red.jpg': 'red', 'qa-green.jpg': 'green', 'qa-blue.jpg': 'blue', 'qa-yellow.jpg': 'yellow', 'qa-magenta.jpg': 'magenta', 'qa-cyan.jpg': 'cyan', 'qa-orange.jpg': 'orange' };
  const hits = {};
  const puts = [];
  const gallery = { 1: ['qa-red.jpg', 'qa-green.jpg', 'qa-blue.jpg', 'qa-yellow.jpg'], 2: ['qa-magenta.jpg'], 3: ['qa-cyan.jpg', 'qa-red.jpg'] };
  const names = { 1: 'Apples', 2: 'Pears', 3: 'Mangoes' };
  const meta = {}; // per product: video url / thumbnail written by the adapter
  const origin = () => `http://127.0.0.1:${port}`;

  const magentoProduct = (id) => ({
    id, sku: `SKU-${id}`, name: names[id], status: 1, visibility: 4, price: 10 + id, type_id: 'simple', extension_attributes: { website_ids: [1] },
    custom_attributes: [{ attribute_code: 'product_type', value: 'Fruits' }, ...Object.entries(meta[id] || {}).map(([attribute_code, value]) => ({ attribute_code, value }))],
    media_gallery_entries: gallery[id].map((f, i) => ({ id: i + 1, file: `/q/${f}`, position: i + 1, disabled: false, types: i === 0 ? ['image', 'small_image', 'thumbnail'] : [] })),
    updated_at: '2026-10-01 10:00:00',
  });
  const wooProduct = (id) => ({
    id: 10 + id, sku: `SKU-${id}`, name: names[id], status: 'publish', type: 'simple', catalog_visibility: 'visible', price: String(10 + id), regular_price: String(10 + id), sale_price: '',
    categories: [{ id: 5, name: 'Fruits', slug: 'fruits' }], images: gallery[id].map((f, i) => ({ id: i + 1, src: `${origin()}/wp-content/uploads/${f}` })),
    attributes: [], meta_data: Object.entries(meta[id] || {}).map(([key, value]) => ({ key, value })), date_modified_gmt: '2026-10-01T10:00:00',
  });

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, origin());
    u.pathname = u.pathname.replace(/^\/site-[a-z0-9]+(?=\/)/, ''); // /site-<name>/... is the same store under another address: a separate installation in the adapter
    const send = (code, body, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
    // ---- image files (public, no auth)
    const m = /^\/(?:media\/catalog\/product\/q|wp-content\/uploads)\/(qa-[a-z]+\.jpg)$/.exec(u.pathname);
    if (m) { hits[m[1]] = (hits[m[1]] || 0) + 1; const colour = files[m[1]]; if (!colour) { res.writeHead(404); return res.end(); } const buf = makeImage(dir, colour); res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': buf.length }); return res.end(buf); }
    // ---- test controls
    if (u.pathname === '/_hits') return send(200, hits);
    if (u.pathname === '/_puts') return send(200, puts);
    if (u.pathname === '/_gallery') return send(200, gallery);
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? (() => { try { return JSON.parse(raw); } catch { return {}; } })() : {};
      if (platform === 'magento') {
        if (req.headers.authorization !== 'Bearer good-token') return send(401, { message: "The consumer isn't authorized to access %resources." });
        if (u.pathname === '/rest/V1/store/websites') return send(200, [{ id: 0, code: 'admin', name: 'Admin' }, { id: 1, code: 'base', name: 'Main Website' }]);
        if (u.pathname === '/rest/V1/store/storeConfigs') return send(200, [{ website_id: 1, base_currency_code: 'USD' }]);
        if (u.pathname === '/rest/V1/products' && req.method === 'GET') return send(200, { items: [1, 2, 3].map(magentoProduct), total_count: 3 });
        if (u.pathname.startsWith('/rest/V1/products/attributes/')) return send(404, { message: 'no such attribute' });
        const one = /^\/rest\/V1\/products\/([^/]+)$/.exec(u.pathname);
        if (one && req.method === 'PUT') { const id = Number(decodeURIComponent(one[1]).replace('SKU-', '')); const attrs = ((body.product || {}).custom_attributes) || []; meta[id] = meta[id] || {}; attrs.forEach((a) => { meta[id][a.attribute_code] = a.value; }); puts.push({ sku: decodeURIComponent(one[1]), attributes: Object.fromEntries(attrs.map((a) => [a.attribute_code, a.value])) }); return send(200, { sku: decodeURIComponent(one[1]) }); }
        return send(404, { message: `unexpected ${u.pathname}` });
      }
      // WooCommerce
      const basic = req.headers.authorization === `Basic ${Buffer.from('good-key:good-secret').toString('base64')}`;
      const query = u.searchParams.get('consumer_key') === 'good-key' && u.searchParams.get('consumer_secret') === 'good-secret';
      // OAuth 1.0a requests (what the adapter sends over https) are accepted by key only: the signature itself is covered by the adapter's unit tests
      const oauth = u.searchParams.get('oauth_consumer_key') === 'good-key';
      if (!basic && !query && !oauth) return send(401, { code: 'woocommerce_rest_cannot_view', message: 'Sorry, you cannot list resources.', data: { status: 401 } });
      const api = '/wp-json/wc/v3';
      if (u.pathname === `${api}/system_status`) return send(200, { environment: { version: '9.9.5', wp_version: '6.7', site_url: origin() }, settings: { currency: 'USD' } });
      if (u.pathname === `${api}/products` && req.method === 'GET') { const page = Number(u.searchParams.get('page') || 1); return send(200, page === 1 ? [1, 2, 3].map(wooProduct) : [], { 'X-WP-Total': '3', 'X-WP-TotalPages': '1' }); }
      if (u.pathname === `${api}/products/batch` && req.method === 'POST') { (body.update || []).forEach((p) => { const id = p.id - 10; meta[id] = meta[id] || {}; (p.meta_data || []).forEach((x) => { meta[id][x.key] = x.value; }); puts.push({ id: p.id, meta: Object.fromEntries((p.meta_data || []).map((x) => [x.key, x.value])) }); }); return send(200, { update: (body.update || []).map((p) => ({ id: p.id })) }); }
      const one = new RegExp(`^${api}/products/(\\d+)$`).exec(u.pathname);
      if (one && req.method === 'PUT') { const id = Number(one[1]) - 10; meta[id] = meta[id] || {}; (body.meta_data || []).forEach((x) => { meta[id][x.key] = x.value; }); puts.push({ id: Number(one[1]), meta: Object.fromEntries((body.meta_data || []).map((x) => [x.key, x.value])) }); return send(200, { id: Number(one[1]) }); }
      send(404, { code: 'rest_no_route', message: `unexpected ${u.pathname}` });
    });
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    url: origin(), port, dir, platform,
    hits: () => ({ ...hits }), resetHits: () => { for (const k of Object.keys(hits)) delete hits[k]; },
    puts: () => puts.slice(),
    gallery: (id) => gallery[id].slice(),
    setGallery: (id, list) => { gallery[id] = list.slice(); },
    setImage: (file, colour) => { files[file] = colour; }, // the same file name now serves another picture
    addImage: (file, colour) => { files[file] = colour; },
    colourOf: (file) => files[file],
    colourRGB: (colour) => [0, 2, 4].map((i) => parseInt(COLOURS[colour].slice(i, i + 2), 16)),
    COLOURS,
    productName: (id) => names[id],
    close: () => new Promise((r) => server.close(r)),
  };
}
module.exports = { startFakeStore, COLOURS };
