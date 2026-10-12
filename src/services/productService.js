// In-memory product cache over each store's Magento catalog (cheap to refetch with the Refresh button).
const { currentStoreId } = require("../db/connection");
const { tenant } = require("../context");
const { fetchProducts } = require("./catalogService");
const logger = require("../utils/logger");
const videoVersions = require("../repositories/VideoVersionRepository");
const generatedState = require("./generatedState");

const byStore = new Map(); // storeId -> { products, syncedAt }

const entry = () => {
  const id = currentStoreId();
  if (!byStore.has(id)) byStore.set(id, { products: [], syncedAt: null });
  return byStore.get(id);
};

// The stable identity of a product across refreshes (its uniqueTag is not: it follows the variant that supplies the price).
const identityOf = (p) => p.wooProductId || p.magentoSku || p.sku;

// After a refresh, a product whose uniqueTag changed keeps its videos: its slots are moved to the new tag.
async function remapChangedTags(before, after) {
  const oldTags = new Map(before.map((p) => [identityOf(p), p.uniqueTag]));
  for (const p of after) {
    const oldTag = oldTags.get(identityOf(p));
    if (!oldTag || oldTag === p.uniqueTag) continue;
    try {
      const moved = await videoVersions.remapUniqueTag(oldTag, p.uniqueTag);
      for (const videoType of moved) generatedState.rename(generatedState.genKey(oldTag, videoType), generatedState.genKey(p.uniqueTag, videoType));
      if (moved.length) logger.info("Product tag changed: its videos were kept", { from: oldTag, to: p.uniqueTag, videoTypes: moved });
    } catch (err) {
      logger.warn("Could not carry a product's videos over to its new tag", { from: oldTag, to: p.uniqueTag, error: err.message });
    }
  }
}

async function refreshProducts() {
  const { magento } = tenant();
  const e = entry();
  const fresh = await fetchProducts(magento.baseUrl, magento.accessToken, magento);
  await remapChangedTags(e.products, fresh);
  e.products = fresh;
  e.syncedAt = new Date().toISOString();
  return e.products;
}

const list = () => entry().products;
const syncedAt = () => entry().syncedAt;
const findProduct = (uniqueTag) => entry().products.find((p) => p.uniqueTag === uniqueTag);

module.exports = { refreshProducts, list, syncedAt, findProduct };
