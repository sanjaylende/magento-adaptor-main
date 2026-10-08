// "Add to product page": writes the video URL (+ thumbnail) onto the Magento product's two custom attributes; the
// module's storefront block then renders a <video>. A product holds ONE video URL, so pushing one video type replaces
// whichever type was shown before (that type's "on product page" flag is cleared).
const config = require("../config");
const { tenant } = require("../context");
const logger = require("../utils/logger");
const productService = require("../services/productService");
const generatedState = require("../services/generatedState");
const videoVersions = require("../repositories/VideoVersionRepository");
const { pushVideoToProduct } = require("../services/magentoPublishService");
const { ensureFreshVideoUrl } = require("../services/videoUrlService");
const { VIDEO_TYPES, STATUS } = require("../config/constants");

const { genKey, mergeVersion } = generatedState;

async function pushToMagento(req, res) {
  const { uniqueTag, videoType } = req.params;
  const product = productService.findProduct(uniqueTag);
  if (!product) return res.status(404).json({ error: "Product not found — try Refresh" });

  const key = genKey(uniqueTag, videoType);
  let gen = generatedState.get(key);
  if (!gen || gen.status !== STATUS.READY) return res.status(400).json({ error: "No ready video for this product" });

  try {
    const fresh = await ensureFreshVideoUrl({
      videoUrl: gen.videoUrl, thumbnailUrl: gen.thumbnailUrl, projectId: gen.projectId, versionId: gen.currentVersionId,
    });
    gen = { ...gen, ...fresh };
    generatedState.set(key, gen);
  } catch (err) {
    logger.error("Failed to re-sign video URL before Magento push:", err.message, { key, projectId: gen.projectId });
    return res.status(err.status || 502).json({ error: err.userMessage || "Couldn't refresh the expired video link before pushing — try again" });
  }

  try {
    await pushVideoToProduct({
      baseUrl: tenant().magento.baseUrl,
      accessToken: tenant().magento.accessToken,
      magentoSku: product.magentoSku,
      videoUrl: gen.videoUrl,
      thumbnailUrl: gen.thumbnailUrl,
    });
    const pushedAt = new Date().toISOString();
    const version = gen.currentVersionId
      ? await videoVersions.updateVersionAndMirror(gen.currentVersionId, { pushedToMagento: true, pushedAt })
      : null;
    if (version) mergeVersion(key, version);
    else generatedState.set(key, { ...gen, pushedToMagento: true, pushedAt });
    // The product now shows THIS video: any other type previously pushed for it is no longer the live one.
    for (const otherType of Object.keys(VIDEO_TYPES)) {
      if (otherType === videoType) continue;
      const otherKey = genKey(uniqueTag, otherType);
      const other = generatedState.get(otherKey);
      if (other?.pushedToMagento && other.currentVersionId) {
        mergeVersion(otherKey, await videoVersions.updateVersionAndMirror(other.currentVersionId, { pushedToMagento: false }));
      }
    }
    res.json({ ok: true, pushed: true });
  } catch (err) {
    logger.error("Failed to push video to Magento product:", err.message, { key, sku: product.magentoSku });
    res.status(502).json({ error: err.message });
  }
}

module.exports = { pushToMagento };
