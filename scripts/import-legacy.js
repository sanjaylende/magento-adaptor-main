// One-off: imports the video history of the pre-multi-tenant adapter (data/videoStore.json, or its *.imported copy) into one
// store of a registered installation.
//
//   node scripts/import-legacy.js <magentoBaseUrl> <websiteId> [path/to/videoStore.json]
const fs = require("fs");
const path = require("path");
const db = require("../src/db/connection");
const { runMigrations, syncEntityTypes } = require("../src/db/migrate");
const tenants = require("../src/services/tenantService");
const videoVersions = require("../src/repositories/VideoVersionRepository");

(async () => {
  const [baseUrl, websiteId, fileArg] = process.argv.slice(2);
  if (!baseUrl || !websiteId) throw new Error("Usage: node scripts/import-legacy.js <magentoBaseUrl> <websiteId> [file]");
  const file = fileArg || ["videoStore.json", "videoStore.json.imported"].map((f) => path.join(__dirname, "..", "data", f)).find((f) => fs.existsSync(f));
  if (!file) throw new Error("No videoStore.json found");
  await runMigrations();
  await syncEntityTypes([require("../src/models/VideoSlot"), require("../src/models/VideoVersion"), require("../src/models/StoreSetting")]);
  const { rows: [inst] } = await db.asSystem(() => db.query("SELECT id FROM installations WHERE base_url = $1", [baseUrl.replace(/\/+$/, "")]));
  if (!inst) throw new Error(`No installation registered for ${baseUrl}. Connect the Magento extension first.`);
  const store = await tenants.getStore(inst.id, websiteId);
  if (!store) throw new Error(`Website ${websiteId} is not known for that installation`);
  const { rows: [existing] } = await db.asSystem(() => db.query("SELECT count(*)::int AS n FROM eav_entity WHERE store_id = $1 AND entity_type_id = (SELECT entity_type_id FROM eav_entity_type WHERE code = 'video_version')", [store.id]));
  if (existing.n > 0) throw new Error(`Store ${store.name} already has ${existing.n} video version(s); not importing on top of them`);
  const count = await videoVersions.importVersionStore(store.id, JSON.parse(fs.readFileSync(file, "utf8")));
  console.log(`Imported ${count} version(s) from ${file} into "${store.name}" (store ${store.id})`);
  await db.close();
})().catch((err) => { console.error(err.message); process.exit(1); });
