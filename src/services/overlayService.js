// Overlay family catalog (and preview images) from the video engine.
const { listOverlayFamilies: listOverlayFamiliesRaw, getOverlayFamilyPreview } = require("../integrations/videoEngineClient");

// For now, System families are excluded entirely -- merchants only see this
// brand's own Cloned/Full-Shot designs, not LTX's generic System catalog.
// (Previously these were only deduped against a same-named Cloned copy,
// which still left every System-only family with no Cloned equivalent in
// the list; excluding System outright is simpler while this is revisited.)
// Still deduped by name and sorted alphabetically -- LTX's own ordering
// (sort_order/type/label) has no relation to the merchant-facing name.
function dedupeOverlayFamilies(families) {
  const byName = new Map();
  for (const family of families) {
    if (family.isSystem) continue;
    if (!byName.has(family.name)) byName.set(family.name, family);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// For the modal's Overlay Family picker -- one shared catalog regardless of
// video type (unlike the old per-type Template picker, which drew from two
// different hosts' separate template catalogs). aspectRatio narrows the
// list to families that have a variant for that size.
async function listOverlayFamilies(aspectRatio, options) {
  const families = await listOverlayFamiliesRaw({ baseUrl: options.videoEngineBaseUrl, apiKey: options.videoEngineApiKey, aspectRatio, retailerName: options.retailerName });
  return dedupeOverlayFamilies(families);
}
module.exports = { listOverlayFamilies, getOverlayFamilyPreview };
