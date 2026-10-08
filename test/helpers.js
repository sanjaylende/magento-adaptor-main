// Shared test setup: a throwaway database, a fake Magento REST server, a running adapter, and a signed-request client.
const http = require("http");
const crypto = require("crypto");
const { Client } = require("pg");

const ADAPTER_PORT = 45123;
const MAGENTO_PORT = 45124;
const DB_NAME = "magento_adapter_test";
const OWNER = "postgresql://adapter_owner:adapter_owner_local@127.0.0.1:5434";

async function resetDatabase() {
  const admin = new Client({ connectionString: `${OWNER}/postgres` });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${DB_NAME} OWNER adapter_owner`);
  await admin.end();
}

function useTestEnvironment() {
  Object.assign(process.env, {
    DATABASE_URL: `postgresql://adapter_app:adapter_app_local@127.0.0.1:5434/${DB_NAME}`,
    DATABASE_ADMIN_URL: `${OWNER}/${DB_NAME}`,
    ADAPTER_SECRET_KEY: "11".repeat(32),
    PORT: String(ADAPTER_PORT),
    PUBLIC_BASE_URL: `http://127.0.0.1:${ADAPTER_PORT}`,
    PAYMENT_GATEWAY: "mock",
    ADMIN_BOOTSTRAP_EMAIL: "staff@test.local",
    ADMIN_BOOTSTRAP_PASSWORD: "staff-password-1",
    BILLING_GRACE_DAYS: "3",
    GST_RATE_BP: "1800",
    NODE_ENV: "test",
  });
}

// A minimal Magento: two websites (1 = USD, 2 = EUR), one product each.
function startFakeMagento() {
  const product = (id, name, websiteIds) => ({
    id, sku: `SKU-${id}`, name, status: 1, visibility: 4, price: 10 + id, type_id: "simple",
    extension_attributes: { website_ids: websiteIds },
    custom_attributes: [{ attribute_code: "product_type", value: "Fruits" }],
    media_gallery_entries: [{ file: "/a.jpg", types: ["image"], disabled: false }],
    updated_at: "2026-10-01 10:00:00",
  });
  const server = http.createServer((req, res) => {
    const send = (code, body) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.headers.authorization !== "Bearer good-token") return send(401, { message: "The consumer isn't authorized to access %resources." });
    const url = req.url.split("?")[0];
    if (url === "/rest/V1/store/websites") return send(200, [{ id: 0, code: "admin", name: "Admin" }, { id: 1, code: "base", name: "Main Website" }, { id: 2, code: "eu", name: "EU Website" }]);
    if (url === "/rest/V1/store/storeConfigs") return send(200, [{ website_id: 1, base_currency_code: "USD" }, { website_id: 2, base_currency_code: "EUR" }]);
    if (url === "/rest/V1/products") return send(200, { items: [product(1, "Apples", [1]), product(2, "Pears", [2])], total_count: 2 });
    if (url.startsWith("/rest/V1/products/attributes/")) return send(404, { message: "no such attribute" });
    send(404, { message: `unexpected ${url}` });
  });
  return new Promise((resolve) => server.listen(MAGENTO_PORT, "127.0.0.1", () => resolve(server)));
}

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const hmac = (secret, s) => crypto.createHmac("sha256", secret).update(s).digest("hex");

// Calls the adapter like the extension does: signed headers, JSON body.
function signedClient({ installKey, secret, websiteId, baseUrl = `http://127.0.0.1:${ADAPTER_PORT}` }) {
  return async function call(method, path, body, { nonce = crypto.randomUUID(), ts = Math.floor(Date.now() / 1000), headers = {}, badSignature = false } = {}) {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const signature = badSignature ? "0".repeat(64) : hmac(secret, `${ts}\n${nonce}\n${method}\n${path}\n${sha256(raw)}`);
    const res = await fetch(baseUrl + path, {
      method,
      headers: {
        "Content-Type": "application/json", "X-Flipick-Key": installKey, "X-Flipick-Timestamp": String(ts), "X-Flipick-Nonce": nonce,
        "X-Flipick-Signature": signature, ...(websiteId != null ? { "X-Flipick-Website": String(websiteId) } : {}), ...headers,
      },
      body: raw || undefined,
    });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json, headers: res.headers };
  };
}

function launchToken({ installKey, secret, websiteId, expiresInSeconds = 300 }) {
  const body = Buffer.from(JSON.stringify({ k: installKey, w: String(websiteId), e: Math.floor(Date.now() / 1000) + expiresInSeconds, n: crypto.randomUUID() })).toString("base64url");
  return `${body}.${hmac(secret, body)}`;
}

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`http://127.0.0.1:${ADAPTER_PORT}${path}`, {
    method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual",
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}

module.exports = { ADAPTER_PORT, MAGENTO_PORT, resetDatabase, useTestEnvironment, startFakeMagento, signedClient, launchToken, api, hmac };
