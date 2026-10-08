// Flipick's signed video/thumbnail URLs expire (7 days). These helpers re-sign them so thumbnails, players, downloads and
// the Magento push keep working.
const config = require("../config");
const logger = require("../utils/logger");
const { refreshProjectVideoUrls, isVideoUrlStale } = require("../integrations/videoEngineClient");
const videoVersions = require("../repositories/VideoVersionRepository");
const generatedState = require("./generatedState");
const { STATUS } = require("../config/constants");

const engine = () => ({ baseUrl: config.flipick.videoEngineBaseUrl, apiKey: config.flipick.videoEngineApiKey });

// Re-signs every ready slot's URL (and persists the new URL so the next page load does not need to).
async function refreshGeneratedVideoUrls() {
  const entries = Object.entries(generatedState.all()).filter(([, g]) => g.status === STATUS.READY && g.projectId);
  if (!entries.length) return;
  let results;
  try {
    results = await refreshProjectVideoUrls({ ...engine(), projectIds: [...new Set(entries.map(([, g]) => g.projectId))] });
  } catch (err) {
    logger.error("Failed to refresh video URLs:", err.message);
    return;
  }
  for (const [key, g] of entries) {
    const result = results[g.projectId];
    if (!result || result.error) continue;
    const updated = { ...g, videoUrl: result.videoUrl || g.videoUrl, thumbnailUrl: result.thumbnailUrl || g.thumbnailUrl };
    generatedState.set(key, updated);
    if (g.currentVersionId) {
      videoVersions
        .updateVersionAndMirror(g.currentVersionId, { videoUrl: updated.videoUrl, thumbnailUrl: updated.thumbnailUrl })
        .catch((err) => logger.error("Failed to persist refreshed URL for", key, "-", err.message));
    }
  }
}

// Mutates ready versions (that have an engine project) to carry fresh signed URLs. Failures are logged, not thrown.
async function refreshVersionUrls(versions) {
  const ready = versions.filter((v) => v.status === STATUS.READY && v.projectId);
  if (!ready.length) return;
  try {
    const results = await refreshProjectVideoUrls({ ...engine(), projectIds: [...new Set(ready.map((v) => v.projectId))] });
    for (const v of ready) {
      const result = results[v.projectId];
      if (result && !result.error) {
        v.videoUrl = result.videoUrl || v.videoUrl;
        v.thumbnailUrl = result.thumbnailUrl || v.thumbnailUrl;
      }
    }
  } catch (err) {
    logger.error("Failed to refresh version history URLs:", err.message);
  }
}

// Before handing a URL to Magento or streaming it, re-sign it if stale. Errors carry .status and .userMessage.
async function ensureFreshVideoUrl({ videoUrl, thumbnailUrl, projectId, versionId }) {
  if (!isVideoUrlStale(videoUrl)) return { videoUrl, thumbnailUrl };
  if (!projectId) {
    const err = new Error("Video URL is stale and has no project_id to re-sign");
    err.status = 400;
    err.userMessage = "This video's link has expired and can't be automatically refreshed — try regenerating it";
    throw err;
  }
  const results = await refreshProjectVideoUrls({ ...engine(), projectIds: [projectId] });
  const result = results[projectId];
  if (!result || result.error || !result.videoUrl) {
    const err = new Error(result?.error || "video-engine did not return a fresh video URL for this project");
    err.status = 502;
    err.userMessage = "Couldn't refresh the expired video link — try again";
    throw err;
  }
  const fresh = { videoUrl: result.videoUrl, thumbnailUrl: result.thumbnailUrl || thumbnailUrl };
  if (versionId) {
    videoVersions.updateVersionAndMirror(versionId, fresh)
      .catch((err) => logger.error("Failed to persist re-signed video URL:", err.message, { versionId }));
  }
  return fresh;
}

module.exports = { refreshGeneratedVideoUrls, refreshVersionUrls, ensureFreshVideoUrl };
