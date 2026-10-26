// EAV entity "video_version": one generation attempt (or Update Overlay re-render, or preview-stills set) of a slot.
// Versions are append-only history numbered 1, 2, 3 ... within their slot. Attribute codes are the camelCase field names
// the browser UI already uses, so toDto() is a straight copy.
const attributes = {
  versionNo: { backend: "int", frontend: "int" },
  status: { backend: "varchar", frontend: "string" },
  aspectRatio: { backend: "varchar", frontend: "string" },
  videoUrl: { backend: "text", frontend: "string" },
  thumbnailUrl: { backend: "text", frontend: "string" },
  error: { backend: "text", frontend: "string" },
  projectId: { backend: "varchar", frontend: "string" },
  variantId: { backend: "varchar", frontend: "string" },
  jobId: { backend: "varchar", frontend: "string" },
  overlayFamily: { backend: "varchar", frontend: "string" },
  brandId: { backend: "varchar", frontend: "string" },
  prompt: { backend: "text", frontend: "string" },
  animation: { backend: "varchar", frontend: "string" },
  overlayStyle: { backend: "varchar", frontend: "string" },
  overlayValues: { backend: "text", frontend: "json" },
  candidateImages: { backend: "text", frontend: "json" },
  candidatesExpiresAt: { backend: "datetime", frontend: "datetime" },
  startImageUrl: { backend: "text", frontend: "string" },
  startImageUrls: { backend: "text", frontend: "json" },
  pushedToMagento: { backend: "int", frontend: "bool" },
  pushedAt: { backend: "datetime", frontend: "datetime" },
  staleFromLtxEdit: { backend: "int", frontend: "bool" },
  productSnapshot: { backend: "text", frontend: "json" },
  progressPct: { backend: "int", frontend: "int" },
  canceledAt: { backend: "datetime", frontend: "datetime" },
};

// Fields a caller may patch on an existing version (ids, numbers and timestamps are managed by the repository).
const PATCHABLE = new Set(Object.keys(attributes).filter((k) => !["versionNo", "candidateImages", "candidatesExpiresAt"].includes(k)));
// Fields accepted when a version is first allocated.
const ALLOCATABLE = new Set([...PATCHABLE, "candidateImages", "candidatesExpiresAt"]);

const pick = (obj, allowed) => Object.fromEntries(Object.entries(obj).filter(([k]) => allowed.has(k)));

// The engine's failure text as a merchant may see it: one short line, without web addresses, IP addresses, host:port pairs, file paths or
// a raw JSON body (those stay in the server log). Anything that is mostly a data dump becomes a generic sentence.
function safeReason(text) {
  if (!text) return null;
  let t = String(text).replace(/https?:\/\/\S+/gi, "[link]")
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, "[address]")
    .replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*:\d{2,5}\b/gi, "[address]")
    .replace(/(?:[a-z]:\\|\/)[^\s"']*[\\/][^\s"']*/gi, "[path]")
    .replace(/\s+/g, " ").trim();
  if (/[{[]\s*"/.test(t)) return "The video service could not finish this video.";
  return t.length > 200 ? t.slice(0, 197) + "..." : t;
}

// EAV entity + its slot -> the plain object the controllers and browser UI use.
function toDto(entity, slot) {
  if (!entity) return null;
  const v = entity.values;
  return {
    id: entity.id,
    storeId: entity.storeId,
    uniqueTag: slot.values.uniqueTag,
    videoType: slot.values.videoType,
    versionNo: v.versionNo,
    status: v.status,
    aspectRatio: v.aspectRatio || null,
    videoUrl: v.videoUrl || null,
    thumbnailUrl: v.thumbnailUrl || null,
    error: safeReason(v.error),
    projectId: v.projectId || null,
    variantId: v.variantId || null,
    jobId: v.jobId || null,
    overlayFamily: v.overlayFamily || null,
    brandId: v.brandId || null,
    prompt: v.prompt || null,
    animation: v.animation || null,
    overlayStyle: v.overlayStyle || null,
    overlayValues: v.overlayValues || null,
    candidateImages: v.candidateImages || null,
    candidatesExpiresAt: v.candidatesExpiresAt || null,
    startImageUrl: v.startImageUrl || null,
    startImageUrls: v.startImageUrls || null,
    pushedToMagento: !!v.pushedToMagento,
    pushedAt: v.pushedAt || null,
    staleFromLtxEdit: !!v.staleFromLtxEdit,
    productSnapshot: v.productSnapshot || null,
    progressPct: v.progressPct ?? null,
    canceledAt: v.canceledAt || null,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
  };
}

module.exports = {
  entityType: "video_version",
  label: "Video Version",
  attributes,
  PATCHABLE,
  ALLOCATABLE,
  pick,
  toDto,
};
