// Endpoints the Magento extension calls to register and maintain its installation (server to server).
const logger = require("../utils/logger");
const registration = require("../services/registrationService");
const tenants = require("../services/tenantService");
const { encrypt, randomToken } = require("../utils/crypto");
const { query, asSystem } = require("../db/connection");
const audit = require("../services/auditService");

// Public (rate limited by IP). Proof of control is the Magento token itself, checked against the store.
async function register(req, res) {
  try {
    res.status(201).json(await registration.register(req.body || {}));
  } catch (err) {
    // 4xx = the caller's problem (bad URL, rejected token): a warning. Anything else is ours: an error with the stack.
    const status = err.status || 500;
    if (status >= 500) logger.error("Registration failed", { requestId: req.id, baseUrl: req.body && req.body.baseUrl, error: err });
    else logger.warn("Registration refused", { requestId: req.id, baseUrl: req.body && req.body.baseUrl, status, reason: err.message });
    res.status(status).json({ error: err.userMessage || "Registration failed", requestId: req.id });
  }
}

// Signed. Re-reads the store's websites (new ones start on the free trial).
async function syncStores(req, res) {
  try {
    res.json({ stores: await registration.resync(req.installation) });
  } catch (err) {
    logger.warn("Store re-sync failed", { requestId: req.id, installationId: req.installation.id, error: err.message });
    res.status(502).json({ error: `Could not read the Magento store: ${err.message}` });
  }
}

// Signed. Issues a new secret; the old one stops working immediately.
async function rotateSecret(req, res) {
  const secret = randomToken(32);
  await asSystem(() => query("UPDATE installations SET secret_enc = $2 WHERE id = $1", [req.installation.id, encrypt(secret)]));
  tenants.invalidateInstallation(req.installation.installKey);
  await audit.record({ actorType: "merchant", merchantId: req.installation.merchantId, installationId: req.installation.id, action: "installation.secret_rotated" });
  res.json({ secret });
}

// Signed. The extension was uninstalled or disabled for good. Data is kept; the installation stops being served.
async function uninstall(req, res) {
  await tenants.markUninstalled(req.installation);
  logger.info("Installation uninstalled", { installationId: req.installation.id });
  res.json({ ok: true });
}

// Signed. Cheap check the extension uses to show "connected".
async function ping(req, res) {
  await tenants.touchInstallation(req.installation.id, { magentoVersion: req.body && req.body.magentoVersion, extensionVersion: req.body && req.body.extensionVersion });
  res.json({ ok: true, stores: (await tenants.listStores(req.installation.id)).map((s) => ({ websiteId: s.externalId, name: s.name })) });
}

module.exports = { register, syncStores, rotateSecret, uninstall, ping };
