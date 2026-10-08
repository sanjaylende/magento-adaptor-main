// Publishes a generated video to a Magento product by writing the two custom attributes the Magento module's storefront
// block reads.
const { updateProductAttributes } = require("../integrations/magentoClient");
const { VIDEO_URL_ATTRIBUTE, VIDEO_THUMBNAIL_ATTRIBUTE } = require("../config/constants");

// Writes the generated video's URL (+ thumbnail) onto the product's PARENT/
// storefront-facing sku via the two custom attributes the Magento module's
// data patch adds -- that module's storefront block reads them back to
// render a <video> element on the product page. Unlike Shopify's media
// push, there's no download/re-upload, no GID, no staged-upload dance: this
// is a single plain attribute write, and Magento merges by attribute_code so
// it doesn't disturb any of the product's other fields.
async function pushVideoToProduct({ baseUrl, accessToken, magentoSku, videoUrl, thumbnailUrl }) {
  await updateProductAttributes(baseUrl, accessToken, magentoSku, {
    [VIDEO_URL_ATTRIBUTE]: videoUrl,
    [VIDEO_THUMBNAIL_ATTRIBUTE]: thumbnailUrl || "",
  });
  return { pushed: true };
}

// Best-effort: clears the two video attributes when a previously-pushed
// video's local record is deleted, so the storefront stops showing a video
// this app no longer has any record of. Mirrors deleteVideo's "local delete
// always succeeds, remote cleanup is cleanup" pattern.
async function clearVideoFromProduct({ baseUrl, accessToken, magentoSku }) {
  return updateProductAttributes(baseUrl, accessToken, magentoSku, {
    [VIDEO_URL_ATTRIBUTE]: "",
    [VIDEO_THUMBNAIL_ATTRIBUTE]: "",
  });
}
module.exports = { pushVideoToProduct, clearVideoFromProduct };
