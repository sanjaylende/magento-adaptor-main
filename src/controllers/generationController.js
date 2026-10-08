// Starting-frame previews, generation, Update Overlay, status and cancel.
const config = require("../config");
const logger = require("../utils/logger");
const productService = require("../services/productService");
const generatedState = require("../services/generatedState");
const billing = require("../services/billingService");
const videoVersions = require("../repositories/VideoVersionRepository");
const { getPreviewImages } = require("../services/videoEngineService");
const { runGeneration, requestCancel } = require("../services/generationService");
const { VIDEO_TYPES, STATUS, PREVIEW_STATUSES } = require("../config/constants");

const { genKey, mergeVersion } = generatedState;

// Starting-frame picker step: asks Flipick for candidate stills and records them as a "candidates" version.
async function previewImages(req, res) {
  const { uniqueTag, videoType, prompt, aspectRatio } = req.body || {};
  const product = productService.findProduct(uniqueTag);
  if (!product) return res.status(404).json({ error: "Product not found — try Refresh" });
  try {
    const result = await getPreviewImages(product, { videoType, prompt, aspectRatio }, config.flipick);
    const candidatesExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    // A new preview replaces any earlier unused ones for this slot (each "Regenerate these 4" would otherwise leave a
    // stray version behind).
    for (const old of await videoVersions.listVersions(uniqueTag, videoType)) {
      if (old.status === STATUS.CANDIDATES) await videoVersions.deleteVersion(old.id);
    }
    const version = await videoVersions.allocateVersion(uniqueTag, videoType, {
      status: STATUS.CANDIDATES, aspectRatio, prompt, candidateImages: result.images, candidatesExpiresAt,
    });
    // Show the preview state only if the slot has no real video yet; otherwise the existing video stays on screen.
    const shown = generatedState.get(genKey(uniqueTag, videoType));
    if (!shown || PREVIEW_STATUSES.includes(shown.status)) mergeVersion(genKey(uniqueTag, videoType), version);
    res.json({ ...result, versionId: version.id });
  } catch (err) {
    logger.error("Failed to generate preview images:", err.message, { uniqueTag, videoType });
    res.status(502).json({ error: err.message });
  }
}

const snapshotOf = (product) => ({ name: product.name, price: product.price, image: product.image });

// Stored so a later "Update Overlay" can pre-fill with what this version was generated with.
const overlayValuesToStore = (variableValues, variableSelections) =>
  variableValues && Object.keys(variableValues).length ? { values: variableValues, selections: variableSelections || {} } : null;

async function generate(req, res) {
  const {
    uniqueTag, videoType, prompt, aspectRatio, startImageUrl, startImageUrls, brandId,
    overlayFamily, animation, overlayStyle, variableValues, variableSelections, versionId,
  } = req.body || {};
  const noOverlay = !overlayFamily;
  const product = productService.findProduct(uniqueTag);
  if (!product) return res.status(404).json({ error: "Product not found — try Refresh" });

  const key = genKey(uniqueTag, videoType);
  if (generatedState.get(key)?.status === STATUS.GENERATING) {
    return res.status(409).json({ error: `A ${VIDEO_TYPES[videoType] || videoType} video is already generating for this product` });
  }

  // Plan gate: same three reasons as the Shopify adapter (trial_exhausted, subscription_inactive, usage_cap_reached).
  const blocked = await billing.checkGenerationAllowed(videoType);
  if (blocked) return res.status(402).json({ error: blocked });

  // Product facts at generation time, so the list can later flag "Product changed since video generation".
  const productSnapshot = snapshotOf(product);
  const overlayValues = overlayValuesToStore(variableValues, variableSelections);
  let version;
  try {
    if (versionId) {
      // The preview step already allocated a "candidates" version -- advance it to a real render.
      version = await videoVersions.updateVersionAndMirror(versionId, {
        status: STATUS.GENERATING, startImageUrl, startImageUrls, overlayFamily, brandId, productSnapshot, overlayValues,
      });
    }
    if (!version) {
      version = await videoVersions.allocateVersion(uniqueTag, videoType, {
        status: STATUS.GENERATING, aspectRatio, prompt, startImageUrl, startImageUrls,
        overlayFamily, brandId, animation, overlayStyle, productSnapshot, overlayValues,
      });
    }
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
  mergeVersion(key, version);
  res.json({ ok: true });

  runGeneration(
    uniqueTag, product,
    { videoType, prompt, aspectRatio, startImageUrl, startImageUrls, brandId, overlayFamily, noOverlay, animation, overlayStyle, variableValues },
    version.id
  );
}

// "Update Overlay": re-render only the overlay text of a ready video, reusing the engine project (no new AI generation).
async function updateOverlay(req, res) {
  const { uniqueTag, videoType, variableValues, variableSelections } = req.body || {};
  const product = productService.findProduct(uniqueTag);
  if (!product) return res.status(404).json({ error: "Product not found — try Refresh" });

  const key = genKey(uniqueTag, videoType);
  const gen = generatedState.get(key);
  if (!gen || gen.status !== STATUS.READY || !gen.overlayFamily || !gen.projectId) {
    return res.status(400).json({ error: "No existing overlay video to update — use Regenerate instead" });
  }

  let version;
  try {
    version = await videoVersions.allocateVersion(uniqueTag, videoType, {
      status: STATUS.GENERATING, aspectRatio: gen.aspectRatio, overlayFamily: gen.overlayFamily,
      brandId: gen.brandId, productSnapshot: snapshotOf(product),
      overlayValues: overlayValuesToStore(variableValues, variableSelections),
    });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
  mergeVersion(key, version);
  res.json({ ok: true });

  runGeneration(
    uniqueTag, product,
    {
      videoType, mode: "refresh", aspectRatio: gen.aspectRatio, overlayFamily: gen.overlayFamily,
      brandId: gen.brandId, overlayStyle: "custom", variableValues,
    },
    version.id,
    { projectId: gen.projectId }
  );
}

function status(req, res) {
  res.json(generatedState.get(genKey(req.params.uniqueTag, req.params.videoType)) || { status: "none" });
}

// Cancel an in-progress render: we stop tracking it (Flipick has no cancel API, so it keeps running there).
async function cancel(req, res) {
  const { uniqueTag, videoType } = req.params;
  const key = genKey(uniqueTag, videoType);
  const gen = generatedState.get(key);
  if (!gen || gen.status !== STATUS.GENERATING || !gen.currentVersionId) {
    return res.status(400).json({ error: "Nothing in progress for this slot" });
  }
  requestCancel(gen.currentVersionId);
  try {
    const result = await videoVersions.cancelVersion(uniqueTag, videoType, gen.currentVersionId);
    if (result) mergeVersion(key, result.current);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}

module.exports = { previewImages, generate, updateOverlay, status, cancel };
