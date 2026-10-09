// Secret handling: AES-256-GCM for values stored at rest, HMAC helpers, random tokens.
const crypto = require("crypto");
const config = require("../config");

function key() {
  if (!/^[0-9a-f]{64}$/i.test(config.secretKey)) {
    throw new Error("ADAPTER_SECRET_KEY must be 64 hex characters (32 bytes). Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"");
  }
  return Buffer.from(config.secretKey, "hex");
}

// Output: "v1:<iv>:<tag>:<ciphertext>" (all base64url).
function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), data.toString("base64url")].join(":");
}

function decrypt(blob) {
  const [version, iv, tag, data] = String(blob).split(":");
  if (version !== "v1") throw new Error("Unknown ciphertext format");
  const authTag = Buffer.from(tag, "base64url");
  if (authTag.length !== 16) throw new Error("Invalid ciphertext"); // a shortened tag would weaken GCM authentication
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"), { authTagLength: 16 });
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
}

const sha256Hex = (data) => crypto.createHash("sha256").update(data).digest("hex");
const hmacHex = (secret, data) => crypto.createHmac("sha256", secret).update(data).digest("hex");
const randomToken = (bytes = 24) => crypto.randomBytes(bytes).toString("base64url");

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

// Signed, expiring token for browser sessions: base64url(json).hmac. Not a general JWT, just what this service needs.
function signToken(payload, ttlSeconds) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString("base64url");
  return `${body}.${hmacHex(key(), body)}`;
}

function verifyToken(token) {
  const [body, sig] = String(token || "").split(".");
  if (!body || !sig || !safeEqual(sig, hmacHex(key(), body))) return null;
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  return payload.exp > Math.floor(Date.now() / 1000) ? payload : null;
}

module.exports = { encrypt, decrypt, sha256Hex, hmacHex, randomToken, safeEqual, signToken, verifyToken };
