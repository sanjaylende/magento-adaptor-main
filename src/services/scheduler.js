// Background jobs, run in-process on a timer: payment reconciliation, renewal reminders, expiry notices and table
// housekeeping. Each job is safe to run twice (unique dedupe keys, idempotent updates), so several adapter processes
// can run it without coordination.
const config = require("../config");
const logger = require("../utils/logger");
const { query, asSystem } = require("../db/connection");
const payments = require("./paymentService");
const mailer = require("./mailer");

async function queueRenewalNotices() {
  await asSystem(async () => {
    const { reminderDays, graceDays } = config.billing;
    // Plans about to end that will not renew by themselves (no auto-debit in v1), unless the merchant already cancelled.
    const soon = await query(
      `SELECT store_id, plan_code, period_end FROM store_subscriptions
       WHERE plan_code <> 'trial' AND status = 'active' AND cancel_at_period_end = FALSE
         AND period_end BETWEEN now() AND now() + make_interval(days => $1)`, [reminderDays]
    );
    for (const r of soon.rows) {
      await payments.notify(r.store_id, "renewal_reminder", `renewal_reminder:${r.store_id}:${new Date(r.period_end).toISOString()}`, { planCode: r.plan_code, periodEnd: r.period_end });
    }
    const ended = await query(
      `SELECT store_id, plan_code, period_end FROM store_subscriptions
       WHERE plan_code <> 'trial' AND status = 'active' AND period_end < now() - make_interval(days => $1)`, [graceDays]
    );
    for (const r of ended.rows) {
      await payments.notify(r.store_id, "plan_expired", `plan_expired:${r.store_id}:${new Date(r.period_end).toISOString()}`, { planCode: r.plan_code, periodEnd: r.period_end });
    }
  });
}

async function deliverNotifications() {
  const { rows } = await asSystem(() => query(
    `SELECT n.id, n.kind, n.payload, m.contact_email, m.name, s.name AS store_name
       FROM notifications n JOIN stores s ON s.id = n.store_id JOIN installations i ON i.id = s.installation_id JOIN merchants m ON m.id = i.merchant_id
      WHERE n.status = 'pending' ORDER BY n.id LIMIT 50`));
  for (const n of rows) {
    try {
      await mailer.send({ to: n.contact_email, kind: n.kind, merchant: n.name, store: n.store_name, payload: n.payload });
      await asSystem(() => query("UPDATE notifications SET status = 'sent', sent_at = now() WHERE id = $1", [n.id]));
    } catch (err) {
      logger.error("Notification failed:", n.kind, err.message);
      await asSystem(() => query("UPDATE notifications SET status = 'failed' WHERE id = $1", [n.id]));
    }
  }
}

async function housekeeping() {
  await asSystem(async () => {
    await query("DELETE FROM request_nonces WHERE expires_at < now()");
    await query("DELETE FROM rate_limits WHERE window_start < now() - interval '1 hour'");
    await query("DELETE FROM idempotency_keys WHERE created_at < now() - interval '48 hours'");
  });
}

async function runOnce(name, fn) {
  try {
    await fn();
  } catch (err) {
    logger.error(`Scheduled job ${name} failed:`, err.message);
  }
}

function start() {
  const tick = async () => {
    await runOnce("reconcile", payments.reconcilePending);
    await runOnce("refunds", payments.settleProcessingRefunds);
    await runOnce("deliver", deliverNotifications);
  };
  const hourly = async () => {
    await runOnce("renewal-notices", queueRenewalNotices);
    await runOnce("housekeeping", housekeeping);
  };
  const a = setInterval(tick, 60 * 1000);
  const b = setInterval(hourly, 60 * 60 * 1000);
  a.unref();
  b.unref();
  setTimeout(hourly, 5000).unref();
}

module.exports = { start, queueRenewalNotices, deliverNotifications, housekeeping };
