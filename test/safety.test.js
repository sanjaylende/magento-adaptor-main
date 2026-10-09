// Production start-up guard: the mock payment gateway and other unsafe settings stop the process from booting.
const test = require("node:test");
const assert = require("node:assert/strict");
const { productionProblems, assertSafeConfig } = require("../src/config/safety");

const good = {
  NODE_ENV: "production",
  PAYMENT_GATEWAY: "icici",
  ADAPTER_SECRET_KEY: "ab".repeat(32),
  PUBLIC_BASE_URL: "https://magento.example.com",
  DATABASE_URL: "postgresql://adapter_app:x9fK2@db.internal:5432/magento_adapter",
  DATABASE_ADMIN_URL: "postgresql://adapter_owner:y7Qp1@db.internal:5432/magento_adapter",
  DB_SSL: "require",
  ICICI_PG_BASE_URL: "https://pgpay.icicibank.com",
  ICICI_PG_MERCHANT_ID: "M1", ICICI_PG_AGGREGATOR_ID: "A1", ICICI_PG_SECRET_KEY: "k",
};

test("a correct production configuration passes", () => {
  assert.deepEqual(productionProblems(good), []);
  assert.doesNotThrow(() => assertSafeConfig(good));
});

test("production with the mock payment gateway refuses to start", () => {
  assert.throws(() => assertSafeConfig({ ...good, PAYMENT_GATEWAY: "mock" }), /PAYMENT_GATEWAY=mock is not allowed/);
  // an unset gateway defaults to mock, so it is refused as well
  const { PAYMENT_GATEWAY, ...unset } = good;
  assert.throws(() => assertSafeConfig(unset), /PAYMENT_GATEWAY=mock/);
});

test("the mock gateway is still allowed outside production (development and tests)", () => {
  assert.deepEqual(productionProblems({ NODE_ENV: "development", PAYMENT_GATEWAY: "mock" }), []);
  assert.deepEqual(productionProblems({ NODE_ENV: "test", PAYMENT_GATEWAY: "mock" }), []);
});

test("other unsafe production settings are refused", () => {
  assert.match(productionProblems({ ...good, ADAPTER_SECRET_KEY: "short" }).join(), /ADAPTER_SECRET_KEY/);
  assert.match(productionProblems({ ...good, PUBLIC_BASE_URL: "http://magento.example.com" }).join(), /https/);
  assert.match(productionProblems({ ...good, DATABASE_URL: "postgresql://adapter_app:adapter_app_local@db:5432/x" }).join(), /development password/);
  assert.match(productionProblems({ ...good, DB_SSL: "disable" }).join(), /DB_SSL/);
  assert.match(productionProblems({ ...good, ICICI_PG_BASE_URL: "https://pgpayuat.icicibank.com" }).join(), /test \(UAT\)/);
  assert.match(productionProblems({ ...good, ICICI_PG_SECRET_KEY: "" }).join(), /ICICI_PG_SECRET_KEY/);
});

test("the real process exits with a clear message when started in production with the mock gateway", () => {
  const { spawnSync } = require("node:child_process");
  const run = spawnSync(process.execPath, ["server.js"], {
    cwd: require("node:path").join(__dirname, ".."),
    env: { ...process.env, NODE_ENV: "production", PAYMENT_GATEWAY: "mock", LOG_TO_FILE: "false" },
    encoding: "utf8", timeout: 20000,
  });
  assert.notEqual(run.status, 0);
  assert.match(run.stdout + run.stderr, /Refusing to start/);
});
