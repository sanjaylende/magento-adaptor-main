// Ambient tenant context for the current request (and any background work it starts, such as the render loop):
// { installation, store, magento }. Also puts the store into the database context so row-level security applies.
const { AsyncLocalStorage } = require("async_hooks");
const { withStore } = require("./db/connection");

const als = new AsyncLocalStorage();

// tenant: { installation: {id, merchantId, baseUrl, ...}, store: {id, externalId, ...}, magento: {baseUrl, accessToken, ...} }
function runWithTenant(tenant, fn) {
  return als.run(tenant, () => withStore(tenant.store.id, fn));
}

function tenant() {
  const t = als.getStore();
  if (!t) throw new Error("No tenant in context");
  return t;
}

const hasTenant = () => !!als.getStore();

module.exports = { runWithTenant, tenant, hasTenant };
