// In-memory product cache over each store's Magento catalog (cheap to refetch with the Refresh button).
const { currentStoreId } = require("../db/connection");
const { tenant } = require("../context");
const { fetchProducts } = require("./catalogService");

const byStore = new Map(); // storeId -> { products, syncedAt }

const entry = () => {
  const id = currentStoreId();
  if (!byStore.has(id)) byStore.set(id, { products: [], syncedAt: null });
  return byStore.get(id);
};

async function refreshProducts() {
  const { magento } = tenant();
  const e = entry();
  e.products = await fetchProducts(magento.baseUrl, magento.accessToken, magento);
  e.syncedAt = new Date().toISOString();
  return e.products;
}

const list = () => entry().products;
const syncedAt = () => entry().syncedAt;
const findProduct = (uniqueTag) => entry().products.find((p) => p.uniqueTag === uniqueTag);

module.exports = { refreshProducts, list, syncedAt, findProduct };
