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
const { STATUS, PREVIEW_STATUSES, VIDEO_TYPES } = require("../config/constants");

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

// Versions the history window lists: real attempts only, not previews that were never rendered.
const isHistoryVersion = (v) => !PREVIEW_STATUSES.includes(v.values.status);

// The version as the browser sees it, plus how many versions its slot's history has: the page shows "Version history" whenever there is more than
// one, also when the current one is Version 1 (an older version that was restored).
async function dtoWithCount(entity, slot) {
  return { ...VideoVersion.toDto(entity, slot), versionCount: (await slotVersions(slot)).filter(isHistoryVersion).length };
}

async function toDto(entity) {
  if (!entity) return null;
  return dtoWithCount(entity, await eav.load(SLOT, entity.parentId));
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
    return dtoWithCount(version, slot);
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
      canceled: await dtoWithCount(await eav.load(VERSION, version.id), slot),
      current: await dtoWithCount(await eav.load(VERSION, current.id), slot),
    };
  });
}

// Boot sweep across every store: renders in flight when the process died can never finish, and previews expire.
// A product's uniqueTag can change (e.g. the variant that supplies its price changes). Moves each of the old tag's slots to the new tag,
// so the videos made for the product survive instead of appearing to vanish. A video type that already has a slot under the new tag
// is left alone: that newer video is the one to keep. Returns the video types that were moved.
async function remapUniqueTag(oldTag, newTag) {
  if (!oldTag || !newTag || oldTag === newTag) return [];
  const moved = [];
  await tx(async () => {
    for (const videoType of Object.keys(VIDEO_TYPES)) {
      const old = await findSlot(oldTag, videoType);
      if (!old) continue;
      if (await findSlot(newTag, videoType)) continue;
      await eav.update(SLOT, old.id, { uniqueTag: newTag });
      moved.push(videoType);
    }
  });
  return moved;
}

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
  const counts = new Map(); // versions per slot, counted once for the whole store
  for (const v of await eav.findAll(VERSION, { storeId: storeId() })) if (isHistoryVersion(v)) counts.set(v.parentId, (counts.get(v.parentId) || 0) + 1);
  for (const slot of await eav.findAll(SLOT, { storeId: storeId() })) {
    const current = slot.values.currentVersionId && (await eav.load(VERSION, slot.values.currentVersionId));
    if (current) generated[slotKey(slot.values.uniqueTag, slot.values.videoType)] = { ...VideoVersion.toDto(current, slot), versionCount: counts.get(slot.id) || 1, currentVersionId: current.id };
  }
  return generated;
}

module.exports = {
  loadGenerated,
  allocateVersion,
  updateVersionAndMirror,
  listVersions,
  findVersionByProjectId,
  setCurrentVersion,
  deleteVersion,
  deleteSlot,
  cancelVersion,
  sweepAfterRestart,
  remapUniqueTag,
};
