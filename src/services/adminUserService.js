// Staff sign-in for the admin console is delegated to LTX (the Flipick video engine): this service keeps no staff accounts, passwords,
// two-factor secrets or lock-out counters. The e-mail and password typed on the sign-in page are forwarded once to LTX's
// POST /api/v1/auth/login and dropped; only the token LTX returns is kept, inside the signed session cookie (see src/admin/routes.js).
// Every /admin request re-checks that token with LTX's GET /api/v1/auth/me, so access ends the moment LTX revokes it (password change,
// deactivation, role change), not at the next cookie expiry. Same approach as the Shopify adapter's /admin.
const config = require("../config");
const logger = require("../utils/logger");

const TIMEOUT_MS = 8000;
const base = () => String(config.admin.authBaseUrl || "").replace(/\/+$/, "");

// Flipick superadmins always; an LTX tenant admin only for THIS deployment's own tenant (FLIPICK_TENANT_ID). Both become the console's
// 'admin' role: LTX has no read-only 'support' equivalent, so nobody else gets in.
function gateAllows(user) {
  if (!user) return false;
  if (user.role === "superadmin") return true;
  return user.role === "admin" && !!config.flipick.tenantId && String(user.tenant_id) === String(config.flipick.tenantId);
}

const staffOf = (u) => ({ id: String(u.id), email: String(u.email), role: "admin" });

async function ltx(path, init) {
  if (!base()) throw new Error("FLIPICK_VIDEO_ENGINE_BASE_URL (or ADMIN_AUTH_BASE_URL) is not set");
  return fetch(`${base()}${path}`, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

// -> { status: "ok", user, token } | { status: "invalid" } | { status: "unavailable" }.
// "invalid" covers a wrong password, an unknown e-mail, an LTX lock-out and an account that may not use the console alike.
async function login(email, password) {
  try {
    const res = await ltx("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: String(email || ""), password: String(password || "") }),
    });
    if (res.status >= 500) return { status: "unavailable" };
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.token || !gateAllows(body.user)) return { status: "invalid" };
    return { status: "ok", user: staffOf(body.user), token: String(body.token) };
  } catch (err) {
    logger.error("Staff sign-in: LTX is not reachable:", err.message);
    return { status: "unavailable" };
  }
}

// Checks a session's LTX token. -> { status: "ok", user } | { status: "invalid" } | { status: "unavailable" }
async function verifySession(token) {
  try {
    const res = await ltx("/api/v1/auth/me", { headers: { Authorization: `Bearer ${token}` } });
    if (res.status >= 500) return { status: "unavailable" };
    if (!res.ok) return { status: "invalid" };
    const user = await res.json().catch(() => null);
    return gateAllows(user) ? { status: "ok", user: staffOf(user) } : { status: "invalid" };
  } catch (err) {
    logger.error("Staff session check: LTX is not reachable:", err.message);
    return { status: "unavailable" };
  }
}

module.exports = { login, verifySession, gateAllows };
