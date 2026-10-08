// Initial data for the embedded UI: store, products, current videos, plan and usage. Replaces the data that used to be
// inlined into the page, since the page itself is now a public shell and data requires a session.
const { tenant } = require("../context");
const logger = require("../utils/logger");
const { CURRENCY_SYMBOLS } = require("../utils/money");
const productService = require("../services/productService");
const generatedState = require("../services/generatedState");
const billing = require("../services/billingService");
const { refreshGeneratedVideoUrls } = require("../services/videoUrlService");
const { query } = require("../db/connection");
const { proxiedImageUrl } = require("./imageController");

async function bootstrap(req, res) {
  const { store, installation } = tenant();
  if (productService.list().length === 0) {
    try {
      await productService.refreshProducts();
    } catch (err) {
      logger.error("Initial Magento product fetch failed -- rendering an empty list (use Refresh):", err.message);
    }
  }
  await refreshGeneratedVideoUrls();
  const { rows: [merchant] } = await query("SELECT country_code FROM merchants WHERE id = $1", [installation.merchantId]);
  res.json({
    currencySymbols: CURRENCY_SYMBOLS,
    // Photos go through /img so they load whatever scheme or host Magento serves them from; imageSource keeps the real URL.
    products: productService.list().map((p) => ({ ...p, imageSource: p.image, image: proxiedImageUrl(p.image), images: (p.images || []).map(proxiedImageUrl) })),
    generated: generatedState.all(),
    storeUrl: `${installation.baseUrl} · ${store.name}`,
    syncedAt: productService.syncedAt(),
    billing: await billing.snapshot(merchant && merchant.country_code),
  });
}

module.exports = { bootstrap };
