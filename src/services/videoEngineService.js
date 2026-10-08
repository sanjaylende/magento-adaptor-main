// Talks to the Flipick video engine / VVP backend: prompt defaults, starting-frame previews, generation, job polling and
// remote cleanup. Also decides which overlay values a render sends.
const {
  generateHeroProductVideo, generateImageTransitionVideo, pollVideoEngineJob, pollVideoEngineJobUntilSettled,
  getCategoryDefault, generatePreviewImages,
} = require("../integrations/videoEngineClient");
const { generateVvpVideo, deleteVvpVideos } = require("../integrations/flipickClient");
const { getThemeForCategory } = require("../config/categoryThemes");
const { formatMoney } = require("../utils/money");

// Sending "" still renders the template's label for that token (e.g.
// "MRP:") with nothing after it -- omitting the key entirely is what
// actually removes the label+value pair from the overlay. Both overlay
// styles below rely on this.
function dropEmpty(raw) {
  return Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== ""));
}

// The original (and still default) overlay style -- same 5-key union map
// circular-importer sends -- a template ignores whichever keys it has no
// matching token for. circular-importer's own templates are INR-designed and
// prefix currency themselves; a Shopify-sourced product carries its OWN
// store's currency (product.currencyCode, stamped by normalize.js) instead,
// since Shopify stores are frequently not USD -- baked in here via
// formatMoney rather than assuming "$".
function offersOverlayValues(product) {
  return dropEmpty({
    ProductName: product.name,
    Description: "",
    SalePrice: formatMoney(product.price, product.currencyCode),
    StrikethroughPrice: product.offer ? formatMoney(product.offer.originalPrice, product.currencyCode) : "",
    Offer: product.offer ? `${product.offer.discountPercent}% off` : "",
  });
}

// Custom overlay style -- used whenever the user has named at least one
// overlay token in the modal's manual key/value rows (v1, v2, ..., or a
// named token like Description/SalePrice -- there's no fixed set, since
// templates don't agree on one convention). Each row's value is either
// free-typed or picked from this product's own attribute options below;
// either way it's already a resolved literal string by the time it gets
// here, so there's nothing left to look up server-side.
//
// Deliberately NOT dropEmpty()'d, unlike offersOverlayValues -- that helper
// exists because Offers-style tokens sit inside a "Label: value" layout
// element, where an empty string still leaves the label visible. These are
// raw positional/named tokens with no such wrapper: omitting a key entirely
// leaves Flipick's own placeholder text ($$v3$$, literally) on screen,
// while sending it with an empty string actually blanks it -- so every row
// the user named must be sent, value or not.
//
// Positional slots the user never added a row for at all (e.g. a template
// with v1-v5 where they only mapped v1) hit the same problem one level up --
// there's no row to send blank, so the key is simply absent and Flipick's
// $$v2$$/$$v3$$/... placeholders stay on screen. Flipick's own overlay
// system only recognizes exactly v1-v5 as positional slots (confirmed via
// the LTX backend's ALLOWED_KEYS constant), so all five are always sent,
// defaulting to blank -- any the user did map simply override the default.
const STANDARD_POSITIONAL_KEYS = ["v1", "v2", "v3", "v4", "v5"];

function customOverlayValues(variableValues) {
  const positionalDefaults = Object.fromEntries(STANDARD_POSITIONAL_KEYS.map((k) => [k, ""]));
  return { ...positionalDefaults, ...(variableValues || {}) };
}

function resolveOverlayValues(product, { overlayStyle, variableValues } = {}) {
  return overlayStyle === "custom"
    ? customOverlayValues(variableValues)
    : offersOverlayValues(product);
}

// Seeds the Generate Video modal's Prompt field default. Lifestyle uses the
// category-theme registry (soft default here, unlike generateVideo below --
// an unmapped category just falls back to empty rather than blocking the
// user from typing their own prompt). Hero Product fetches Flipick's own
// per-category suggestion.
async function getPromptDefault(product, videoType, options) {
  // Image Transitions' preview images take the identical hero_product-style
  // branch server-side, so the same category-based default prompt applies.
  if (videoType === "hero_product" || videoType === "image_transition") {
    const result = await getCategoryDefault({
      baseUrl: options.videoEngineBaseUrl,
      apiKey: options.videoEngineApiKey,
      category: product.category,
    });
    return result.suggested_prompt || "";
  }
  try {
    return getThemeForCategory(product.category);
  } catch {
    return "";
  }
}

// The 4-option starting-frame picker step. sourceImageUrl is the product's own
// Shopify CDN image -- already public, no signing needed (unlike
// circular-importer's private-GCS cropped_image_path). Sent for all three
// video types now (required for hero_product/image_transition, optional for
// lifestyle -- falls back to Flipick's photo-less Imagen-4 variations when
// the product has no image).
async function getPreviewImages(product, { videoType, prompt, aspectRatio }, options) {
  if ((videoType === "hero_product" || videoType === "image_transition") && !product.image) {
    const label = videoType === "hero_product" ? "Hero Product" : "Image Transitions";
    throw new Error(`Product has no image -- ${label} video needs one`);
  }
  const theme = videoType === "lifestyle" ? prompt || getThemeForCategory(product.category) : undefined;

  return generatePreviewImages({
    baseUrl: options.videoEngineBaseUrl,
    apiKey: options.videoEngineApiKey,
    videoType,
    category: product.category,
    productName: product.name,
    aspectRatio,
    theme,
    sourceImageUrl: product.image || undefined,
    // creative_brief applies to both hero_product and image_transition (see
    // videoEngineClient.js's generatePreviewImages) -- only lifestyle uses
    // theme instead.
    creativeBrief: videoType !== "lifestyle" ? prompt || undefined : undefined,
  });
}

// Kicks off generation. hero_product and image_transition are both async --
// return { jobId } for the caller to poll via pollHeroJob/
// pollHeroJobUntilSettled (same video-engine job/poll mechanism for both).
// lifestyle is synchronous -- returns the final { videoUrl, thumbnailUrl }
// directly.
//
// overlayFamily is a single choice shared across all three video types (the
// modal's Overlay Family picker, replacing the old per-type Template
// picker) -- generation itself no longer references a template project at
// all; the family's design is composited onto whichever base video Flipick
// generates (see backend vvpEngine.js's applyOverlayFamilyToShot).
async function generateVideo(product, { videoType, mode = "regenerate", prompt, aspectRatio, startImageUrl, startImageUrls, brandId, overlayFamily, noOverlay, animation, overlayStyle, variableValues }, options) {
  const overlay = resolveOverlayValues(product, { overlayStyle, variableValues });
  // "refresh" (Update Overlay): reuse the base video already stored at
  // options.projectId verbatim and only re-render the overlay/VO with the
  // new values -- no fresh AI generation, no new base video, no billing
  // charge (the caller is responsible for that last part, not this
  // function). Mirrors the VVP branch's own long-standing mode==="refresh"
  // handling below, extended to the two video-engine types.
  const projectId = mode === "refresh" ? options.projectId : undefined;

  if (videoType === "hero_product") {
    if (!product.image) throw new Error("Product has no image -- Hero Product video needs one");
    const { job_id: jobId } = await generateHeroProductVideo({
      baseUrl: options.videoEngineBaseUrl,
      apiKey: options.videoEngineApiKey,
      productName: product.name,
      category: product.category,
      aspectRatio,
      sourceImageUrl: product.image,
      overlayFamily,
      noOverlay,
      brandId,
      retailerName: options.retailerName,
      sourceRef: product.uniqueTag,
      overlayValues: overlay,
      creativeBrief: prompt || undefined,
      startImageUrl,
      projectId,
    });
    return { kind: "job", jobId };
  }

  if (videoType === "image_transition") {
    if (!projectId && !product.image) throw new Error("Product has no image -- Image Transitions video needs one");
    const { job_id: jobId } = await generateImageTransitionVideo({
      baseUrl: options.videoEngineBaseUrl,
      apiKey: options.videoEngineApiKey,
      productName: product.name,
      category: product.category,
      aspectRatio,
      startImageUrls,
      overlayFamily,
      noOverlay,
      brandId,
      retailerName: options.retailerName,
      sourceRef: product.uniqueTag,
      overlayValues: overlay,
      animation,
      projectId,
    });
    return { kind: "job", jobId };
  }

  // A refresh call reuses the stored project verbatim and never needs theme
  // at all (flipickClient's own validity check only requires theme/category/
  // name when projectId is absent) -- computing it unconditionally would
  // throw on an "Update Overlay" call for any product whose category isn't
  // in CATEGORY_THEME_REGISTRY, even though that value would never reach
  // Flipick either way.
  const theme = mode === "refresh" ? undefined : (prompt || getThemeForCategory(product.category));
  const response = await generateVvpVideo({
    baseUrl: options.baseUrl,
    apiKey: options.vvpApiKey,
    tenantId: options.tenantId,
    projectId: mode === "refresh" ? options.projectId : undefined,
    forceNewProject: mode === "regenerate",
    overlayFamily,
    noOverlay,
    externalRef: product.uniqueTag,
    variantName: product.name,
    theme,
    category: product.category,
    name: product.name,
    values: overlay,
    brandId,
    startImageUrl,
    aspectRatio,
    // Optional -- falls back to Flipick's photo-less scene when the product
    // has no image, same as getPreviewImages above.
    source: product.image ? { type: "image", image_data: product.image } : undefined,
  });
  if (!response.video_url) {
    throw new Error(response.warnings?.join("; ") || "Render failed with no video returned.");
  }
  return {
    kind: "done",
    videoUrl: response.video_url,
    thumbnailUrl: response.thumbnail_url || null,
    projectId: response.project_id,
    variantId: response.variant_id,
  };
}

async function pollHeroJob(jobId, options) {
  return pollVideoEngineJob({ baseUrl: options.videoEngineBaseUrl, apiKey: options.videoEngineApiKey, jobId });
}

async function pollHeroJobUntilSettled(jobId, options, { onPoll, shouldAbort } = {}) {
  return pollVideoEngineJobUntilSettled({
    baseUrl: options.videoEngineBaseUrl, apiKey: options.videoEngineApiKey, jobId, onPoll, shouldAbort,
  });
}

// Best-effort cleanup of the Flipick-side project when a generated video is
// deleted locally -- same mechanism for both video types (hero_product and
// lifestyle both end up as a `projects` row on Flipick's side).
async function deleteVideo({ projectId, variantId }, options) {
  return deleteVvpVideos({
    baseUrl: options.baseUrl,
    apiKey: options.vvpApiKey,
    tenantId: options.tenantId,
    projectIds: [projectId],
    variantIds: [variantId],
  });
}
module.exports = { getPromptDefault, getPreviewImages, generateVideo, pollHeroJob, pollHeroJobUntilSettled, deleteVideo };
