// Abandoned "candidates" slots: the starting-frame picker was opened but never finished. Shared by the explicit
// discard route (one slot, triggered by the merchant's Cancel) and the automatic clean-up run when the app loads or refreshes.
const logger = require("../utils/logger");
const generatedState = require("./generatedState");
const videoVersions = require("../repositories/VideoVersionRepository");
const { STATUS } = require("../config/constants");

const { genKey, mergeVersion } = generatedState;

// Drops one pending "candidates" version and falls back to the slot's previous real version, or removes the slot if it had none.
// Returns the slot's resulting display state (null when the slot is gone).
async function discardCandidates(uniqueTag, videoType, versionId) {
  const key = genKey(uniqueTag, videoType);
  const versions = await videoVersions.listVersions(uniqueTag, videoType);
  if (versionId) await videoVersions.deleteVersion(versionId);
  const remaining = versions.filter((v) => String(v.id) !== String(versionId) && v.status !== STATUS.CANDIDATES && v.status !== STATUS.EXPIRED);
  if (remaining.length) {
    mergeVersion(key, await videoVersions.setCurrentVersion(uniqueTag, videoType, remaining[0].id));
  } else {
    await videoVersions.deleteSlot(uniqueTag, videoType);
    generatedState.remove(key);
  }
  return generatedState.get(key) || null;
}

// Every slot still sitting at "candidates" when the app loads (or the product list is refreshed) is abandoned: the picker only
// lives within one page session, so none of them can still be mid-pick in this tab. A merchant who closed the tab or lost the
// connection lands back on their last real video instead of a permanent dead end. (Accepted edge case: a second tab opened while
// someone is genuinely mid-pick in another also clears it; generate then simply starts a fresh version.)
// Best-effort: a failure is logged and never blocks the page.
async function discardAbandonedCandidates() {
  const toDiscard = Object.entries(generatedState.all())
    .filter(([, g]) => g.status === STATUS.CANDIDATES && g.currentVersionId)
    .map(([key, g]) => ({ uniqueTag: key.slice(0, key.lastIndexOf("::")), videoType: key.slice(key.lastIndexOf("::") + 2), versionId: g.currentVersionId }));
  for (const { uniqueTag, videoType, versionId } of toDiscard) {
    try {
      await discardCandidates(uniqueTag, videoType, versionId);
    } catch (err) {
      logger.error("Failed to discard an abandoned candidates slot:", uniqueTag, videoType, err.message);
    }
  }
}

module.exports = { discardCandidates, discardAbandonedCandidates };
