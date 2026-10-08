// Merchants, installations and stores: registration, lookup and per-store Magento connection settings.
const config = require("../config");
const logger = require("../utils/logger");
const { query, tx, asSystem } = require("../db/connection");
const { encrypt, decrypt, randomToken } = require("../utils/crypto");
const eav = require("../db/eav/EavRepository");
const StoreSetting = require("../models/StoreSetting");
const audit = require("./auditService");

const CACHE_MS = 30 * 1000;
const installationCache = new Map(); // install_key -> { at, value }

const httpError = (status, message) => Object.assign(new Error(message), { status, userMessage: message });

function mapInstallation(row) {
  return {
    id: row.id, merchantId: row.merchant_id, baseUrl: row.base_url, installKey: row.install_key,
    secret: decrypt(row.secret_enc), magentoToken: row.magento_token_enc ? decrypt(row.magento_token_enc) : null,
    status: row.status, magentoVersion: row.magento_version, extensionVersion: row.extension_version,
  };
}

const mapStore = (row) => ({
  id: row.id, installationId: row.installation_id, externalId: row.external_id, code: row.code, name: row.name,
  baseCurrency: row.base_currency.trim(), status: row.status,
});

// Looks up an installation by its public key (cached briefly: it is read on every signed request).
async function getInstallationByKey(installKey) {
  const hit = installationCache.get(installKey);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const { rows: [row] } = await query("SELECT * FROM installations WHERE install_key = $1", [installKey]);
  const value = row ? mapInstallation(row) : null;
  installationCache.set(installKey, { at: Date.now(), value });
  return value;
}

const invalidateInstallation = (installKey) => installationCache.delete(installKey);

async function getInstallation(id) {
  const { rows: [row] } = await query("SELECT * FROM installations WHERE id = $1", [id]);
  return row ? mapInstallation(row) : null;
}

async function getStore(installationId, externalId) {
  const { rows: [row] } = await query("SELECT * FROM stores WHERE installation_id = $1 AND external_id = $2", [installationId, String(externalId)]);
  return row ? mapStore(row) : null;
}

async function getStoreById(id) {
  const { rows: [row] } = await query("SELECT * FROM stores WHERE id = $1", [id]);
  return row ? mapStore(row) : null;
}

async function listStores(installationId) {
  const { rows } = await query("SELECT * FROM stores WHERE installation_id = $1 AND status = 'active' ORDER BY id", [installationId]);
  return rows.map(mapStore);
}

// Creates or updates the stores (Magento websites) of an installation, and the trial subscription of each new one.
// websites: [{ id, code, name, baseCurrency }]. Websites no longer reported are marked removed (data is kept).
async function syncStores(installationId, websites) {
  return asSystem(() => tx(async () => {
    const seen = [];
    for (const w of websites) {
      const externalId = String(w.id);
      seen.push(externalId);
      const { rows: [store] } = await query(
        `INSERT INTO stores (installation_id, external_id, code, name, base_currency)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (installation_id, external_id)
         DO UPDATE SET code = EXCLUDED.code, name = EXCLUDED.name, base_currency = EXCLUDED.base_currency, status = 'active'
         RETURNING id`,
        [installationId, externalId, w.code || externalId, w.name || w.code || `Website ${externalId}`, (w.baseCurrency || "USD").toUpperCase().slice(0, 3)]
      );
      await query("INSERT INTO store_subscriptions (store_id) VALUES ($1) ON CONFLICT (store_id) DO NOTHING", [store.id]);
    }
    await query("UPDATE stores SET status = 'removed' WHERE installation_id = $1 AND NOT (external_id = ANY($2::text[]))", [installationId, seen]);
    return listStores(installationId);
  }));
}

// Creates a merchant + installation (or re-registers an existing base URL, rotating its credentials) and returns the
// credentials once. The caller has already proven control of the Magento store by presenting a working token.
async function registerInstallation({ baseUrl, magentoToken, merchantName, contactEmail, countryCode, magentoVersion, extensionVersion }) {
  const installKey = `fk_${randomToken(12)}`;
  const secret = randomToken(32);
  return asSystem(() => tx(async () => {
    const { rows: [existing] } = await query("SELECT id, merchant_id, install_key FROM installations WHERE base_url = $1", [baseUrl]);
    let installationId;
    let merchantId;
    if (existing) {
      installationId = existing.id;
      merchantId = existing.merchant_id;
      await query(
        `UPDATE installations SET install_key = $2, secret_enc = $3, magento_token_enc = $4, magento_version = $5, extension_version = $6,
                status = 'active', uninstalled_at = NULL, last_seen_at = now() WHERE id = $1`,
        [installationId, installKey, encrypt(secret), encrypt(magentoToken), magentoVersion || null, extensionVersion || null]
      );
      invalidateInstallation(existing.install_key);
    } else {
      const { rows: [merchant] } = await query(
        "INSERT INTO merchants (name, contact_email, country_code) VALUES ($1, $2, $3) RETURNING id",
        [merchantName || baseUrl, contactEmail || null, countryCode ? countryCode.toUpperCase().slice(0, 2) : null]
      );
      merchantId = merchant.id;
      const { rows: [inst] } = await query(
        `INSERT INTO installations (merchant_id, base_url, install_key, secret_enc, magento_token_enc, magento_version, extension_version, last_seen_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now()) RETURNING id`,
        [merchantId, baseUrl, installKey, encrypt(secret), encrypt(magentoToken), magentoVersion || null, extensionVersion || null]
      );
      installationId = inst.id;
    }
    await audit.record({ actorType: "merchant", merchantId, installationId, action: existing ? "installation.reregistered" : "installation.registered", after: { baseUrl } });
    return { installationId, merchantId, installKey, secret };
  }));
}

async function touchInstallation(id, fields = {}) {
  await asSystem(() => query(
    "UPDATE installations SET last_seen_at = now(), magento_version = COALESCE($2, magento_version), extension_version = COALESCE($3, extension_version) WHERE id = $1",
    [id, fields.magentoVersion || null, fields.extensionVersion || null]
  ));
}

async function markUninstalled(installation) {
  await asSystem(async () => {
    await query("UPDATE installations SET status = 'uninstalled', uninstalled_at = now() WHERE id = $1", [installation.id]);
    await audit.record({ actorType: "merchant", merchantId: installation.merchantId, installationId: installation.id, action: "installation.uninstalled" });
  });
  invalidateInstallation(installation.installKey);
}

// Per-store Magento connection: the installation's base URL and token, plus the store's tunable settings (EAV).
async function magentoConfigFor(installation, store) {
  const settings = await getStoreSettings(store.id);
  return {
    baseUrl: installation.baseUrl,
    accessToken: installation.magentoToken,
    websiteId: store.externalId,
    categoryAttributeCode: settings.categoryAttributeCode || config.legacyMagento.categoryAttributeCode,
    mediaBaseUrl: (settings.mediaBaseUrl || installation.baseUrl).replace(/\/+$/, ""),
    currencyCode: settings.currencyCode || store.baseCurrency,
  };
}

async function getStoreSettings(storeId) {
  const entity = await eav.findOne(StoreSetting.entityType, { storeId });
  return entity ? entity.values : {};
}

async function saveStoreSettings(storeId, values) {
  const entity = await eav.findOne(StoreSetting.entityType, { storeId });
  if (entity) await eav.update(StoreSetting.entityType, entity.id, values);
  else await eav.create(StoreSetting.entityType, values, { storeId });
}

module.exports = {
  httpError, getInstallationByKey, getInstallation, getStore, getStoreById, listStores, syncStores,
  registerInstallation, touchInstallation, markUninstalled, magentoConfigFor, getStoreSettings, saveStoreSettings,
};
