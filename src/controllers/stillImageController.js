// The Image Transitions / Hero Product stills picker's photo sources:
//   GET  /api/product-images/:uniqueTag   the product's own real photos (loaded only when the merchant reaches that step)
//   POST /api/upload-still-image          a photo uploaded from the merchant's computer, hosted by the adapter itself
//   GET  /up/:token                       public, signed, short-lived link the video engine (and the browser) fetch an upload from
//
// Uploads are kept in PostgreSQL (bytea, per store, row-level security) and deleted after 8 days by the scheduler. They are NOT
// added to the store's own gallery. Only real raster images are accepted (type checked from the file's first bytes, never from
// the name or the declared Content-Type), at most 15 MB, 100 per store per day.
const config = require("../config");
const logger = require("../utils/logger");
const { tenant } = require("../context");
const { query, asSystem } = require("../db/connection");
const { signToken, verifyToken } = require("../utils/crypto");
const productService = require("../services/productService");
const { proxiedImageUrl } = require("./imageController");

const LINK_TTL_SECONDS = 7 * 24 * 3600;
const DAILY_LIMIT = 100;

// File type from the first bytes: JPEG, PNG, GIF, WebP.
function sniffImageType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  if (buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

const cleanName = (raw) => String(raw || "still").replace(/^.*[\\/]/, "").replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "still";

// { url, displayUrl, source: "real" }: `url` is what the video engine receives (the real photo), `displayUrl` what the browser shows
// (through the /img proxy, so it loads whatever scheme or host the store serves photos from).
async function productImages(req, res) {
  const product = productService.findProduct(req.params.uniqueTag);
  if (!product) return res.status(404).json({ error: "Product not found — try Refresh", images: [] });
  const urls = [...new Set((product.images && product.images.length ? product.images : (product.image ? [product.image] : [])).filter(Boolean))];
  res.json({ images: urls.map((url) => ({ url, displayUrl: proxiedImageUrl(url), source: "real" })) });
}

async function uploadStill(req, res) {
  const product = productService.findProduct(req.query.uniqueTag);
  if (!product) return res.status(404).json({ error: "Product not found — try Refresh" });
  const data = req.body;
  if (!Buffer.isBuffer(data) || !data.length) return res.status(400).json({ error: "No image data received" });
  const type = sniffImageType(data);
  if (!type) return res.status(415).json({ error: "Only JPEG, PNG, GIF or WebP images can be uploaded" });
  const storeId = tenant().store.id;
  try {
    const { rows: [recent] } = await query("SELECT count(*)::int AS n FROM uploaded_images WHERE created_at > now() - interval '1 day'");
    if (recent.n >= DAILY_LIMIT) return res.status(429).json({ error: `Upload limit reached (${DAILY_LIMIT} images a day). Try again tomorrow.` });
    const { rows: [row] } = await query(
      "INSERT INTO uploaded_images (store_id, filename, content_type, data) VALUES ($1, $2, $3, $4) RETURNING id",
      [storeId, cleanName(req.query.filename), type, data]
    );
    const path = `/up/${signToken({ typ: "up", id: row.id }, LINK_TTL_SECONDS)}`;
    logger.info("Still image uploaded", { storeId, bytes: data.length, type });
    res.json({ url: `${config.publicBaseUrl}${path}`, displayUrl: path });
  } catch (err) {
    logger.error("Could not store an uploaded image", { requestId: req.id, error: err });
    res.status(500).json({ error: "Couldn't save the image. Please try again." });
  }
}

// Public: the signed token is the whole credential. Locked down so an uploaded file can only ever be shown as an image.
async function serve(req, res) {
  const claims = verifyToken(req.params.token);
  if (!claims || claims.typ !== "up") return res.status(404).end();
  try {
    const { rows: [row] } = await asSystem(() => query("SELECT content_type, data FROM uploaded_images WHERE id = $1", [claims.id]));
    if (!row) return res.status(404).end();
    res.set({
      "Content-Type": row.content_type,
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
      "Content-Disposition": "inline",
    });
    res.send(row.data);
  } catch (err) {
    logger.error("Could not serve an uploaded image", { requestId: req.id, error: err });
    res.status(500).end();
  }
}

module.exports = { productImages, uploadStill, serve, sniffImageType };
