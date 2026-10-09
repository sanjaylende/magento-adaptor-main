// Business health check for monitoring (cron, Uptime Kuma "push" monitor, Nagios-style): exits 0 when all is well and 1 with a
// list of problems otherwise. It looks for things that never show up as an HTTP error:
//   - payments stuck "pending" for more than PENDING_MINUTES (default 30): the bank did not confirm, or re-checks fail
//   - refunds stuck "processing" for more than REFUND_DAYS (default 3)
//   - notifications that could not be delivered (status "failed") in the last day
//   - staff accounts locked right now (a burst of these means someone is guessing passwords)
// Usage: node scripts/check-health.js            (uses DATABASE_ADMIN_URL from .env or the local default; read-only queries)
const config = require("../src/config");
const { Client } = require("pg");

const pendingMinutes = Number(process.env.HEALTH_PENDING_MINUTES || 30);
const refundDays = Number(process.env.HEALTH_REFUND_DAYS || 3);

(async () => {
  const client = new Client({ connectionString: config.database.adminUrl });
  await client.connect();
  const q = async (sql, params) => (await client.query(sql, params)).rows[0].n;
  const problems = [];

  const pending = await q("SELECT count(*)::int AS n FROM payment_orders WHERE status = 'pending' AND created_at < now() - make_interval(mins => $1)", [pendingMinutes]);
  if (pending) problems.push(`${pending} payment(s) pending for more than ${pendingMinutes} minutes`);

  const refunds = await q("SELECT count(*)::int AS n FROM refunds WHERE status = 'processing' AND created_at < now() - make_interval(days => $1)", [refundDays]);
  if (refunds) problems.push(`${refunds} refund(s) still processing after ${refundDays} days`);

  const failedMail = await q("SELECT count(*)::int AS n FROM notifications WHERE status = 'failed' AND created_at > now() - interval '1 day'", []);
  if (failedMail) problems.push(`${failedMail} notification(s) could not be delivered in the last day`);

  const locked = await q("SELECT count(*)::int AS n FROM admin_users WHERE locked_until > now()", []);
  if (locked) problems.push(`${locked} staff account(s) are locked right now (repeated failed sign-ins)`);

  await client.end();
  if (problems.length) {
    console.error(`UNHEALTHY: ${problems.join("; ")}`);
    process.exit(1);
  }
  console.log("OK: no stuck payments or refunds, no undelivered notifications, no locked staff accounts");
})().catch((err) => { console.error(`CHECK FAILED: ${err.message}`); process.exit(2); });
