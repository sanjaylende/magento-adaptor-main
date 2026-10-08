// The two custom product attributes the Magento module (Flipick_VideoGenerator) adds via its data patch, and that the
// storefront block reads to render a <video> element on the product page.
const VIDEO_URL_ATTRIBUTE = "generated_video_url";
const VIDEO_THUMBNAIL_ATTRIBUTE = "generated_video_thumbnail";

const VIDEO_TYPES = { hero_product: "Hero Product", lifestyle: "Lifestyle", image_transition: "Image Transitions" };

// Statuses a version can be in. "candidates"/"expired" are preview-only states (the 4 starting stills), not real renders.
const STATUS = {
  CANDIDATES: "candidates", EXPIRED: "expired", GENERATING: "generating", READY: "ready", ERROR: "error", CANCELED: "canceled",
};
const PREVIEW_STATUSES = [STATUS.CANDIDATES, STATUS.EXPIRED];

module.exports = { VIDEO_URL_ATTRIBUTE, VIDEO_THUMBNAIL_ATTRIBUTE, VIDEO_TYPES, STATUS, PREVIEW_STATUSES };
