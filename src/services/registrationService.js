// Onboarding of a Magento installation: the extension presents a working Magento integration token, which proves the caller
// controls that store; the adapter then reads the store's websites, creates the merchant/installation/stores and hands back
// the install key and secret (shown once).
const dns = require("dns").promises;
const net = require("net");
const config = require("../config");
const tenants = require("./tenantService");
const { magentoRequest } = require("../integrations/magentoClient");

const httpError = (status, message) => Object.assign(new Error(message), { status, userMessage: message });

function normaliseBaseUrl(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    throw httpError(400, "baseUrl is not a valid URL");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw httpError(400, "baseUrl must be http or https");
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

const isPrivateAddress = (ip) =>
  net.isIP(ip) === 4
    ? /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(ip)
    : /^(::1$|fc|fd|fe80)/i.test(ip);

// In production the adapter must not be usable to probe internal networks (the store URL is caller-supplied).
async function assertPublicHost(baseUrl) {
  if (!config.isProduction) return;
  const { hostname } = new URL(baseUrl);
  const addresses = net.isIP(hostname) ? [{ address: hostname }] : await dns.lookup(hostname, { all: true });
  if (addresses.some((a) => isPrivateAddress(a.address))) throw httpError(400, "Store URL must be publicly reachable");
}

// Websites of the store with their base currency, read with the merchant's own token.
async function fetchWebsites(baseUrl, token) {
  const [websites, configs] = await Promise.all([
    magentoRequest(`${baseUrl}/rest/V1/store/websites`, token),
    magentoRequest(`${baseUrl}/rest/V1/store/storeConfigs`, token).catch(() => []),
  ]);
  const currencyByWebsite = new Map();
  for (const c of configs || []) if (!currencyByWebsite.has(String(c.website_id))) currencyByWebsite.set(String(c.website_id), c.base_currency_code);
  return (websites || [])
    .filter((w) => String(w.id) !== "0") // 0 is Magento's internal "admin" website
    .map((w) => ({ id: String(w.id), code: w.code, name: w.name, baseCurrency: currencyByWebsite.get(String(w.id)) || "USD" }));
}

async function register({ baseUrl, magentoToken, merchantName, contactEmail, countryCode, magentoVersion, extensionVersion }) {
  if (!baseUrl || !magentoToken) throw httpError(400, "baseUrl and magentoToken are required");
  const url = normaliseBaseUrl(baseUrl);
  await assertPublicHost(url);
  let websites;
  try {
    websites = await fetchWebsites(url, magentoToken);
  } catch (err) {
    throw httpError(400, `Could not read the Magento store with the supplied token: ${err.message}`);
  }
  if (!websites.length) throw httpError(400, "The Magento store reported no websites");
  const creds = await tenants.registerInstallation({ baseUrl: url, magentoToken, merchantName, contactEmail, countryCode, magentoVersion, extensionVersion });
  const stores = await tenants.syncStores(creds.installationId, websites);
  return { installKey: creds.installKey, secret: creds.secret, stores: stores.map((s) => ({ websiteId: s.externalId, code: s.code, name: s.name })) };
}

async function resync(installation) {
  const websites = await fetchWebsites(installation.baseUrl, installation.magentoToken);
  const stores = await tenants.syncStores(installation.id, websites);
  return stores.map((s) => ({ websiteId: s.externalId, code: s.code, name: s.name }));
}

module.exports = { register, resync, normaliseBaseUrl };
