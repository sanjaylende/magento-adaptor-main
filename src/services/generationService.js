// Runs one generation (or an Update Overlay refresh) to completion for an already-allocated version and records the
// result. Hero Product / Image Transitions are async jobs (polled); Lifestyle is a synchronous call.
const config = require("../config");
const logger = require("../utils/logger");
const videoVersions = require("../repositories/VideoVersionRepository");
const generatedState = require("./generatedState");
const billing = require("./billingService");
const { generateVideo, pollHeroJobUntilSettled } = require("./videoEngineService");
const { STATUS } = require("../config/constants");

const { genKey, mergeVersion } = generatedState;

// Cancel only stops US from tracking a render (Flipick has no cancel API): the render loop sees the version id here.
const cancelRequested = new Set();
const lastProgressPersist = new Map(); // versionId -> { pct, at }

const requestCancel = (versionId) => cancelRequested.add(String(versionId));

// Real job progress from Flipick, clamped so it never moves backwards; persisted at most every 5 points / 15 s.
function applyJobProgress(key, versionId, job) {
  if (job.progress_pct == null) return;
  const pct = Math.max(0, Math.min(100, job.progress_pct));
  const clamped = Math.max(pct, generatedState.get(key)?.progressPct || 0);
  generatedState.set(key, { ...generatedState.get(key), progressPct: clamped });
  const last = lastProgressPersist.get(versionId) || { pct: -1, at: 0 };
  const now = Date.now();
  if (clamped - last.pct >= 5 || now - last.at >= 15000) {
    lastProgressPersist.set(versionId, { pct: clamped, at: now });
    videoVersions.updateVersionAndMirror(versionId, { progressPct: clamped }).catch((err) =>
      logger.error("Failed to persist progress for", key, "-", err.message)
    );
  }
}

function logVideoGenerationFailure({ uniqueTag, videoType, versionId, jobId, params, response }) {
  logger.error("Video generation failed", {
    service: "Flipick video-engine backend",
    serviceUrl: config.flipick.videoEngineBaseUrl,
    uniqueTag,
    videoType,
    versionId,
    jobId: jobId || null,
    request: params,
    response: typeof response === "string" ? { detail: response } : response,
  });
}

async function runGeneration(uniqueTag, product, params, versionId, opts = {}) {
  const { projectId, skipBilling } = opts;
  // A video counts toward usage only when it reaches "ready"; Update Overlay (skipBilling) re-renders text and never counts.
  const countIfBillable = () => (skipBilling ? null : billing.recordVideoCompleted(versionId, params.videoType));
  const key = genKey(uniqueTag, params.videoType);
  const vid = String(versionId);
  try {
    const result = await generateVideo(product, params, projectId ? { ...config.flipick, projectId } : config.flipick);
    if (result.kind === "job") {
      const withJobId = await videoVersions.updateVersionAndMirror(versionId, { jobId: result.jobId });
      mergeVersion(key, withJobId);
      const job = await pollHeroJobUntilSettled(result.jobId, config.flipick, {
        onPoll: (j) => applyJobProgress(key, versionId, j),
        shouldAbort: () => cancelRequested.has(vid),
      });
      if (job.aborted || cancelRequested.has(vid)) return;
      if (job.status !== "completed" || !job.video_url) {
        logVideoGenerationFailure({ uniqueTag, videoType: params.videoType, versionId, jobId: result.jobId, params, response: job });
        mergeVersion(key, await videoVersions.updateVersionAndMirror(versionId, {
          status: STATUS.ERROR, error: job.error?.message || "Render failed with no video returned.",
        }));
        return;
      }
      if (cancelRequested.has(vid)) return;
      mergeVersion(key, await videoVersions.updateVersionAndMirror(versionId, {
        status: STATUS.READY, videoUrl: job.video_url, thumbnailUrl: job.thumbnail_url || null, projectId: job.project_id || null,
      }));
      await countIfBillable();
    } else {
      if (cancelRequested.has(vid)) return;
      mergeVersion(key, await videoVersions.updateVersionAndMirror(versionId, {
        status: STATUS.READY, videoUrl: result.videoUrl, thumbnailUrl: result.thumbnailUrl,
        projectId: result.projectId || null, variantId: result.variantId || null,
      }));
      await countIfBillable();
    }
  } catch (err) {
    if (cancelRequested.has(vid)) return;
    logVideoGenerationFailure({ uniqueTag, videoType: params.videoType, versionId, params, response: err.stack || err.message });
    mergeVersion(key, await videoVersions.updateVersionAndMirror(versionId, { status: STATUS.ERROR, error: err.message }));
  } finally {
    cancelRequested.delete(vid);
    lastProgressPersist.delete(vid);
  }
}

module.exports = { runGeneration, requestCancel };
