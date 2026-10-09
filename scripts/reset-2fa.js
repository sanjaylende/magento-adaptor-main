// Lost authenticator phone: turns two-factor off for one staff account so the person can enrol a new device.
// Needs server access (it uses DATABASE_ADMIN_URL from .env). Usage: node scripts/reset-2fa.js person@company.com
require("dotenv").config();
const { Client } = require("pg");

(async () => {
  const email = process.argv[2];
  if (!email) { console.error("Usage: node scripts/reset-2fa.js <staff e-mail>"); process.exit(2); }
  const client = new Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await client.connect();
  const r = await client.query("UPDATE admin_users SET totp_enabled = FALSE, totp_secret = NULL, totp_last_step = 0, failed_attempts = 0, locked_until = NULL WHERE lower(email) = lower($1)", [email]);
  await client.end();
  console.log(r.rowCount ? `Two-factor reset for ${email}. They enrol again at their next sign-in.` : `No staff account with e-mail ${email}.`);
})().catch((err) => { console.error(err.message); process.exit(1); });
