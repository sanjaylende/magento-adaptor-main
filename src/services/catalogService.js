// Magento product catalog: fetches products through Magento's REST API and shapes them for the UI; also builds the per-
// product attribute options the modal's Custom overlay picker offers.
const { fetchAllProducts, fetchConfigurableChildren, fetchProductBySku, fetchAttributeMetadata } = require("../integrations/magentoClient");
const { normalizeProducts, findCustomAttribute } = require("../utils/normalize");
const { formatMoney } = require("../utils/money");
const { VIDEO_URL_ATTRIBUTE, VIDEO_THUMBNAIL_ATTRIBUTE } = require("../config/constants");

// Resolves a raw custom_attributes value to a human label when the
// attribute is select/multiselect-typed (option ids -> labels), or returns
// it as-is otherwise (text/price/boolean/...). Cached per attribute code
// (Map supplied by the caller) so a bulk refresh only fetches each
// attribute's metadata/options once, not once per product.
async function resolveAttributeValue(baseUrl, accessToken, attributeCode, rawValue, attributeCache) {
  if (rawValue == null || rawValue === "") return null;

  if (!attributeCache.has(attributeCode)) {
    const metadata = await fetchAttributeMetadata(baseUrl, accessToken, attributeCode).catch(() => null);
    attributeCache.set(attributeCode, metadata);
  }
  const metadata = attributeCache.get(attributeCode);
  if (!metadata || !["select", "multiselect", "boolean"].includes(metadata.frontend_input)) {
    return String(rawValue);
  }

  const options = metadata.options || [];
  const labelFor = (value) => {
    const match = options.find((o) => String(o.value) === String(value));
    return match ? match.label : null;
  };
  if (metadata.frontend_input === "multiselect") {
    return String(rawValue)
      .split(",")
      .map((v) => labelFor(v))
      .filter(Boolean)
      .join(", ");
  }
  return labelFor(rawValue) || String(rawValue);
}

// Per-product I/O normalize.js's normalizeProducts() delegates to: resolves
// a configurable product's first simple child (mirrors Shopify's
// variants[0]) and the category attribute's value/label. Kept out of
// normalize.js itself so that module stays pure data-shaping, same split
// magentoClient.js/normalize.js and shopifyClient.js/normalize.js both keep.
async function resolveProductForNormalize(product, { baseUrl, accessToken, categoryAttributeCode, mediaBaseUrl, attributeCache }) {
  let child = null;
  if (product.type_id === "configurable") {
    const children = await fetchConfigurableChildren(baseUrl, accessToken, product.sku).catch(() => []);
    child = (children && children[0]) || null;
  }
  const rawCategory = findCustomAttribute(product, categoryAttributeCode);
  const category = await resolveAttributeValue(baseUrl, accessToken, categoryAttributeCode, rawCategory, attributeCache);
  return { child, category, mediaBaseUrl };
}

async function fetchProducts(baseUrl, accessToken, options = {}) {
  const categoryAttributeCode = options.categoryAttributeCode || "product_type";
  const mediaBaseUrl = options.mediaBaseUrl || baseUrl;
  const attributeCache = new Map();

  const raw = await fetchAllProducts(baseUrl, accessToken, options);
  return normalizeProducts(
    raw,
    (product) => resolveProductForNormalize(product, { baseUrl, accessToken, categoryAttributeCode, mediaBaseUrl, attributeCache }),
    { currencyCode: options.currencyCode, websiteId: options.websiteId }
  );
}

// The built-in attribute catalog the modal's per-variable value picker
// always offers, on top of whichever Product Metafields that specific
// product has (see getProductAttributeOptions below) -- e.g. Size/Fit/Color
// for a t-shirt, which aren't fields this app knows about ahead of time.
const CUSTOM_ATTRIBUTE_OPTIONS = [
  { key: "productName", label: "Product Name" },
  { key: "category", label: "Category" },
  { key: "price", label: "Price" },
  { key: "mrp", label: "MRP" },
  { key: "offer", label: "Offer" },
];

function customAttributeValue(product, key) {
  switch (key) {
    case "productName": return product.name;
    case "category": return product.category;
    case "price": return formatMoney(product.price, product.currencyCode);
    case "mrp": return product.offer ? formatMoney(product.offer.originalPrice, product.currencyCode) : "";
    case "offer": return product.offer ? `${product.offer.discountPercent}% off` : "";
    default: return "";
  }
}

function humanizeAttributeCode(code) {
  return code.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// Attribute codes already surfaced via the fixed catalog above, or that are
// this app's own internal bookkeeping (the video attributes, the category
// attribute itself), or long WYSIWYG text -- excluded from the
// custom_attributes-derived list below so the picker isn't cluttered with
// duplicates/noise.
function excludedAttributeCodes(categoryAttributeCode) {
  return new Set([categoryAttributeCode, "special_price", "description", "short_description", VIDEO_URL_ATTRIBUTE, VIDEO_THUMBNAIL_ATTRIBUTE]);
}

// Builds the modal's per-product Custom overlay picker options: the fixed
// catalog above (computed for THIS product) plus whatever of this product's
// own Magento custom attributes have a value (e.g. Size/Color) -- the only
// way to surface those, since they're merchant-defined per catalog and this
// app has no schema for them. Not fetched during the bulk product Refresh
// (fetchProducts above) -- this is called on-demand only when a specific
// product's modal actually opens the Custom picker, same as Shopify's
// per-product metafields fetch was.
async function getProductAttributeOptions(product, { baseUrl, accessToken, categoryAttributeCode }) {
  const fixed = CUSTOM_ATTRIBUTE_OPTIONS
    .map((opt) => ({ key: opt.key, label: opt.label, value: customAttributeValue(product, opt.key) }))
    .filter((opt) => opt.value !== "");

  let customOptions = [];
  try {
    const raw = await fetchProductBySku(baseUrl, accessToken, product.magentoSku);
    const excluded = excludedAttributeCodes(categoryAttributeCode || "product_type");
    const attributeCache = new Map();
    const attrs = (raw.custom_attributes || []).filter((a) => !excluded.has(a.attribute_code));
    const resolved = await Promise.all(
      attrs.map(async (a) => ({
        key: `attribute:${a.attribute_code}`,
        label: humanizeAttributeCode(a.attribute_code),
        value: (await resolveAttributeValue(baseUrl, accessToken, a.attribute_code, a.value, attributeCache)) || "",
      }))
    );
    customOptions = resolved.filter((opt) => opt.value !== "");
  } catch {
    // Best-effort -- the Custom picker still works with the fixed catalog
    // above if the live product/attributes can't be fetched.
  }

  return [...fixed, ...customOptions];
}
module.exports = { fetchProducts, getProductAttributeOptions };
