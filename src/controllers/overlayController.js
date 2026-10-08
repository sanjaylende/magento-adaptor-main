// Overlay family catalog and preview images.
const { Readable } = require("stream");
const config = require("../config");
const { tenant } = require("../context");
const logger = require("../utils/logger");
const productService = require("../services/productService");
const { getProductAttributeOptions } = require("../services/catalogService");
const { listOverlayFamilies, getOverlayFamilyPreview } = require("../services/overlayService");

// Overlay catalog for the modal's Overlay Family picker (one shared catalog regardless of video type).
async function families(req, res) {
  try {
    res.json({ families: await listOverlayFamilies(req.query.aspectRatio, config.flipick) });
  } catch (err) {
    res.status(502).json({ error: err.message, families: [] });
  }
}

// Proxies a family's preview PNG (the API key stays server-side), personalised with the product's own attributes.
async function preview(req, res) {
  const aspectRatio = req.query.aspectRatio;
  if (!aspectRatio) return res.status(400).json({ error: "aspectRatio query param is required" });
  let productAttributes;
  if (req.query.uniqueTag) {
    try {
      const product = productService.findProduct(req.query.uniqueTag);
      if (product) {
        const options = await getProductAttributeOptions(product, tenant().magento);
        productAttributes = Object.fromEntries(options.map((o) => [o.key, o.value]));
      }
    } catch {
      productAttributes = undefined; // preview still works without personalisation
    }
  }
  try {
    const upstream = await getOverlayFamilyPreview({
      baseUrl: config.flipick.videoEngineBaseUrl, apiKey: config.flipick.videoEngineApiKey,
      familyName: req.params.name, aspectRatio, retailerName: config.flipick.retailerName, productAttributes,
    });
    res.set("Content-Type", "image/png");
    res.set("Cache-Control", "no-store");
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (err) {
    logger.error("Failed to fetch overlay family preview:", err.message, { family: req.params.name, aspectRatio });
    res.status(502).json({ error: "Couldn't load a preview for this overlay — try again" });
  }
}

module.exports = { families, preview };
