// Calls Flipick's Video Engine API (video_type=hero_product) -- mirrors
// circular-importer's flipick-client/videoEngineClient.js exactly (same
// endpoints/payloads), adapted to this project's params-based style (baseUrl/
// apiKey passed explicitly, not read from process.env inside the module) to
// match flipickClient.js's existing convention here.
//
// Unlike vvpClient-style calls (generateVvpVideo), which are synchronous,
// this API is asynchronous: POST /generate returns a job_id immediately
// (202), and the caller must poll GET /jobs/:jobId until status settles to
// completed/failed.
//
// Auth is a per-tenant Bearer key (one video_engine_api_keys row identifies
// the tenant server-side), NOT the shared X-Api-Key vvpClient-style calls
// use -- there's no tenant_id field in any of these request bodies.

// Registers this project with LTX's durable per-project webhook subscription
// (video_engine_project_callbacks) -- lets a LATER Studio-side edit (VO text,
// overlay/price) auto-notify our own /api/webhooks/video-engine receiver
// instead of requiring the admin to click Refresh. PUBLIC_BASE_URL falls
// back to localhost for this session's local-only testing; set it to this
// server's real public address once deployed.
function videoEngineCallbackUrl() {
  const base = process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 4100}`;
  return `${base}/api/webhooks/video-engine`;
}

async function generateHeroProductVideo({ baseUrl, apiKey, productName, category, aspectRatio, sourceImageUrl, overlayFamily, noOverlay, brandId, retailerName, sourceRef, overlayValues, creativeBrief, startImageUrl, projectId }) {
  if (!baseUrl || !apiKey) throw new Error("baseUrl and apiKey are required");
  if (!productName) throw new Error("productName is required");
  if (!sourceImageUrl) throw new Error("sourceImageUrl is required");

  const payload = {
    video_type: "hero_product",
    category: category || "General",
    aspect_ratio: ["9:16", "16:9", "1:1"].includes(aspectRatio) ? aspectRatio : "16:9",
    duration_seconds: 8, // fixed in this version, same as circular-importer
    product_name: productName,
    overlay_family: overlayFamily || undefined,
    // Explicit "render with no overlay at all" -- distinct from omitting
    // overlay_family, which the backend treats as "use the tenant's default
    // template" (see performVvpGeneration's noOverlay param). Set only when
    // the merchant leaves the Overlay Family picker at "(none)".
    no_overlay: !!noOverlay,
    // brand_id (an explicit UUID) always wins if ever set; brand_name is the
    // real path today -- same resolveBrandId the family listing/preview
    // routes use, so a family only visible under this brand (e.g. Sterling's
    // "eCommerce") can actually be generated with, not just previewed.
    brand_id: brandId || undefined,
    brand_name: retailerName || undefined,
    source_ref: sourceRef || undefined,
    source: { type: "image", image_data: sourceImageUrl },
    overlay_values: overlayValues || {},
    creative_brief: creativeBrief || undefined,
    start_image_url: startImageUrl || undefined,
    // Hero Product has never cached/reused a base video by default -- every
    // call renders fresh UNLESS projectId is supplied (an overlay-only
    // "Update Overlay" call), in which case the video-engine backend reuses
    // that exact base video verbatim and only re-renders the overlay/VO --
    // see project_id below.
    force_new_project: !projectId,
    // Optional: reuses a known, already-created base video verbatim (the
    // backend's "Refresh" path) instead of rendering a new one -- set only
    // for the overlay-only "Update Overlay" flow.
    project_id: projectId || undefined,
    // Registers a durable per-project subscription on Flipick's side -- a
    // LATER Studio-side VO/overlay edit auto-notifies our own
    // /api/webhooks/video-engine receiver instead of requiring a manual
    // Refresh click.
    callback_url: videoEngineCallbackUrl(),
  };

  const res = await fetch(`${baseUrl}/api/v2/video-engine/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Hero Product video generation failed (${res.status}): ${body.error || JSON.stringify(body)}`);
  }
  return body; // { job_id, status_url }
}

// Image Transitions: single 8s shot assembled from 4 already-final preview
// stills (from generatePreviewImages below, video_type="image_transition" --
// the identical hero_product-style generation) via deterministic FFmpeg on
// Flipick's side -- no Veo/Omni call, no product-photo compositing at
// generate time (the 4 stills already have the real product baked in from
// the preview step). Same async job/poll contract as generateHeroProductVideo
// above; the only real difference is start_image_urls (all 4, required)
// instead of source/start_image_url/creative_brief.
async function generateImageTransitionVideo({ baseUrl, apiKey, productName, category, aspectRatio, startImageUrls, overlayFamily, noOverlay, brandId, retailerName, sourceRef, overlayValues, animation, projectId }) {
  if (!baseUrl || !apiKey) throw new Error("baseUrl and apiKey are required");
  if (!productName) throw new Error("productName is required");
  // projectId (an overlay-only "Update Overlay" call) reuses the existing
  // base video verbatim -- the backend never re-touches the 4 stills in
  // that case, so they aren't required here either.
  if (!projectId && (!Array.isArray(startImageUrls) || startImageUrls.length !== 4)) {
    throw new Error("startImageUrls must be an array of exactly 4 URLs (from generatePreviewImages)");
  }

  const payload = {
    video_type: "image_transition",
    category: category || "General",
    aspect_ratio: ["9:16", "16:9", "1:1"].includes(aspectRatio) ? aspectRatio : "16:9",
    duration_seconds: 8,
    product_name: productName,
    overlay_family: overlayFamily || undefined,
    // See generateHeroProductVideo's identical comment.
    no_overlay: !!noOverlay,
    // See generateHeroProductVideo's identical comment -- brand_name is what
    // actually resolves brand-scoped families (e.g. Sterling's "eCommerce")
    // during real generation, not just listing/preview.
    brand_id: brandId || undefined,
    brand_name: retailerName || undefined,
    source_ref: sourceRef || undefined,
    overlay_values: overlayValues || {},
    start_image_urls: startImageUrls || undefined,
    // Same reasoning as Hero Product -- reuses the existing base video
    // verbatim (and re-renders only the overlay/VO) when projectId is
    // supplied, instead of always rendering fresh.
    force_new_project: !projectId,
    project_id: projectId || undefined,
    // Optional explicit override for the transition effect. Omitted ->
    // video-engine inherits whichever effect the resolved Video Template
    // itself uses.
    animation: animation || undefined,
  };

  const res = await fetch(`${baseUrl}/api/v2/video-engine/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Image Transitions video generation failed (${res.status}): ${body.error || JSON.stringify(body)}`);
  }
  return body; // { job_id, status_url }
}

// Single poll -- caller loops this on its own interval until status leaves
// queued/processing/rendering.
async function pollVideoEngineJob({ baseUrl, apiKey, jobId }) {
  if (!baseUrl || !apiKey) throw new Error("baseUrl and apiKey are required");
  const res = await fetch(`${baseUrl}/api/v2/video-engine/jobs/${jobId}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Polling Hero Product video job failed (${res.status}): ${body.error || JSON.stringify(body)}`);
  }
  return body; // { job_id, status, project_id, video_url, thumbnail_url, error }
}

// onPoll (optional): called with the raw job body on every poll, including
// the settling one, before the settle check -- lets a caller surface
// progress_pct/status on each tick instead of only ever seeing the final
// result. shouldAbort (optional): checked before each poll and before each
// sleep; returns { aborted: true, ...lastJobSeen } instead of throwing or
// waiting for a real settle, so a caller can stop watching a job it no
// longer cares about (this does NOT cancel the render on Flipick's side --
// there's no API for that -- it only stops US from polling further).
async function pollVideoEngineJobUntilSettled({ baseUrl, apiKey, jobId, intervalMs = 4000, maxAttempts = 120, onPoll, shouldAbort }) {
  let lastJob = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (shouldAbort && shouldAbort()) return { aborted: true, ...(lastJob || {}) };
    const job = await pollVideoEngineJob({ baseUrl, apiKey, jobId });
    lastJob = job;
    if (onPoll) onPoll(job);
    if (job.status === "completed" || job.status === "failed") return job;
    if (shouldAbort && shouldAbort()) return { aborted: true, ...job };
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Hero Product video job ${jobId} did not settle after ${Math.round((maxAttempts * intervalMs) / 1000)}s`);
}

// Fetches the category's default Hero Product prompt/tone, to seed the
// Prompt field's default when Video Type=Hero Product. Falls back to
// Flipick's own generic category rather than erroring (only ever used to
// seed an editable field).
async function getCategoryDefault({ baseUrl, apiKey, category }) {
  if (!baseUrl || !apiKey) throw new Error("baseUrl and apiKey are required");
  const res = await fetch(`${baseUrl}/api/v2/video-engine/category-defaults?category=${encodeURIComponent(category || "General")}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Fetching category default failed (${res.status}): ${body.error || JSON.stringify(body)}`);
  }
  return body; // { category_matched, suggested_prompt, vo_tone_default }
}

// Generates 4 candidate starting-frame images to pick from before committing
// to the real (expensive) Veo render -- synchronous, no job/poll needed. Both
// video types now composite the real product photo in when one is available
// (sourceImageUrl) -- optional for lifestyle (falls back to Flipick's
// photo-less Imagen-4 variations when absent), required for hero_product.
async function generatePreviewImages({ baseUrl, apiKey, videoType, category, productName, aspectRatio, theme, sourceImageUrl, creativeBrief }) {
  if (!baseUrl || !apiKey) throw new Error("baseUrl and apiKey are required");
  if (!productName) throw new Error("productName is required");

  // Was `videoType === "hero_product" ? "hero_product" : "lifestyle"` --
  // silently collapsed any other value (including image_transition) to
  // "lifestyle". image_transition needs the identical hero_product-style
  // branch server-side (real photo baked in, camera-angle-convention
  // prompts), so it must pass through as its own literal value.
  const resolvedVideoType = ["hero_product", "lifestyle", "image_transition"].includes(videoType)
    ? videoType
    : "lifestyle";
  const payload = {
    video_type: resolvedVideoType,
    category: category || "General",
    aspect_ratio: ["9:16", "16:9", "1:1"].includes(aspectRatio) ? aspectRatio : "16:9",
    product_name: productName,
    theme: resolvedVideoType === "lifestyle" ? theme || undefined : undefined,
    source: sourceImageUrl ? { type: "image", image_data: sourceImageUrl } : undefined,
    // creative_brief feeds Flipick's camera-angle-convention prompt for BOTH
    // hero_product and image_transition -- only lifestyle uses theme instead.
    creative_brief: resolvedVideoType !== "lifestyle" ? creativeBrief || undefined : undefined,
  };

  const res = await fetch(`${baseUrl}/api/v2/video-engine/preview-images`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Preview image generation failed (${res.status}): ${body.error || JSON.stringify(body)}`);
  }
  return body; // { images: [{ url }, { url }, { url }, { url }] }
}

// Lists this tenant's Brand-tab Overlay Families -- one shared catalog for
// all three video types (unlike the old per-host Video Template catalogs).
// Brand-scoped first, THEN narrowed by aspectRatio to families that have a
// variant for that size -- same two-stage shape the old Video Template
// picker used (tenant+brand, then size). retailerName (this app's own
// RETAILER_NAME) is resolved to a brand_id fresh on Flipick's side per
// request, rather than trusting a brand_id baked statically into the API
// key row -- that static approach can't survive this same key ever being
// used for more than one retailer/brand.
async function listOverlayFamilies({ baseUrl, apiKey, aspectRatio, retailerName }) {
  if (!baseUrl || !apiKey) throw new Error("baseUrl and apiKey are required");

  const params = new URLSearchParams();
  if (["9:16", "16:9", "1:1", "5:4"].includes(aspectRatio)) params.set("aspect_ratio", aspectRatio);
  if (retailerName) params.set("brand_name", retailerName);
  const qs = params.toString();
  const url = `${baseUrl}/api/v2/video-engine/overlay-families${qs ? `?${qs}` : ""}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Listing Overlay Families failed (${res.status}): ${body.error || JSON.stringify(body)}`);
  }
  return body.families || []; // [{ name, isSystem, sizes: [...], anySize, variables: [...] }]
}

// Live-renders a preview PNG for one Overlay Family at a given aspect ratio
// -- GET /overlay-families/:name/preview, the API-key-authenticated sibling
// of Studio's own (JWT-only) template preview. Same brand_name resolution as
// listOverlayFamilies above, so a caller can only ever preview a family it
// could actually pick from that same (brand-scoped) listing. Returns the
// raw fetch Response rather than a parsed body: this endpoint serves image
// bytes, not JSON, and the caller (server.js) streams res.body straight
// through rather than buffering a PNG into memory just to re-serialize it.
// productAttributes (from getProductAttributeOptions, keyed by attribute
// key -- productName/category/price/mrp/offer/metafield:...) lets the
// preview show this product's own values for whichever declared overlay
// fields the backend can unambiguously map (price/strike/title/subtitle) --
// only the four attribute keys that mapping actually uses are forwarded,
// each prefixed attr_ so they can't collide with aspect_ratio/brand_name.
const PRODUCT_ATTRS_FORWARDED = ["price", "mrp", "productName", "category"];
async function getOverlayFamilyPreview({ baseUrl, apiKey, familyName, aspectRatio, retailerName, productAttributes }) {
  if (!baseUrl || !apiKey) throw new Error("baseUrl and apiKey are required");
  if (!familyName) throw new Error("familyName is required");
  const params = new URLSearchParams({ aspect_ratio: aspectRatio });
  if (retailerName) params.set("brand_name", retailerName);
  if (productAttributes) {
    for (const key of PRODUCT_ATTRS_FORWARDED) {
      if (productAttributes[key]) params.set(`attr_${key}`, productAttributes[key]);
    }
  }
  const url = `${baseUrl}/api/v2/video-engine/overlay-families/${encodeURIComponent(familyName)}/preview?${params.toString()}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Fetching overlay preview failed (${res.status}): ${body.error || JSON.stringify(body)}`);
  }
  return res;
}

// Re-signs stored video/thumbnail URLs for one or more projects -- the ones
// this app persists (generated_videos.project_id) are v4 GCS signed URLs
// that expire 7 days after generation (see LTX backend's utils/gcs.js), so a
// video/thumbnail generated more than a week ago 404s/ORB-blocks in the
// browser unless re-signed. Batched: one call refreshes every ready record
// at once instead of one HTTP round-trip per record.
async function refreshProjectVideoUrls({ baseUrl, apiKey, projectIds }) {
  if (!baseUrl || !apiKey) throw new Error("baseUrl and apiKey are required");
  if (!Array.isArray(projectIds) || !projectIds.length) return {};

  const res = await fetch(`${baseUrl}/api/v2/video-engine/projects/refresh-urls`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ project_ids: projectIds }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Refreshing video URLs failed (${res.status}): ${body.error || JSON.stringify(body)}`);
  }
  return body.results || {}; // { [projectId]: { videoUrl, thumbnailUrl, expiresAt, refreshed } | { error } }
}

// GCS v4 signed URLs encode their own validity window in the query string
// (X-Goog-Date + X-Goog-Expires, seconds) -- parsing that locally lets a
// caller check whether a stored URL still has safe life left WITHOUT paying
// for a refreshProjectVideoUrls round-trip on every use, and only pay that
// cost when the URL is actually stale (or its format can't be read at all).
const SIGNED_URL_STALE_BUFFER_MS = 60 * 60 * 1000; // re-sign an hour early rather than race the exact expiry instant

function gcsSignedUrlExpiresAt(url) {
  try {
    const params = new URL(url).searchParams;
    const date = params.get("X-Goog-Date"); // e.g. "20260824T115058Z"
    const expiresSeconds = Number(params.get("X-Goog-Expires"));
    if (!date || !expiresSeconds) return null;
    const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`;
    const signedAt = new Date(iso);
    return isNaN(signedAt.getTime()) ? null : new Date(signedAt.getTime() + expiresSeconds * 1000);
  } catch {
    return null;
  }
}

// Unparseable/unrecognized URL format is treated as stale -- safer to pay for
// an unnecessary re-sign than to hand a caller a URL we can't actually vouch
// for.
function isVideoUrlStale(url) {
  if (!url) return true;
  const expiresAt = gcsSignedUrlExpiresAt(url);
  return !expiresAt || expiresAt.getTime() - Date.now() < SIGNED_URL_STALE_BUFFER_MS;
}

module.exports = { generateHeroProductVideo, generateImageTransitionVideo, pollVideoEngineJob, pollVideoEngineJobUntilSettled, getCategoryDefault, generatePreviewImages, listOverlayFamilies, getOverlayFamilyPreview, refreshProjectVideoUrls, isVideoUrlStale };
