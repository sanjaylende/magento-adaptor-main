// Slot / version management: delete a slot, list history, restore, delete a version, discard abandoned previews.
const config = require("../config");
const { tenant } = require("../context");
const logger = require("../utils/logger");
const productService = require("../services/productService");
const generatedState = require("../services/generatedState");
const videoVersions = require("../repositories/VideoVersionRepository");
const { deleteVideo } = require("../services/videoEngineService");
const { clearVideoFromProduct } = require("../services/magentoPublishService");
const { refreshVersionUrls } = require("../services/videoUrlService");
const candidates = require("../services/candidateService");
const { PREVIEW_STATUSES } = require("../config/constants");

const { genKey, mergeVersion } = generatedState;

// Deletes a whole slot (every version) locally, then best-effort cleans up on Flipick's side and removes the video from
// the Magento product if it was the one shown there.
async function deleteSlot(req, res) {
  const { uniqueTag, videoType } = req.params;
  const key = genKey(uniqueTag, videoType);
  const existing = generatedState.get(key);
  generatedState.remove(key);
  let cleanupTargets = [];
  try {
    cleanupTargets = await videoVersions.deleteSlot(uniqueTag, videoType);
  } catch (err) {
    logger.error("Failed to delete video versions for", key, "-", err.message);
  }
  res.json({ ok: true });
  for (const { projectId, variantId } of cleanupTargets) {
    deleteVideo({ projectId, variantId }, config.flipick).catch((err) => logger.error("Failed to delete video on Flipick's side", key, err));
  }
  if (existing?.pushedToMagento) {
    const product = productService.findProduct(uniqueTag);
    if (product) {
      clearVideoFromProduct({ baseUrl: tenant().magento.baseUrl, accessToken: tenant().magento.accessToken, magentoSku: product.magentoSku })
        .catch((err) => logger.error("Failed to clear video attributes on Magento product", key, err));
    }
  }
}

// Version history for a slot (newest first); ready versions get fresh signed URLs so the thumbnails/downloads work.
async function listVersions(req, res) {
  const { uniqueTag, videoType } = req.params;
  try {
    // History = real attempts only (previews that were never rendered are not versions).
    const versions = (await videoVersions.listVersions(uniqueTag, videoType)).filter((v) => !PREVIEW_STATUSES.includes(v.status));
    await refreshVersionUrls(versions);
    res.json({ versions });
  } catch (err) {
    logger.error("Failed to list generated video versions:", err.message, { uniqueTag, videoType });
    res.status(502).json({ error: err.message, versions: [] });
  }
}

// "Restore": make an older version the slot's current one again (no new version).
async function restoreVersion(req, res) {
  const { uniqueTag, videoType, versionId } = req.params;
  try {
    const version = await videoVersions.setCurrentVersion(uniqueTag, videoType, versionId);
    if (!version) return res.status(404).json({ error: "Version not found" });
    mergeVersion(genKey(uniqueTag, videoType), version);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}

async function deleteVersion(req, res) {
  const { uniqueTag, videoType, versionId } = req.params;
  try {
    const deleted = await videoVersions.deleteVersion(versionId);
    if (!deleted) return res.status(404).json({ error: "Version not found" });
    // Keep the in-memory mirror in step when the deleted version was the slot's current one.
    const key = genKey(uniqueTag, videoType);
    const remaining = (await videoVersions.listVersions(uniqueTag, videoType)).filter((v) => !PREVIEW_STATUSES.includes(v.status));
    if (generatedState.get(key)?.currentVersionId === deleted.id) {
      if (remaining.length) generatedState.set(key, { ...remaining[0], versionCount: remaining.length, currentVersionId: remaining[0].id });
      else generatedState.remove(key);
    } else if (generatedState.get(key)) {
      generatedState.set(key, { ...generatedState.get(key), versionCount: remaining.length }); // the Version history link follows the real count
    }
    if (deleted.projectId || deleted.variantId) {
      deleteVideo({ projectId: deleted.projectId, variantId: deleted.variantId }, config.flipick).catch((err) =>
        logger.error("Failed to delete version's video on Flipick's side", versionId, err)
      );
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}

// Drops an abandoned "candidates" version (the user closed the picker without choosing) and falls back to the slot's
// previous real version, or removes the slot if there is none.
async function discardCandidates(req, res) {
  const { uniqueTag, videoType } = req.params;
  const { versionId } = req.body || {};
  try {
    // The slot's resulting display state, so the client updates in place without a /api/status round-trip.
    res.json({ ok: true, current: await candidates.discardCandidates(uniqueTag, videoType, versionId) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}

module.exports = { deleteSlot, listVersions, restoreVersion, deleteVersion, discardCandidates };
