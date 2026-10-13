// Mirrors circular-importer's flipick-client/{vvpClient,sponsoredAdsClient}.js
// exactly — same endpoints, same payload shape — since that's the confirmed
// working contract against the real hosted Flipick backend. Kept standalone
// here rather than imported, per the decision to not couple this project to
// circular-importer's Express app / Postgres DB.

const VVP_ENDPOINT = "/api/v1/vvp-generation/generate";

// The target project ("base video") is resolved-or-created by Flipick, keyed
// on (tenant, theme, category, name): the first call for a given triple
// generates a brand-new Veo clip + voice-over + thumbnail; later calls for
// the same triple (e.g. a different product with the same name — or the
// same product's overlay being regenerated) reuse it.
//
// Two call shapes, both routed through here (mirrors circular-importer's
// current vvpClient.js):
//  - Refresh (overlay only): pass `projectId` so Flipick reuses that exact
//    base video and only re-renders the overlay with fresh `values`.
//  - Regenerate (new base video + overlay): omit `projectId`, pass
//    `forceNewProject` to ask for a brand-new Veo clip instead of reusing
//    whatever already exists for that (theme, category, name) triple.
const { loggedFetch } = require("../utils/httpLog");

async function generateVvpVideo({ baseUrl, apiKey, tenantId, projectId, overlayFamily, noOverlay, externalRef, variantName, theme, category, name, values, forceNewProject, brandId, retailerName, startImageUrl, aspectRatio, source, promptIsFinal }) {
  if (!baseUrl || !apiKey) throw new Error("baseUrl and apiKey are required");
  if (!tenantId) throw new Error("tenantId is required");
  if (!externalRef) throw new Error("externalRef is required");
  if (!projectId && !(theme && category && name)) {
    throw new Error("either projectId, or theme+category+name, is required");
  }

  const payload = {
    tenant_id: tenantId,
    project_id: projectId || undefined,
    overlay_family: overlayFamily || undefined,
    // Explicit "render with no overlay at all" -- distinct from omitting
    // overlay_family, which the backend treats as "use the tenant's default
    // template" (see performVvpGeneration's noOverlay param). Set only when
    // the merchant leaves the Overlay Family picker at "(none)".
    no_overlay: !!noOverlay,
    external_ref: externalRef,
    variant_name: variantName || undefined,
    theme: theme || undefined,
    category: category || undefined,
    name: name || undefined,
    values: values || {},
    force_new_project: forceNewProject || undefined,
    // Only used when actually creating a new base video — a reused one
    // keeps whatever brand/start frame it was first created with.
    brand_id: brandId || undefined,
    // brand_name is the real path today: same resolveBrandId the engine's family listing/generate routes use, so a
    // brand-scoped Overlay Family (a tenant's own) can actually be generated with here, not just previewed.
    brand_name: retailerName || undefined,
    start_image_url: startImageUrl || undefined,
    // Only takes effect when actually creating a new base video -- a reused
    // one keeps whatever aspect ratio it was first created with, same as
    // brand_id/start_image_url above.
    aspect_ratio: ["9:16", "16:9", "1:1"].includes(aspectRatio) ? aspectRatio : undefined,
    // The product's real photo, composited into the scene -- like brand_id/
    // start_image_url, only takes effect when a base video is actually
    // created/regenerated.
    source: source || undefined,
    // Set when `theme` above is already the full, real prompt (see getLifestyleDefaultPrompt / getPromptDefault): the engine then
    // sends it to the model verbatim instead of wrapping it a second time in its own product / brand / closing-frame text.
    prompt_is_final: promptIsFinal || undefined,
  };

  const res = await loggedFetch("flipick", `${baseUrl}${VVP_ENDPOINT}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": apiKey },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`VVP generation failed (${res.status}): ${body.error || JSON.stringify(body)}`);
  }
  return body; // { tenant_id, project_id, base_video_action, variant_id, variant_action, video_url, thumbnail_url, warnings }
}

// Deletes VVP base-video project(s) on Flipick's side -- called whenever our
// own record of a video is deleted, so it doesn't linger there as an orphan.
// Best-effort by design: a failure here shouldn't block the caller's own
// (local, in-memory) delete. Used for both lifestyle and hero_product videos
// -- both end up as a `projects` row on Flipick's side either way.
async function deleteVvpVideos({ baseUrl, apiKey, tenantId, projectIds, variantIds }) {
  if (!baseUrl || !apiKey) throw new Error("baseUrl and apiKey are required");
  if (!tenantId) throw new Error("tenantId is required");
  const cleanProjectIds = (projectIds || []).filter(Boolean);
  const cleanVariantIds = (variantIds || []).filter(Boolean);
  if (!cleanProjectIds.length && !cleanVariantIds.length) return { results: [] };

  const res = await loggedFetch("flipick", `${baseUrl}/api/v1/vvp-generation/videos/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": apiKey },
    body: JSON.stringify({ tenant_id: tenantId, project_ids: cleanProjectIds, variant_ids: cleanVariantIds }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Deleting VVP videos failed (${res.status}): ${body.error || JSON.stringify(body)}`);
  }
  return body; // { results: [{ project_id, status, gcs_files_removed? }] }
}

module.exports = { generateVvpVideo, deleteVvpVideos };
