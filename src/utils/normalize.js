const DEFAULT_CATEGORY = "Uncategorized";

function discountPercent(price, originalPrice) {
  if (price == null || originalPrice == null || originalPrice <= 0) return null;
  return Math.round(((originalPrice - price) / originalPrice) * 10000) / 100;
}

// media_gallery_entries[].file is a relative path under Magento's product
// media directory (e.g. "/m/y/shirt.jpg", meaning
// pub/media/catalog/product/m/y/shirt.jpg on disk) -- build the public URL
// against mediaBaseUrl (defaults to MAGENTO_BASE_URL, overridable via
// MAGENTO_MEDIA_BASE_URL for a store behind a CDN). Returns every gallery
// image, not just the first, so the modal's source-image picker has all of
// them to choose from -- pickImage (below) keeps returning just the first,
// for callers that only ever wanted a single thumbnail.
function pickImages(product, mediaBaseUrl) {
  const entries = product.media_gallery_entries;
  if (!Array.isArray(entries)) return [];
  return entries.filter((e) => e.file).map((e) => `${mediaBaseUrl}/media/catalog/product${e.file}`);
}

function pickImage(product, mediaBaseUrl) {
  return pickImages(product, mediaBaseUrl)[0] || null;
}

function findCustomAttribute(product, code) {
  const attrs = product.custom_attributes || [];
  const found = attrs.find((a) => a.attribute_code === code);
  return found ? found.value : null;
}

// `child` is the resolved first simple child for a configurable product
// (null for a plain simple product) -- mirrors Shopify's variants[0]: price/
// special_price are sourced from the child when present, but `magentoSku`
// always stays the PARENT's own sku. That's deliberate: the generated video
// must land on the page a shopper actually visits (the configurable's own
// product page), never the invisible simple child.
//
// Magento's price semantics are the mirror image of Shopify's: `price` is
// the regular/original price, and a separate `special_price` custom
// attribute (if set and lower) is the actual discounted selling price --
// opposite of Shopify's variant.price (current) vs compare_at_price
// (original).
function normalizeProduct(product, child, { category, mediaBaseUrl, currencyCode }) {
  const priceSource = child || product;
  const regularPrice = priceSource.price != null ? Number(priceSource.price) : null;
  const specialRaw = findCustomAttribute(priceSource, "special_price");
  const specialPrice = specialRaw != null && specialRaw !== "" ? Number(specialRaw) : null;
  const hasOffer = specialPrice != null && regularPrice != null && specialPrice < regularPrice;

  return {
    uniqueTag: `magento-${product.id}-${child?.id ?? "novariant"}`,
    magentoSku: product.sku,
    name: product.name,
    category: category || DEFAULT_CATEGORY,
    image: pickImage(product, mediaBaseUrl),
    images: pickImages(product, mediaBaseUrl),
    price: hasOffer ? specialPrice : regularPrice,
    // Every price on a Magento store is in its base currency -- stamped per product (like the Shopify adapter does) so
    // the UI and the overlay text format it with the right symbol instead of assuming "$".
    currencyCode: currencyCode || "USD",
    // Magento's own last-modified time ("YYYY-MM-DD HH:MM:SS", UTC) -> ISO, for the list's "Recently updated" sort.
    updatedAt: product.updated_at ? new Date(String(product.updated_at).replace(" ", "T") + "Z").toISOString() : null,
    offer: hasOffer
      ? { originalPrice: regularPrice, discountPercent: discountPercent(specialPrice, regularPrice) }
      : null,
  };
}

// Only Enabled (status 1) products visible somewhere on the storefront
// (visibility !== 1, Magento's "Not Visible Individually") reach video
// generation -- this also naturally excludes a configurable's own simple
// children (Magento marks those Not Visible Individually by convention)
// from appearing as duplicate standalone rows alongside their parent.
//
// resolveProduct(product) is supplied by the caller (src/index.js) -- it
// performs the actual I/O this module deliberately stays free of: fetching a
// configurable's children, and resolving the category attribute's raw value
// to a human label via Magento's attribute-options API (with caching). That
// mirrors the split shopifyClient.js/normalize.js already keep between plain
// HTTP and pure data-shaping.
//
// Filtering on a resolved, non-null price happens AFTER normalization (not
// before, like Shopify's variants[0].price != null check) because for a
// configurable product the real price only becomes known once its child has
// been resolved.
async function normalizeProducts(magentoProducts, resolveProduct, { currencyCode, websiteId } = {}) {
  // A store (Magento website) only sees the products assigned to it; products that report no website ids are kept.
  const inWebsite = (p) => {
    const ids = p.extension_attributes && p.extension_attributes.website_ids;
    return !websiteId || !Array.isArray(ids) || ids.length === 0 || ids.map(String).includes(String(websiteId));
  };
  const eligible = magentoProducts.filter((p) => p.status === 1).filter((p) => p.visibility !== 1).filter(inWebsite);

  const normalized = [];
  for (const product of eligible) {
    const { child, category, mediaBaseUrl } = await resolveProduct(product);
    normalized.push(normalizeProduct(product, child, { category, mediaBaseUrl, currencyCode }));
  }
  return normalized.filter((p) => p.price != null);
}

module.exports = { normalizeProducts, normalizeProduct, discountPercent, findCustomAttribute, pickImage, pickImages };
