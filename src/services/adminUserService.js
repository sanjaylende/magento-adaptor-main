// Flipick staff accounts for the admin console. Passwords are stored as scrypt hashes.
// Sign-in protections: lock-out after repeated failures (password or two-factor code), TOTP two-factor with single-use codes,
// and the same work for unknown and known e-mail addresses so the response time does not reveal which accounts exist.
const crypto = require("crypto");
const { authenticator } = require("otplib");
const config = require("../config");
const logger = require("../utils/logger");
const { query, asSystem } = require("../db/connection");
const { safeEqual, encrypt, decrypt } = require("../utils/crypto");

authenticator.options = { window: 1, step: 30, digits: 6 }; // accept the previous and next 30-second code (clock drift)

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  return `scrypt:${salt}:${crypto.scryptSync(password, salt, 64).toString("hex")}`;
}

function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored).split(":");
  return scheme === "scrypt" && safeEqual(hashPassword(password, salt), `scrypt:${salt}:${hash}`);
}

const DUMMY_HASH = hashPassword(crypto.randomBytes(12).toString("hex"));
const publicUser = (u) => ({ id: u.id, email: u.email, role: u.role, totpEnabled: !!u.totp_enabled });

// A failed password or code: count it, and lock the account once the limit is reached.
async function recordFailure(user) {
  const { maxFailedLogins, lockMinutes } = config.admin;
  const { rows: [row] } = await asSystem(() => query(
    `UPDATE admin_users SET failed_attempts = failed_attempts + 1,
            locked_until = CASE WHEN failed_attempts + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
      WHERE id = $1 RETURNING failed_attempts, locked_until`,
    [user.id, maxFailedLogins, lockMinutes]
  ));
  if (row.failed_attempts >= maxFailedLogins) logger.warn("Staff account locked after repeated failed sign-ins", { email: user.email, minutes: lockMinutes });
  return row;
}

const clearFailures = (id) => asSystem(() => query("UPDATE admin_users SET failed_attempts = 0, locked_until = NULL WHERE id = $1", [id]));

// -> { status: "ok", user } | { status: "invalid" } | { status: "locked" }. "invalid" is returned for an unknown e-mail too.
async function login(email, password) {
  const { rows: [user] } = await asSystem(() => query("SELECT * FROM admin_users WHERE lower(email) = lower($1) AND is_active", [String(email || "")]));
  const passwordOk = verifyPassword(String(password || ""), user ? user.password_hash : DUMMY_HASH);
  if (!user) return { status: "invalid" };
  if (user.locked_until && new Date(user.locked_until) > new Date()) return { status: "locked", user: publicUser(user) };
  if (!passwordOk) {
    await recordFailure(user);
    return { status: "invalid", user: publicUser(user) };
  }
  // For accounts with two-factor the counter is reset only after the code is accepted too, see verifyTotp.
  if (!user.totp_enabled) await clearFailures(user.id);
  return { status: "ok", user: publicUser(user) };
}

async function getById(id) {
  const { rows: [user] } = await asSystem(() => query("SELECT id, email, role, totp_enabled FROM admin_users WHERE id = $1 AND is_active", [id]));
  return user ? publicUser(user) : null;
}

// ---- Two-factor (TOTP, RFC 6238: works with Google Authenticator, Microsoft Authenticator, Authy, 1Password ...) ----

const normaliseCode = (code) => String(code || "").replace(/\s+/g, "");

// Checks a code for an enrolled user. Each 30-second code can be used once (the last accepted step is stored).
async function verifyTotp(userId, code) {
  const { rows: [user] } = await asSystem(() => query("SELECT * FROM admin_users WHERE id = $1 AND is_active AND totp_enabled", [userId]));
  if (!user) return { ok: false };
  if (user.locked_until && new Date(user.locked_until) > new Date()) return { ok: false, locked: true };
  const delta = /^\d{6}$/.test(normaliseCode(code)) ? authenticator.checkDelta(normaliseCode(code), decrypt(user.totp_secret)) : null;
  if (delta === null || delta === undefined) {
    await recordFailure(user);
    return { ok: false };
  }
  const step = Math.floor(Date.now() / 30000) + delta;
  const used = await asSystem(() => query("UPDATE admin_users SET totp_last_step = $2 WHERE id = $1 AND totp_last_step < $2", [user.id, step]));
  if (!used.rowCount) return { ok: false, reused: true }; // the same code was already used
  await clearFailures(user.id);
  return { ok: true };
}

// Step 1 of enrolment: make a secret (stored encrypted, not yet active) and return what the authenticator app needs.
async function beginEnrollment(userId, email) {
  const secret = authenticator.generateSecret(20);
  await asSystem(() => query("UPDATE admin_users SET totp_secret = $2, totp_enabled = FALSE, totp_last_step = 0 WHERE id = $1", [userId, encrypt(secret)]));
  return { secret, uri: authenticator.keyuri(email, "Flipick Video Admin", secret) };
}

// Step 2: the person types the first code their app shows; only then is two-factor switched on.
async function confirmEnrollment(userId, code) {
  const { rows: [user] } = await asSystem(() => query("SELECT totp_secret FROM admin_users WHERE id = $1 AND is_active AND NOT totp_enabled AND totp_secret IS NOT NULL", [userId]));
  if (!user || !/^\d{6}$/.test(normaliseCode(code))) return false;
  const delta = authenticator.checkDelta(normaliseCode(code), decrypt(user.totp_secret));
  if (delta === null || delta === undefined) return false;
  await asSystem(() => query("UPDATE admin_users SET totp_enabled = TRUE, totp_last_step = $2 WHERE id = $1", [userId, Math.floor(Date.now() / 30000) + delta]));
  return true;
}

// Lost phone: an operator with database or server access turns two-factor off for one account (scripts/reset-2fa.js).
async function resetTotp(email) {
  const r = await asSystem(() => query("UPDATE admin_users SET totp_enabled = FALSE, totp_secret = NULL, totp_last_step = 0, failed_attempts = 0, locked_until = NULL WHERE lower(email) = lower($1)", [email]));
  return r.rowCount;
}

// Creates the first admin from ADMIN_BOOTSTRAP_EMAIL / ADMIN_BOOTSTRAP_PASSWORD when there are no staff accounts yet.
async function ensureBootstrapAdmin() {
  const { bootstrapEmail, bootstrapPassword } = config.admin;
  const { rows: [{ n }] } = await asSystem(() => query("SELECT count(*)::int AS n FROM admin_users"));
  if (n > 0) return;
  if (!bootstrapEmail || !bootstrapPassword) {
    logger.warn("No staff accounts exist. Set ADMIN_BOOTSTRAP_EMAIL and ADMIN_BOOTSTRAP_PASSWORD to create the first admin.");
    return;
  }
  await asSystem(() => query("INSERT INTO admin_users (email, password_hash, role) VALUES ($1, $2, 'admin')", [bootstrapEmail, hashPassword(bootstrapPassword)]));
  logger.info(`Created first staff admin ${bootstrapEmail}`);
}

module.exports = { login, getById, ensureBootstrapAdmin, hashPassword, verifyTotp, beginEnrollment, confirmEnrollment, resetTotp };
