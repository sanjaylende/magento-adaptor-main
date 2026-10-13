// A browser session names an installation and a store; both are needed on every request. They are read in ONE statement (a join) and the result
// is exactly what the two separate lookups gave.
const test = require("node:test");
const assert = require("node:assert/strict");

function load(rowsFor) {
  const statements = [];
  const stub = (rel, exports) => { const p = require.resolve(rel); const old = require.cache[p]; require.cache[p] = { id: p, filename: p, loaded: true, exports }; return [p, old]; };
  const saved = [
    stub("../src/db/connection", { query: async (sql, params) => { statements.push({ sql, params }); return { rows: rowsFor(sql, params) }; }, tx: async (fn) => fn(), asSystem: (fn) => fn() }),
    stub("../src/utils/crypto", { encrypt: (v) => "ENC-" + v, decrypt: (v) => "plain-" + v, randomToken: () => "t" }),
    stub("../src/db/eav/EavRepository", { findOne: async () => null }),
    stub("../src/services/auditService", { record: async () => {} }),
  ];
  const target = require.resolve("../src/services/tenantService");
  delete require.cache[target];
  const tenants = require("../src/services/tenantService");
  const restore = () => { delete require.cache[target]; for (const [p, old] of saved) { if (old) require.cache[p] = old; else delete require.cache[p]; } };
  return { tenants, statements, restore };
}
const installationRow = { id: 1, merchant_id: 2, base_url: "http://shop.test", install_key: "fk_x", secret_enc: "S", magento_token_enc: "T", status: "active", magento_version: "1", extension_version: "1" };
const storeCols = { store_id: 11, store_installation_id: 1, store_external_id: "3", store_code: "grocery", store_name: "Grocery", store_base_currency: "USD ", store_status: "active" };

test("the installation and the store come from one statement", async () => {
  const { tenants, statements, restore } = load(() => [{ ...installationRow, ...storeCols }]);
  const { installation, store } = await tenants.getInstallationAndStore(1, 3);
  restore();
  assert.equal(statements.length, 1);
  assert.match(statements[0].sql, /FROM installations i\s+LEFT JOIN stores s/);
  assert.deepEqual(statements[0].params, [1, "3"]);
  assert.equal(installation.id, 1);
  assert.equal(installation.baseUrl, "http://shop.test");
  assert.deepEqual(store, { id: 11, installationId: 1, externalId: "3", code: "grocery", name: "Grocery", baseCurrency: "USD", status: "active" });
});

test("an installation without that store gives a null store", async () => {
  const { tenants, restore } = load(() => [{ ...installationRow, store_id: null, store_installation_id: null, store_external_id: null, store_code: null, store_name: null, store_base_currency: null, store_status: null }]);
  const { installation, store } = await tenants.getInstallationAndStore(1, 9);
  restore();
  assert.equal(installation.id, 1);
  assert.equal(store, null);
});

test("an unknown installation gives nothing", async () => {
  const { tenants, restore } = load(() => []);
  const out = await tenants.getInstallationAndStore(77, 1);
  restore();
  assert.deepEqual(out, { installation: null, store: null });
});
