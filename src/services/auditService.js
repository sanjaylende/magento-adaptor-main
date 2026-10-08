// Append-only audit trail: plan changes, payments, refunds, credential changes, staff actions.
const { query } = require("../db/connection");
const logger = require("../utils/logger");

async function record({ actorType, actorId = null, merchantId = null, installationId = null, storeId = null, action, before = null, after = null, ip = null }) {
  try {
    await query(
      `INSERT INTO audit_log (actor_type, actor_id, merchant_id, installation_id, store_id, action, before_state, after_state, ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [actorType, actorId && String(actorId), merchantId, installationId, storeId, action, before && JSON.stringify(before), after && JSON.stringify(after), ip]
    );
  } catch (err) {
    // The audit write must never break the action it describes, but a failure is itself worth knowing about.
    logger.error("Failed to write audit log:", action, err.message);
  }
}

module.exports = { record };
