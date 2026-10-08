// Flipick tells us when a project was edited in LTX Studio after generation: flag the slot stale instead of silently
// serving an out-of-date video. The callback carries no tenant, so the owning store is found from the project id.
const logger = require("../utils/logger");
const { withStore } = require("../db/connection");
const generatedState = require("../services/generatedState");
const videoVersions = require("../repositories/VideoVersionRepository");

async function videoEngine(req, res) {
  res.json({ ok: true });
  const { project_id: projectId, event } = req.body || {};
  if (!projectId || !event) return;
  try {
    const found = await videoVersions.findVersionByProjectId(projectId);
    if (!found) {
      logger.info(`[webhooks/video-engine] no matching video for project_id=${projectId} (event=${event})`);
      return;
    }
    await withStore(found.storeId, async () => {
      await generatedState.ensureLoaded();
      const key = generatedState.genKey(found.uniqueTag, found.videoType);
      logger.info(`[webhooks/video-engine] ${event} on project ${projectId} -- flagging "${key}" as stale`);
      const updated = await videoVersions.updateVersionAndMirror(found.id, { staleFromLtxEdit: true });
      if (updated && generatedState.get(key)?.currentVersionId === updated.id) generatedState.mergeVersion(key, updated);
    });
  } catch (err) {
    logger.error("Failed to process video-engine webhook:", err.message);
  }
}

module.exports = { videoEngine };
