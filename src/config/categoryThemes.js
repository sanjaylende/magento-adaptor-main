// Mirrors LTX's backend/src/api/video-engine/category-registry.js pattern —
// a plain, hardcoded, category-keyed config object, not a DB table. This is
// the Magento port of the Shopify adapter's categoryThemeRegistry.js: same
// mechanism, keys re-curated against whatever values the
// MAGENTO_CATEGORY_ATTRIBUTE_CODE attribute actually holds on this store's
// catalog (Magento's analogue of Shopify's product_type field).
//
// An unmapped category is a hard error, never a silent fallback — same
// convention as the Shopify version — so a product from a category nobody's
// configured yet doesn't quietly get generated under the wrong campaign feel.

const CATEGORY_THEME_REGISTRY = {
  // Keys are the option labels of the Magento product attribute named by MAGENTO_CATEGORY_ATTRIBUTE_CODE
  // (here: product_type, a dropdown holding each grocery product's category). Themes mirror the Shopify
  // adapter's grocery registry.
  "Fruits": "Fresh Produce",
  "Vegetables": "Fresh Produce",
  "Dairy & Eggs": "Dairy Fresh",
  "Bakery": "Bakery Fresh",
  "Pantry": "Pantry Staples",
  "Beverages": "Refreshing Beverages",
  "Snacks": "General Retail",
  // Fitfolk apparel website (product_type options created by docker/seed_fitfolk.php).
  "T-Shirts": "Apparel Fashion",
  "Hoodies & Sweatshirts": "Apparel Fashion",
  "Jeans & Trousers": "Apparel Fashion",
  "Jackets": "Apparel Fashion",
  "Activewear": "Apparel Fashion",
  "Footwear": "Footwear Fashion",
  "Accessories": "Apparel Fashion",
  // Jewellery website of the second Magento instance (product_type options created by Magento-Instance2/seed).
  "Rings": "Luxury Jewellery",
  "Necklaces": "Luxury Jewellery",
  "Earrings": "Luxury Jewellery",
  "Bracelets": "Luxury Jewellery",
  "Pendants": "Luxury Jewellery",
  "Watches": "Luxury Watches",
  "Uncategorized": "General Retail",
};

function getThemeForCategory(category) {
  const theme = CATEGORY_THEME_REGISTRY[category];
  if (!theme) {
    throw new Error(
      `No VVP theme registered for category "${category}" — add one to CATEGORY_THEME_REGISTRY in categoryThemeRegistry.js`
    );
  }
  return theme;
}

module.exports = { CATEGORY_THEME_REGISTRY, getThemeForCategory };
