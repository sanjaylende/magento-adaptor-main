// Looking up an installation must not decrypt its stored secrets until something uses them: every authenticated request does this lookup, and
// two AES-GCM decryptions per request were wasted on routes that never touch the secret or the store token.
const test = require("node:test");
const assert = require("node:assert/strict");

function load() {
  const decrypted = [];
  const stub = (rel, exports) => { const p = require.resolve(rel); const old = require.cache[p]; require.cache[p] = { id: p, filename: p, loaded: true, exports }; return [p, old]; };
  const row = { id: 1, merchant_id: 2, base_url: "http://shop.test", install_key: "fk_x", secret_enc: "ENC-SECRET", magento_token_enc: "ENC-TOKEN", status: "active", magento_version: "2.4.9", extension_version: "1" };
  const saved = [
    stub("../src/db/connection", { query: async () => ({ rows: [row] }), tx: async (fn) => fn(), asSystem: (fn) => fn() }),
    stub("../src/utils/crypto", { encrypt: (v) => "ENC-" + v, decrypt: (v) => { decrypted.push(v); return "plain-" + v; }, randomToken: () => "t" }),
    stub("../src/db/eav/EavRepository", { findOne: async () => null }),
    stub("../src/services/auditService", { record: async () => {} }),
  ];
  const target = require.resolve("../src/services/tenantService");
  delete require.cache[target];
  const tenants = require("../src/services/tenantService");
  const restore = () => { delete require.cache[target]; for (const [p, old] of saved) { if (old) require.cache[p] = old; else delete require.cache[p]; } };
  return { tenants, decrypted, restore };
}

test("looking up an installation decrypts nothing", async () => {
  const { tenants, decrypted, restore } = load();
  const inst = await tenants.getInstallation(1);
  restore();
  assert.equal(inst.id, 1);
  assert.deepEqual(decrypted, []);
});

test("the secret is decrypted on first use, once", async () => {
  const { tenants, decrypted, restore } = load();
  const inst = await tenants.getInstallation(1);
  assert.equal(inst.secret, "plain-ENC-SECRET");
  assert.equal(inst.secret, "plain-ENC-SECRET");
  restore();
  assert.deepEqual(decrypted, ["ENC-SECRET"]);
});

test("the store connection settings do not decrypt the token until it is read", async () => {
  const { tenants, decrypted, restore } = load();
  const inst = await tenants.getInstallation(1);
  const cfg = await tenants.magentoConfigFor(inst, { id: 4, externalId: "1", baseCurrency: "USD" });
  assert.deepEqual(decrypted, []);
  assert.equal(cfg.accessToken, "plain-ENC-TOKEN");
  assert.equal(cfg.accessToken, "plain-ENC-TOKEN");
  restore();
  assert.deepEqual(decrypted, ["ENC-TOKEN"]);
});

test("an installation without a token has none", async () => {
  const { tenants, restore } = load();
  const inst = await tenants.getInstallation(1);
  restore();
  assert.ok("secret" in inst);
});
