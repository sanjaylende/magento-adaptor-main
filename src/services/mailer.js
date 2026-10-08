// Outgoing merchant email. No SMTP provider is configured yet, so messages are written to the log; replace send() with a
// real transport (SES, SendGrid, SMTP) when one is chosen. The scheduler only depends on this one function.
const logger = require("../utils/logger");

const SUBJECTS = {
  renewal_reminder: "Your Flipick Video Generator plan ends soon",
  plan_expired: "Your Flipick Video Generator plan has ended",
  payment_failed: "Your Flipick Video Generator payment did not go through",
};

async function send({ to, kind, merchant, store, payload }) {
  logger.info(`[mail] to=${to || "(no email on file)"} subject="${SUBJECTS[kind] || kind}" store="${store}" merchant="${merchant}"`, payload || {});
}

module.exports = { send, SUBJECTS };
