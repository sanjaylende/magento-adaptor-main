// Server-to-server only (see src/middleware/internalSecret.js). Hands the Magento integration token of an installed store to LTX
// (a separate, internally trusted app), which uses it to call that store's REST API for its own brand/library import. Deliberately the
// ONE place the stored token ever leaves this process, so every hand-out is written to the audit log.
const tenants = require("../services/tenantService");
const audit = require("../services/auditService");
const logger = require("../utils/logger");

// A store that is not installed, is suspended or uninstalled, or has no stored token all answer the same: it needs (re)connecting.
const NOT_INSTALLED = { error: "not_installed" };

async function magentoToken(req, res) {
  res.set("Cache-Control", "no-store");
  const { shop } = req.params;
  try {
    const installation = await tenants.getActiveInstallationByHost(shop);
    const accessToken = installation && installation.magentoToken;
    if (!installation || !accessToken) return res.status(404).json(NOT_INSTALLED);
    await audit.record({ actorType: "system", actorId: "ltx", installationId: installation.id, action: "internal.magento_token_issued", ip: req.ip });
    // The token is a Magento integration access token: send it as "Authorization: Bearer <accessToken>" to `{baseUrl}/rest/<apiVersion>/...`.
    res.json({ baseUrl: installation.baseUrl, accessToken, apiVersion: "V1" });
  } catch (err) {
    logger.error("Internal token lookup failed:", err.message, { requestId: req.id });
    res.status(404).json(NOT_INSTALLED);
  }
}

module.exports = { magentoToken };
