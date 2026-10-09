// Start-up safety checks for production. A misconfigured production server (test payment gateway, plain-HTTP public address,
// development database passwords) is refused at boot, so it can never serve traffic by accident.
// Returns the list of problems; start() refuses to run when the list is not empty.
function productionProblems(env = process.env) {
  if (env.NODE_ENV !== "production") return [];
  const problems = [];
  const publicUrl = String(env.PUBLIC_BASE_URL || "");

  if (String(env.PAYMENT_GATEWAY || "mock") === "mock") {
    problems.push("PAYMENT_GATEWAY=mock is not allowed in production: the mock gateway lets anyone mark an order as paid. Set PAYMENT_GATEWAY=icici.");
  }
  if (!/^[0-9a-f]{64}$/i.test(String(env.ADAPTER_SECRET_KEY || ""))) {
    problems.push("ADAPTER_SECRET_KEY must be 64 hex characters (32 random bytes).");
  }
  if (!/^https:\/\//i.test(publicUrl)) {
    problems.push("PUBLIC_BASE_URL must be an https:// address in production.");
  }
  for (const name of ["DATABASE_URL", "DATABASE_ADMIN_URL"]) {
    const value = String(env[name] || "");
    if (!value) problems.push(`${name} must be set in production (the built-in defaults are for local development only).`);
    else if (/_local@/.test(value)) problems.push(`${name} still uses a development password.`);
  }
  if (String(env.DB_SSL || "disable") !== "require" && !/@(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(String(env.DATABASE_URL || ""))) {
    problems.push("DB_SSL=require is needed when the database is on another host.");
  }
  if (env.ADMIN_BOOTSTRAP_PASSWORD && String(env.ADMIN_BOOTSTRAP_PASSWORD).length < 12) {
    problems.push("ADMIN_BOOTSTRAP_PASSWORD is shorter than 12 characters.");
  }
  if (String(env.PAYMENT_GATEWAY) === "icici") {
    for (const name of ["ICICI_PG_MERCHANT_ID", "ICICI_PG_AGGREGATOR_ID", "ICICI_PG_SECRET_KEY"]) {
      if (!env[name]) problems.push(`${name} must be set when PAYMENT_GATEWAY=icici.`);
    }
    if (/pgpayuat/i.test(String(env.ICICI_PG_BASE_URL || "https://pgpayuat.icicibank.com"))) {
      problems.push("ICICI_PG_BASE_URL points at the ICICI test (UAT) environment; use https://pgpay.icicibank.com in production.");
    }
  }
  return problems;
}

function assertSafeConfig(env = process.env) {
  const problems = productionProblems(env);
  if (problems.length) {
    const error = new Error(`Refusing to start: unsafe production configuration.\n - ${problems.join("\n - ")}`);
    error.configProblems = problems;
    throw error;
  }
}

module.exports = { productionProblems, assertSafeConfig };
