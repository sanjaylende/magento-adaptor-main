// MP4 download. The UI asks (authenticated) for a link, then navigates to it with a plain <a href>, which cannot carry an
// Authorization header, so the link carries a short-lived signed token instead.
const { Readable } = require("stream");
const logger = require("../utils/logger");
const { signToken, verifyToken } = require("../utils/crypto");
const { runWithTenant } = require("../context");
const tenants = require("../services/tenantService");
const productService = require("../services/productService");
const generatedState = require("../services/generatedState");
const videoVersions = require("../repositories/VideoVersionRepository");
const { ensureFreshVideoUrl } = require("../services/videoUrlService");
const { STATUS } = require("../config/constants");

function downloadFilename(product, uniqueTag, videoType) {
  const base = ((product && product.name) || uniqueTag).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `${base || videoType}-${videoType}.mp4`;
}

function link(req, res) {
  const { uniqueTag, videoType } = req.params;
  const token = signToken({ typ: "dl", inst: req.installation.id, store: req.store.id, tag: uniqueTag, vt: videoType, vid: req.query.versionId || null }, 300);
  res.json({ url: `/dl/${token}` });
}

// Public route: the signed token identifies the store and the video.
async function download(req, res) {
  const claims = verifyToken(req.params.token);
  if (!claims || claims.typ !== "dl") return res.status(401).json({ error: "This download link has expired. Go back and click Download again." });
  const installation = await tenants.getInstallation(claims.inst);
  const store = await tenants.getStoreById(claims.store);
  if (!installation || !store || store.installationId !== installation.id) return res.status(404).json({ error: "Not found" });
  const magento = await tenants.magentoConfigFor(installation, store);
  return runWithTenant({ installation, store, magento }, () => stream(req, res, claims));
}

async function stream(req, res, claims) {
  const { tag: uniqueTag, vt: videoType, vid: versionId } = claims;
  await generatedState.ensureLoaded();
  const product = productService.findProduct(uniqueTag);
  const key = generatedState.genKey(uniqueTag, videoType);
  let record;
  if (versionId) {
    const version = (await videoVersions.listVersions(uniqueTag, videoType)).find((v) => String(v.id) === String(versionId));
    if (!version || version.status !== STATUS.READY) return res.status(404).json({ error: "Version not found or not ready" });
    record = { videoUrl: version.videoUrl, thumbnailUrl: version.thumbnailUrl, projectId: version.projectId, versionId: version.id };
  } else {
    const gen = generatedState.get(key);
    if (!gen || gen.status !== STATUS.READY) return res.status(400).json({ error: "No ready video for this product" });
    record = { videoUrl: gen.videoUrl, thumbnailUrl: gen.thumbnailUrl, projectId: gen.projectId, versionId: gen.currentVersionId };
  }

  let fresh;
  try {
    fresh = await ensureFreshVideoUrl(record);
  } catch (err) {
    logger.error("Failed to re-sign video URL before download:", err.message, { key, versionId: record.versionId });
    return res.status(err.status || 502).json({ error: err.userMessage || "Couldn't refresh the expired video link — try again" });
  }
  try {
    const videoRes = await fetch(fresh.videoUrl);
    if (!videoRes.ok || !videoRes.body) throw new Error(`Fetching video for download failed (${videoRes.status})`);
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="${downloadFilename(product, uniqueTag, videoType)}"`);
    Readable.fromWeb(videoRes.body).pipe(res);
  } catch (err) {
    logger.error("Failed to stream video download:", err.message, { key, versionId: record.versionId });
    if (!res.headersSent) res.status(502).json({ error: "Couldn't download the video — try again" });
  }
}

module.exports = { link, download };
