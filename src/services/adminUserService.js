// Flipick staff accounts for the admin console. Passwords are stored as scrypt hashes.
const crypto = require("crypto");
const config = require("../config");
const logger = require("../utils/logger");
const { query, asSystem } = require("../db/connection");
const { safeEqual } = require("../utils/crypto");

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  return `scrypt:${salt}:${crypto.scryptSync(password, salt, 64).toString("hex")}`;
}

function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored).split(":");
  return scheme === "scrypt" && safeEqual(hashPassword(password, salt), `scrypt:${salt}:${hash}`);
}

async function authenticate(email, password) {
  const { rows: [user] } = await asSystem(() => query("SELECT * FROM admin_users WHERE lower(email) = lower($1) AND is_active", [email || ""]));
  return user && verifyPassword(password || "", user.password_hash) ? { id: user.id, email: user.email, role: user.role } : null;
}

async function getById(id) {
  const { rows: [user] } = await asSystem(() => query("SELECT id, email, role FROM admin_users WHERE id = $1 AND is_active", [id]));
  return user || null;
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

module.exports = { authenticate, getById, ensureBootstrapAdmin, hashPassword };
