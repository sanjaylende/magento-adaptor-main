// Starts and stops the test stack for the regression suite: a throwaway PostgreSQL database, the mock video engine, a fake store (Magento or
// WooCommerce REST), and the adapter itself (development mode) with a pretend ICICI bank. Nothing here reaches a real service.
//
//   const stack = await start({ repo, platform, port });   // fresh database, adapter listening on `port`
//   stack.base, stack.engine, stack.pay(txn, 'paid'), stack.db(sql), stack.stop()
//
// The database server is the adapter repo's own docker-compose "db" for WooCommerce (127.0.0.1:5435) and the shared PostgreSQL on 127.0.0.1:5432 for Magento; the database created
// here is <platform>_regression and is dropped and recreated on every start. Requires: Docker (db running), Node 22+, ffmpeg/ffprobe.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const PG_PORT = { magento: 5434, woo: 5435 };

async function waitFor(url, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const r = await fetch(url); if (r.status < 500) return true; } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 300)); }
  throw new Error(`${url} did not come up in ${ms / 1000} s`);
}

async function start({ repo, platform, port = 4290, engineKey = 'test-key', renderSeconds = 2, engineUrl = null, metrics = false, rateLimitScale = null }) {
  const pgPort = PG_PORT[platform];
  const dbName = `${platform}_regression`;
  const pg = require(path.join(repo, 'node_modules', 'pg'));
  // Magento: a scratch database on the shared PostgreSQL server (the adapter's schema and test-only roles, see test/scratchDatabase.js);
  // any other platform: its own docker PostgreSQL as before.
  let dbEnv, ownerUrl, schema = 'public';
  if (platform === 'magento') {
    const created = await require(path.join(repo, 'test', 'scratchDatabase.js')).createScratchDatabase(dbName);
    dbEnv = { DATABASE_URL: created.databaseUrl, DATABASE_ADMIN_URL: created.adminUrl, DB_SCHEMA: created.schema, DB_SSL: 'disable' };
    ownerUrl = created.adminUrl;
    schema = created.schema;
  } else {
    const OWNER = `postgresql://adapter_owner:adapter_owner_local@127.0.0.1:${pgPort}`;
    const admin = new pg.Client({ connectionString: `${OWNER}/postgres` });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${dbName} OWNER adapter_owner`);
    await admin.end();
    dbEnv = { DATABASE_URL: `postgresql://adapter_app:adapter_app_local@127.0.0.1:${pgPort}/${dbName}`, DATABASE_ADMIN_URL: `${OWNER}/${dbName}` };
    ownerUrl = `${OWNER}/${dbName}`;
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), `regression-${platform}-`));
  const children = [];
  const spawnNode = (args, env, name) => { const logFile = fs.openSync(path.join(work, `${name}.log`), 'a'); const c = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: ['ignore', logFile, logFile], windowsHide: true }); children.push(c); return c; };

  // mock engine (renders real videos from the images it is sent)
  let engine = engineUrl;
  if (!engine) {
    const enginePort = port + 1000;
    spawnNode([path.join(__dirname, 'mock-engine.js')], { PORT: String(enginePort), MOCK_RENDER_SECONDS: String(renderSeconds), MOCK_DIR: path.join(work, 'engine'), MOCK_ENGINE_KEY: engineKey }, 'engine');
    engine = `http://127.0.0.1:${enginePort}`;
    await waitFor(`${engine}/_requests`);
  }

  // adapter, started through a small launcher so the fake bank and (optionally) metrics run inside the same process
  const launcher = path.join(work, 'launch.js');
  fs.writeFileSync(launcher, `
    const path = require("path");
    process.chdir(${JSON.stringify(repo)});
    const fake = require(path.join(${JSON.stringify(repo)}, "test", "fakeIcici.js"));
    Object.assign(process.env, fake.ENV);
    Object.assign(process.env, require(path.join(${JSON.stringify(repo)}, "test", "fakeLtx.js")).ENV); require(path.join(${JSON.stringify(repo)}, "test", "fakeLtx.js")).start(); // staff sign in against a pretend LTX (set before anything loads the config)
    const icici = fake.install();
    require("http").createServer(async (req, res) => {
      const u = new URL(req.url, "http://x");
      if (u.pathname !== "/pay") { res.writeHead(404); return res.end(); }
      const page = await icici.pay("http://127.0.0.1:${port}", u.searchParams.get("txn"), u.searchParams.get("result") || "paid");
      res.writeHead(200, { "Content-Type": "text/html" }); res.end(page);
    }).listen(${port + 80}, "127.0.0.1");
    ${metrics ? `require(${JSON.stringify(path.join(__dirname, 'metrics.js'))})(${JSON.stringify(repo)}, ${port});` : ''}
    require(path.join(${JSON.stringify(repo)}, "src", "app")).start().catch((e) => { console.error("START FAILED", e.message, e.configProblems || ""); process.exit(1); });
  `);
  spawnNode([launcher], {
    PORT: String(port), PUBLIC_BASE_URL: `http://127.0.0.1:${port}`, NODE_ENV: 'development', LOG_LEVEL: 'info',
    ...dbEnv,
    ADAPTER_SECRET_KEY: '33'.repeat(32), // staff sign in through the pretend LTX (test/fakeLtx.js), so no staff password is configured here
    FLIPICK_VIDEO_ENGINE_BASE_URL: engine, FLIPICK_VIDEO_ENGINE_API_KEY: engineKey, FLIPICK_SPONSORED_ADS_BASE_URL: engine, FLIPICK_VVP_API_KEY: 'test',
    FLIPICK_TENANT_ID: 'regression', RETAILER_NAME: 'Regression Retailer', BILLING_GRACE_DAYS: '3',
    ...(rateLimitScale ? { RATE_LIMIT_SCALE: String(rateLimitScale) } : {}),
  }, 'adapter');
  const base = `http://127.0.0.1:${port}`;
  await waitFor(`${base}/`);

  const helpers = (() => { const cwd = process.cwd(); process.chdir(os.tmpdir()); try { return require(path.join(repo, 'test', 'helpers.js')); } finally { process.chdir(cwd); } })();
  const { startFakeStore } = require('./fake-store');
  const fakeStore = await startFakeStore({ platform, port: port + 2000, dir: path.join(work, 'store') });
  const ownerPool = new pg.Pool({ connectionString: ownerUrl, options: `-c search_path=${schema}`, max: 2 });
  // The owner role is least-privilege (no BYPASSRLS) and row-level security is forced: this checking session asks to see every tenant, like the staff console.
  ownerPool.on('connect', (c) => c.query("SELECT set_config('app.bypass', 'on', false)").catch(() => {}));

  return {
    base, engine, platform, repo, work, helpers, port, ownerUrl, schema, store: fakeStore, staff: { email: 'staff@test.local', password: 'staff-password-1' }, // the pretend LTX's superadmin (made up, test only)
    db: async (sql, params) => (await ownerPool.query(sql, params)).rows,
    pay: async (txn, result = 'paid') => { const r = await fetch(`http://127.0.0.1:${port + 80}/pay?txn=${encodeURIComponent(txn)}&result=${result}`); return (await r.text()).replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); },
    engineRequests: async () => (await fetch(`${engine}/_requests`)).json(),
    engineReset: () => fetch(`${engine}/_reset`),
    adapterLog: () => fs.readFileSync(path.join(work, 'adapter.log'), 'utf8'),
    async stop() {
      try { await fakeStore.close(); } catch { /* already closed */ }
      await ownerPool.end().catch(() => {});
      for (const c of children) { try { c.kill(); } catch { /* gone */ } }
    },
  };
}

module.exports = { start, waitFor };
