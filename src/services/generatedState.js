// In-memory mirror of every slot's CURRENT version for each store, keyed "uniqueTag::videoType" (plus currentVersionId).
// The database is the source of truth; this is what the bootstrap, /api/status and the render loop read and keep in step.
// All functions work on the store in the ambient request context and load that store's slots from the database on first use.
const { currentStoreId } = require("../db/connection");
const videoVersions = require("../repositories/VideoVersionRepository");

const byStore = new Map(); // storeId -> { key -> record }

function map() {
  const id = currentStoreId();
  if (!id) throw new Error("No store in context");
  if (!byStore.has(id)) throw new Error("Generated state not loaded for this store");
  return byStore.get(id);
}

function genKey(tag, videoType) {
  return `${tag}::${videoType || "lifestyle"}`;
}

// Call once per request before using the other functions.
async function ensureLoaded() {
  const id = currentStoreId();
  if (!byStore.has(id)) byStore.set(id, await videoVersions.loadGenerated());
}

const all = () => map();
const get = (key) => map()[key];
const set = (key, record) => { map()[key] = record; };
const remove = (key) => { delete map()[key]; };

function mergeVersion(key, version) {
  if (!version) return;
  const m = map();
  m[key] = { ...m[key], ...version, currentVersionId: version.id };
}

module.exports = { genKey, ensureLoaded, all, get, set, remove, mergeVersion };
