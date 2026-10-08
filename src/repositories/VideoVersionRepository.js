// Versioned store for generated videos, persisted through the EAV layer (video_slot parent entities, video_version child
// entities), scoped to the store in the ambient request context.
//
//   * versions are append-only history: every generation (and every "Update Overlay") is a new version of a
//     (uniqueTag, videoType) slot, numbered 1, 2, 3 ...
//   * each slot has ONE current version (the one the UI shows); allocateVersion makes the new version current,
//     "Restore" repoints current at an older one without creating a new version
//   * "candidates" versions hold the 4 preview stills between the preview step and the real render
const eav = require("../db/eav/EavRepository");
const { tx, query, currentStoreId, asSystem, withStore } = require("../db/connection");
const logger = require("../utils/logger");
const VideoSlot = require("../models/VideoSlot");
const VideoVersion = require("../models/VideoVersion");
const { STATUS, PREVIEW_STATUSES } = require("../config/constants");

const VERSION = VideoVersion.entityType;
const SLOT = VideoSlot.entityType;
const now = () => new Date().toISOString();

function storeId() {
  const id = currentStoreId();
  if (!id) throw new Error("No store in context");
  return id;
}

const slotKey = (uniqueTag, videoType) => `${uniqueTag}::${videoType}`;
const findSlot = (uniqueTag, videoType) => eav.findOne(SLOT, { storeId: storeId(), where: { uniqueTag, videoType } });

async function getOrCreateSlot(uniqueTag, videoType) {
  const existing = await findSlot(uniqueTag, videoType);
  if (existing) return existing;
  return eav.load(SLOT, await eav.create(SLOT, { uniqueTag, videoType }, { storeId: storeId() }));
}

const slotVersions = (slot) => eav.findAll(VERSION, { parentId: slot.id });
const byNewest = (a, b) => b.values.versionNo - a.values.versionNo;

async function toDto(entity) {
  return entity ? VideoVersion.toDto(entity, await eav.load(SLOT, entity.parentId)) : null;
}

// Resolves a version id to { version, slot }, or null.
async function loadVersion(versionId) {
  const version = await eav.load(VERSION, versionId);
  if (!version) return null;
  return { version, slot: await eav.load(SLOT, version.parentId) };
}

async function allocateVersion(uniqueTag, videoType, fields = {}) {
  return tx(async () => {
    const slot = await getOrCreateSlot(uniqueTag, videoType);
    // Serialise concurrent allocations for one slot so version numbers never collide.
    await query("SELECT entity_id FROM eav_entity WHERE entity_id = $1 FOR UPDATE", [slot.id]);
    const versionNo = (await slotVersions(slot)).reduce((max, v) => Math.max(max, v.values.versionNo), 0) + 1;
    const id = await eav.create(VERSION, { ...VideoVersion.pick(fields, VideoVersion.ALLOCATABLE), versionNo }, { storeId: storeId(), parentId: slot.id });
    const version = await eav.load(VERSION, id);
    // A preview ("candidates") only becomes the slot's current version once it starts rendering -- until then an existing
    // real video stays on screen, so closing the picker never hides it.
    const existing = slot.values.currentVersionId ? await eav.load(VERSION, slot.values.currentVersionId) : null;
    const slotHasRealVersion = existing && !PREVIEW_STATUSES.includes(existing.values.status);
    if (!(version.values.status === STATUS.CANDIDATES && slotHasRealVersion)) {
      await eav.update(SLOT, slot.id, { currentVersionId: id });
    }
    return toDto(version);
  });
}

// Updates an existing version in place. Returns null if it doesn't exist.
async function updateVersionAndMirror(versionId, patch = {}) {
  return tx(async () => {
    const loaded = await loadVersion(versionId);
    if (!loaded) return null;
    await eav.update(VERSION, loaded.version.id, VideoVersion.pick(patch, VideoVersion.PATCHABLE));
    // A candidates version advancing to a real render becomes the slot's current version.
    if (patch.status === STATUS.GENERATING) await eav.update(SLOT, loaded.slot.id, { currentVersionId: loaded.version.id });
    return toDto(await eav.load(VERSION, loaded.version.id));
  });
}

async function listVersions(uniqueTag, videoType) {
  const slot = await findSlot(uniqueTag, videoType);
  if (!slot) return [];
  return (await slotVersions(slot)).sort(byNewest).map((v) => VideoVersion.toDto(v, slot));
}

async function getVersion(versionId) {
  const loaded = await loadVersion(versionId);
  return loaded ? VideoVersion.toDto(loaded.version, loaded.slot) : null;
}

// Webhook lookup: the engine's callback carries no tenant, so this searches every store and returns the DTO with its
// storeId, letting the caller continue inside withStore(storeId).
async function findVersionByProjectId(projectId) {
  return asSystem(async () => {
    const matches = (await eav.findAll(VERSION, { where: { projectId } })).sort(byNewest);
    return toDto(matches[0]);
  });
}

// "Restore": repoint the slot's current version at an older one; no new version is created.
async function setCurrentVersion(uniqueTag, videoType, versionId) {
  return tx(async () => {
    const slot = await findSlot(uniqueTag, videoType);
    const version = slot && (await eav.load(VERSION, versionId));
    if (!version || version.parentId !== slot.id) return null;
    await eav.update(SLOT, slot.id, { currentVersionId: version.id });
    return VideoVersion.toDto(version, slot);
  });
}

async function deleteVersion(versionId) {
  return tx(async () => {
    const loaded = await loadVersion(versionId);
    if (!loaded) return null;
    const { version, slot } = loaded;
    const dto = VideoVersion.toDto(version, slot);
    await eav.delete(version.id);
    if (slot.values.currentVersionId === version.id) {
      const fallback = (await slotVersions(slot)).sort(byNewest)[0];
      if (fallback) await eav.update(SLOT, slot.id, { currentVersionId: fallback.id });
      else await eav.delete(slot.id);
    }
    return dto;
  });
}

// Removes a whole slot; returns every version's Flipick project/variant ids so the caller can clean them up remotely.
async function deleteSlot(uniqueTag, videoType) {
  return tx(async () => {
    const slot = await findSlot(uniqueTag, videoType);
    if (!slot) return [];
    const removed = await slotVersions(slot);
    await eav.delete(slot.id); // cascades to the versions and every value row
    return removed
      .map((v) => ({ projectId: v.values.projectId, variantId: v.values.variantId }))
      .filter((r) => r.projectId || r.variantId);
  });
}

// Marks a version canceled (kept in history -- it was a real attempt) and points the slot back at the last real
// version, if any. Only stops US from tracking the render: Flipick has no cancel API, so the job keeps running there.
async function cancelVersion(uniqueTag, videoType, versionId) {
  return tx(async () => {
    const loaded = await loadVersion(versionId);
    if (!loaded) return null;
    const { version, slot } = loaded;
    await eav.update(VERSION, version.id, { status: STATUS.CANCELED, canceledAt: now() });
    const previous = (await slotVersions(slot))
      .filter((x) => x.id !== version.id && ![...PREVIEW_STATUSES, STATUS.CANCELED].includes(x.values.status))
      .sort(byNewest)[0];
    const current = previous || version;
    await eav.update(SLOT, slot.id, { currentVersionId: current.id });
    return {
      canceled: VideoVersion.toDto(await eav.load(VERSION, version.id), slot),
      current: VideoVersion.toDto(await eav.load(VERSION, current.id), slot),
    };
  });
}

// Boot sweep across every store: renders in flight when the process died can never finish, and previews expire.
async function sweepAfterRestart() {
  await asSystem(async () => {
    for (const v of await eav.findAll(VERSION, { where: { status: STATUS.GENERATING } })) {
      await eav.update(VERSION, v.id, { status: STATUS.ERROR, error: "Interrupted by a server restart — click Generate again." });
    }
    const nowMs = Date.now();
    for (const v of await eav.findAll(VERSION, { where: { status: STATUS.CANDIDATES } })) {
      const expires = v.values.candidatesExpiresAt;
      if (expires && new Date(expires).getTime() < nowMs) await eav.update(VERSION, v.id, { status: STATUS.EXPIRED });
    }
  });
}

// The "generated" map for the ambient store: one entry per slot, mirroring that slot's current version (plus
// currentVersionId), keyed "uniqueTag::videoType".
async function loadGenerated() {
  const generated = {};
  for (const slot of await eav.findAll(SLOT, { storeId: storeId() })) {
    const current = slot.values.currentVersionId && (await eav.load(VERSION, slot.values.currentVersionId));
    if (current) generated[slotKey(slot.values.uniqueTag, slot.values.videoType)] = { ...VideoVersion.toDto(current, slot), currentVersionId: current.id };
  }
  return generated;
}

// Imports a pre-multi-tenant JSON store (data/videoStore.json) into the given store. Returns the number of versions.
async function importVersionStore(targetStoreId, state) {
  return withStore(targetStoreId, () => tx(async () => {
    const idMap = new Map(); // old version id -> new entity id
    let count = 0;
    for (const v of (state.versions || []).sort((a, b) => a.versionNo - b.versionNo)) {
      const slot = await getOrCreateSlot(v.uniqueTag, v.videoType);
      const id = await eav.create(VERSION, { ...VideoVersion.pick(v, VideoVersion.ALLOCATABLE), versionNo: v.versionNo }, { storeId: targetStoreId, parentId: slot.id });
      await query("UPDATE eav_entity SET created_at = $2, updated_at = $3 WHERE entity_id = $1", [id, v.createdAt || now(), v.updatedAt || now()]);
      idMap.set(v.id, id);
      count++;
    }
    for (const [key, oldId] of Object.entries(state.current || {})) {
      const sep = key.lastIndexOf("::");
      const slot = await findSlot(key.slice(0, sep), key.slice(sep + 2));
      if (slot && idMap.has(oldId)) await eav.update(SLOT, slot.id, { currentVersionId: idMap.get(oldId) });
    }
    logger.info(`Imported ${count} video version(s) from the pre-multi-tenant store`);
    return count;
  }));
}

module.exports = {
  loadGenerated,
  allocateVersion,
  updateVersionAndMirror,
  listVersions,
  getVersion,
  findVersionByProjectId,
  setCurrentVersion,
  deleteVersion,
  deleteSlot,
  cancelVersion,
  sweepAfterRestart,
  importVersionStore,
};
