// Talks to Magento's Admin REST API (`{baseUrl}/rest/V1/...`) using a static
// Integration access token (`Authorization: Bearer`, created once via
// Magento Admin -> System -> Integrations -> Activate). No OAuth exchange,
// no session storage -- same "static credential in env" pattern as the
// Shopify version's X-Shopify-Access-Token, just a different header shape.
//
// Everything here is plain REST -- Magento has no equivalent of Shopify's
// media-mutation-only GraphQL surface, so unlike shopifyClient.js there's no
// GraphQL client at all.

const logger = require("../utils/logger");
const { safeFetch } = require("../utils/safeFetch");

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_TIMEOUT_MS = 30000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Every failure of a Magento call is a MagentoApiError: status 0 = network/timeout, otherwise the HTTP status. The message
// format is unchanged ("Magento API request failed (401): ...") because callers and the UI show it.
class MagentoApiError extends Error {
  constructor(message, { status = 0, retriable = false, cause } = {}) {
    super(message);
    this.name = "MagentoApiError";
    this.status = status;
    this.retriable = retriable;
    if (cause) this.cause = cause;
  }
}

async function magentoRequest(url, accessToken, { method = "GET", body, maxRetries = DEFAULT_MAX_RETRIES, timeoutMs = DEFAULT_TIMEOUT_MS, sleepImpl = sleep } = {}) {
  const target = new URL(url);
  const safeUrl = `${target.origin}${target.pathname}`; // no query string in logs
  for (let attempt = 0; ; attempt++) {
    const startedAt = Date.now();
    let res;
    try {
      res = await safeFetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // An address the adapter refuses to call (private network, plain http in production, ...) is a final answer, not a glitch.
      if (err && (err.name === "OutboundError" || err.name === "BlockedAddressError" || (err.cause && err.cause.name === "BlockedAddressError"))) {
        logger.warn(`Magento ${method} ${safeUrl} refused`, { reason: err.cause?.message || err.message });
        throw new MagentoApiError(`Store address is not allowed: ${err.cause?.message || err.message}`, { status: 400, cause: err });
      }
      // Network failure or timeout: safe to retry a read; a write may or may not have run, so it is reported instead.
      const timedOut = err && (err.name === "TimeoutError" || err.name === "AbortError");
      const willRetry = method === "GET" && attempt < maxRetries;
      logger.warn(`Magento ${method} ${safeUrl} ${timedOut ? "timed out" : "network error"}`, { attempt, willRetry, error: err.message });
      if (willRetry) { await sleepImpl(2 ** attempt * 1000 * (0.75 + Math.random() * 0.5)); continue; }
      throw new MagentoApiError(`Magento API request failed (${timedOut ? "timeout" : "network error"}): ${err.cause?.message || err.message}`, { retriable: true, cause: err });
    }

    // Magento doesn't send Retry-After -- back off exponentially (with jitter), same backstop shopifyClient.js uses.
    if ((res.status === 429 || res.status === 503) && attempt < maxRetries) {
      const wait = 2 ** attempt * 1000 * (0.75 + Math.random() * 0.5);
      logger.warn(`Magento ${method} ${safeUrl} -> ${res.status}, retrying`, { attempt: attempt + 1, waitMs: Math.round(wait) });
      await res.arrayBuffer().catch(() => {});
      await sleepImpl(wait);
      continue;
    }

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      logger.error(`Magento ${method} ${safeUrl} -> ${res.status}`, { message: errBody.message, ms: Date.now() - startedAt });
      throw new MagentoApiError(`Magento API request failed (${res.status}): ${errBody.message || JSON.stringify(errBody) || url}`, { status: res.status, retriable: res.status === 429 || res.status >= 502 });
    }

    logger.debug(`Magento ${method} ${safeUrl} -> ${res.status}`, { ms: Date.now() - startedAt, attempt });
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
  MagentoApiError,
  magentoRequest,
  fetchAllProducts,
  fetchConfigurableChildren,
  fetchProductBySku,
  fetchAttributeMetadata,
  fetchAttributeOptions,
  updateProductAttributes,
};
