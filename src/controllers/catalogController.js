// Product catalog endpoints: refresh from Magento, per-product attribute options and the default prompt.
const config = require("../config");
const logger = require("../utils/logger");
const { tenant } = require("../context");
const productService = require("../services/productService");
const { getProductAttributeOptions } = require("../services/catalogService");
const { getPromptDefault } = require("../services/videoEngineService");
const { refreshGeneratedVideoUrls } = require("../services/videoUrlService");
const generatedState = require("../services/generatedState");
const { VIDEO_TYPES, STATUS } = require("../config/constants");

// Per-type summary of a product's current videos, for list views (the Magento admin grid reads this).
function videoSummary(uniqueTag) {
  const videos = {};
  let lastGeneratedAt = null;
  for (const type of Object.keys(VIDEO_TYPES)) {
    const g = generatedState.get(generatedState.genKey(uniqueTag, type));
    if (!g || [STATUS.CANDIDATES, STATUS.EXPIRED].includes(g.status)) continue;
    videos[type] = {
      status: g.status, versionNo: g.versionNo, progressPct: g.progressPct,
      error: g.error, pushedToMagento: g.pushedToMagento, staleFromLtxEdit: g.staleFromLtxEdit, updatedAt: g.updatedAt,
    };
    if (!lastGeneratedAt || g.updatedAt > lastGeneratedAt) lastGeneratedAt = g.updatedAt;
  }
  return { videos, lastGeneratedAt };
}

// JSON product list: catalog fields + video summary per product.
async function list(req, res) {
  if (productService.list().length === 0 || req.query.refresh === "1") {
    try {
      await productService.refreshProducts();
    } catch (err) {
      logger.error("Catalog load failed", { requestId: req.id, error: err });
      return res.status(502).json({ error: err.message, products: [] });
    }
  }
  await refreshGeneratedVideoUrls();
  res.json({
    syncedAt: productService.syncedAt(),
    products: productService.list().map((p) => ({
      uniqueTag: p.uniqueTag, sku: p.magentoSku, name: p.name, category: p.category, price: p.price,
      currencyCode: p.currencyCode, image: p.image, updatedAt: p.updatedAt, ...videoSummary(p.uniqueTag),
    })),
  });
}

async function refresh(req, res) {
  try {
    await productService.refreshProducts();
    await refreshGeneratedVideoUrls();
    res.json({ ok: true, count: productService.list().length });
  } catch (err) {
    logger.error("Catalog refresh failed", { requestId: req.id, error: err });
    res.status(502).json({ error: err.message });
  }
}

// The modal's per-variable value picker: fixed attributes (name, category, price ...) plus the product's own Magento
// custom attributes, with resolved values.
async function productAttributes(req, res) {
  const product = productService.findProduct(req.params.uniqueTag);
  if (!product) return res.status(404).json({ error: "Product not found — try Refresh", options: [] });
  try {
    res.json({ options: await getProductAttributeOptions(product, tenant().magento) });
  } catch (err) {
    logger.warn("Could not read product attribute options", { requestId: req.id, uniqueTag: req.params.uniqueTag, error: err.message });
    res.status(502).json({ error: err.message, options: [] });
  }
}

async function promptDefault(req, res) {
  const { uniqueTag, videoType } = req.body || {};
  const product = productService.findProduct(uniqueTag);
  if (!product) return res.status(404).json({ error: "Product not found — try Refresh" });
  try {
    res.json({ prompt: await getPromptDefault(product, videoType, config.flipick) });
  } catch (err) {
    logger.warn("Could not build the default prompt", { requestId: req.id, error: err.message });
    res.status(502).json({ error: err.message });
  }
}

module.exports = { list, refresh, productAttributes, promptDefault };
