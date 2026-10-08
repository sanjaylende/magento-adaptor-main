// Talks to Magento's Admin REST API (`{baseUrl}/rest/V1/...`) using a static
// Integration access token (`Authorization: Bearer`, created once via
// Magento Admin -> System -> Integrations -> Activate). No OAuth exchange,
// no session storage -- same "static credential in env" pattern as the
// Shopify version's X-Shopify-Access-Token, just a different header shape.
//
// Everything here is plain REST -- Magento has no equivalent of Shopify's
// media-mutation-only GraphQL surface, so unlike shopifyClient.js there's no
// GraphQL client at all.

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_RETRIES = 5;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function magentoRequest(url, accessToken, { method = "GET", body, maxRetries = DEFAULT_MAX_RETRIES } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    // Magento doesn't send Retry-After -- back off exponentially, same
    // backstop shopifyClient.js falls back to when Shopify omits it too.
    if ((res.status === 429 || res.status === 503) && attempt < maxRetries) {
      await sleep(2 ** attempt * 1000);
      continue;
    }

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(`Magento API request failed (${res.status}): ${errBody.message || JSON.stringify(errBody) || url}`);
    }

    return res.status === 204 ? null : res.json();
  }
}

// Page-number pagination (searchCriteria[pageSize]/[currentPage]) -- Magento
// has no Link-header cursor like Shopify's products.json. Loops until a page
// comes back shorter than pageSize, so this handles catalogs of any size.
// Each returned item already includes `custom_attributes` and
// `media_gallery_entries` inline -- unlike Shopify's metafields, no separate
// per-product call is needed just to list the catalog.
async function fetchAllProducts(baseUrl, accessToken, options = {}) {
  const pageSize = options.pageSize || DEFAULT_PAGE_SIZE;
  const products = [];

  for (let currentPage = 1; ; currentPage++) {
    const url = `${baseUrl}/rest/V1/products?searchCriteria[pageSize]=${pageSize}&searchCriteria[currentPage]=${currentPage}`;
    const body = await magentoRequest(url, accessToken, options);
    const items = body.items || [];
    products.push(...items);
    if (items.length < pageSize) break;
  }

  return products;
}

// Only called for type_id === "configurable" products during normalization,
// to resolve the first simple child's price/image (mirrors Shopify's
// variants[0] behavior). Magento's flat /V1/products listing doesn't embed
// a configurable's children -- this is a genuinely separate call, same as
// Shopify's per-product metafields fetch is for a different reason.
async function fetchConfigurableChildren(baseUrl, accessToken, sku, options = {}) {
  const url = `${baseUrl}/rest/V1/configurable-products/${encodeURIComponent(sku)}/children`;
  return magentoRequest(url, accessToken, options); // [{ id, sku, price, custom_attributes, media_gallery_entries, ... }]
}

// Fetches one product's full record by sku, including its live
// custom_attributes -- used on-demand only (e.g. when a specific product's
// Custom-overlay picker modal opens), not during bulk catalog listing, same
// as Shopify's per-product metafields call.
async function fetchProductBySku(baseUrl, accessToken, sku, options = {}) {
  const url = `${baseUrl}/rest/V1/products/${encodeURIComponent(sku)}`;
  return magentoRequest(url, accessToken, options);
}

// Attribute metadata (frontend_input: "select"/"multiselect"/"text"/...) --
// needed to know whether a custom_attributes value is a raw string or an
// option id (or comma-separated option ids) that needs label resolution.
async function fetchAttributeMetadata(baseUrl, accessToken, attributeCode, options = {}) {
  const url = `${baseUrl}/rest/V1/products/attributes/${encodeURIComponent(attributeCode)}`;
  return magentoRequest(url, accessToken, options); // { attribute_code, frontend_input, options: [...], ... }
}

// Some attribute metadata responses already embed `options` (see above) --
// this is kept as its own call for callers that only have the attribute code
// and want the label list without the rest of the metadata payload.
async function fetchAttributeOptions(baseUrl, accessToken, attributeCode, options = {}) {
  const url = `${baseUrl}/rest/V1/products/attributes/${encodeURIComponent(attributeCode)}/options`;
  return magentoRequest(url, accessToken, options); // [{ label, value }]
}

// Writes one or more custom attributes on a product by SKU. Magento merges
// custom_attributes by attribute_code on save -- this can push just the 1-2
// attributes this app cares about without first fetching and re-sending the
// product's full attribute set.
async function updateProductAttributes(baseUrl, accessToken, sku, attributes, options = {}) {
  const url = `${baseUrl}/rest/V1/products/${encodeURIComponent(sku)}`;
  const customAttributes = Object.entries(attributes).map(([attribute_code, value]) => ({ attribute_code, value: value ?? "" }));
  return magentoRequest(url, accessToken, {
    ...options,
    method: "PUT",
    body: { product: { sku, custom_attributes: customAttributes } },
  });
}

module.exports = {
  magentoRequest,
  fetchAllProducts,
  fetchConfigurableChildren,
  fetchProductBySku,
  fetchAttributeMetadata,
  fetchAttributeOptions,
  updateProductAttributes,
};
