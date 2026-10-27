// Route table: HTTP verb + path -> controller. No logic here, except that every route names the schema its input must match
// (src/validation/schemas.js): a request that does not match is answered with 400 before any controller runs.
const express = require("express");
const page = require("../controllers/pageController");
const session = require("../controllers/sessionController");
const installation = require("../controllers/installationController");
const bootstrap = require("../controllers/bootstrapController");
const catalog = require("../controllers/catalogController");
const overlay = require("../controllers/overlayController");
const generation = require("../controllers/generationController");
const versions = require("../controllers/versionController");
const publish = require("../controllers/publishController");
const download = require("../controllers/downloadController");
const webhook = require("../controllers/webhookController");
const image = require("../controllers/imageController");
const stills = require("../controllers/stillImageController");
const billing = require("../controllers/billingController");
const internal = require("../controllers/internalController");
const { requireInternalSecret } = require("../middleware/internalSecret");
const paymentWeb = require("../controllers/paymentWebController");
const invoice = require("../controllers/invoiceController");
const asyncHandler = require("../middleware/asyncHandler");
const tenantAuth = require("../middleware/tenantAuth");
const idempotent = require("../middleware/idempotency");
const { validate, idempotencyKeyShape, limitBody } = require("../middleware/validate");
const { perIp, perTenant, perInstallation, perStore } = require("../middleware/rateLimit");
const { ipAllowList } = require("../middleware/ipAllowList");
const config = require("../config");
const generatedState = require("../services/generatedState");
const S = require("../validation/schemas");

const router = express.Router();
const h = asyncHandler;

// ---- Public: the UI shell, onboarding, sessions, payment pages, signed links, webhooks ----
// For a load balancer or a hosting platform's health check: no database, no session, nothing to leak.
router.get("/health", (req, res) => res.status(200).type("text/plain").send("ok"));
router.get("/", h(page.index));
// How to report a vulnerability (RFC 9116). SECURITY_CONTACT is an address or URL, e.g. mailto:security@example.com.
router.get("/.well-known/security.txt", (req, res) => {
  const expires = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString();
  res.type("text/plain").send(`Contact: ${config.securityContact}
Expires: ${expires}
Preferred-Languages: en
Canonical: ${config.publicBaseUrl}/.well-known/security.txt
`);
});
router.post("/api/v1/register", perIp("register", 10), limitBody(8 * 1024), validate({ body: S.body.register }), h(installation.register));
router.post("/api/session", perIp("session", 60), limitBody(4 * 1024), validate({ body: S.body.session }), h(session.exchange));
router.get("/billing/return", perIp("pay-return", 60), validate({ query: S.query.paymentReturn }), h(paymentWeb.returnPage));
router.post("/billing/return", perIp("pay-return", 60), limitBody(16 * 1024), validate({ query: S.query.paymentReturn, body: S.body.gatewayMessage }), h(paymentWeb.returnPage));
// The bank's server-to-server message: only ICICI's addresses once they are configured (ICICI_CALLBACK_ALLOWED_IPS).
router.post("/api/payments/callback/:gateway", ipAllowList(() => config.payment.icici.callbackAllowedIps, "payment callback"), perIp("pay-callback", 120), limitBody(16 * 1024), validate({ params: S.params.gateway, body: S.body.gatewayMessage }), h(paymentWeb.callback));
router.get("/invoice/:token", perIp("invoice", 120), validate({ params: S.params.token }), h(invoice.show));
router.get("/dl/:token", perIp("dl", 300), validate({ params: S.params.token }), h(download.download));
router.get("/img/:token", perIp("img", 600), validate({ params: S.params.token }), h(image.show));
// Photos uploaded in the stills picker, fetched by the video engine and the browser through a signed link.
router.get("/up/:token", perIp("up", 600), validate({ params: S.params.token }), h(stills.serve));
router.post("/api/webhooks/video-engine", perIp("engine-webhook", 300), limitBody(16 * 1024), validate({ body: S.body.videoEngineWebhook }), h(webhook.videoEngine));

// ---- Internal, server to server (shared secret, X-Internal-Secret): LTX fetches a store's Magento token ----
router.get("/internal/magento-token/:shop", perIp("internal-token", 60), requireInternalSecret, validate({ params: S.params.shopHost }), h(internal.magentoToken));

// ---- Extension, server to server (signed): no store needed ----
const signedOnly = [tenantAuth({ requireStore: false }), perInstallation(300)];
router.post("/api/v1/ping", ...signedOnly, validate({ body: S.body.ping }), h(installation.ping));
router.post("/api/v1/catalog-changed", ...signedOnly, validate({ body: S.body.catalogChanged }), h(installation.catalogChanged));
router.post("/api/v1/stores/sync", ...signedOnly, validate({ body: S.body.emptyish }), h(installation.syncStores));
router.post("/api/v1/rotate-secret", ...signedOnly, validate({ body: S.body.emptyish }), h(installation.rotateSecret));
router.post("/api/v1/uninstall", ...signedOnly, validate({ body: S.body.emptyish }), h(installation.uninstall));

// ---- Everything below acts for one store (signed request or browser session) ----
const forStore = express.Router();
forStore.use(tenantAuth(), perTenant(600, "store", 300), idempotencyKeyShape, h(async (req, res, next) => { await generatedState.ensureLoaded(); next(); }));
const expensive = perStore("expensive", 20);

forStore.get("/bootstrap", h(bootstrap.bootstrap));
forStore.get("/products", validate({ query: S.query.products }), h(catalog.list));
forStore.post("/refresh", perStore("refresh", 6), validate({ body: S.body.emptyish }), catalog.refresh);
forStore.get("/product-attributes/:uniqueTag", validate({ params: S.params.tag }), catalog.productAttributes);
forStore.get("/product-images/:uniqueTag", validate({ params: S.params.tag }), h(stills.productImages));
// The raw file is the whole request body (a File sent as-is); its own parser, since the app-wide ones only act on JSON and forms.
forStore.post("/upload-still-image", perStore("upload", 30), express.raw({ type: () => true, limit: "15mb" }), validate({ query: S.query.uploadStill }), h(stills.uploadStill));
forStore.post("/prompt-default", limitBody(2 * 1024), validate({ body: S.body.tagAndType }), catalog.promptDefault);

forStore.get("/overlay-families", validate({ query: S.query.overlayFamilies }), overlay.families);
forStore.get("/overlay-families/:name/preview", expensive, validate({ params: S.params.overlayName, query: S.query.overlayPreview }), overlay.preview);

forStore.post("/preview-images", expensive, limitBody(16 * 1024), idempotent(), validate({ body: S.body.previewImages }), generation.previewImages);
forStore.post("/generate", expensive, limitBody(128 * 1024), idempotent(), validate({ body: S.body.generate }), h(generation.generate));
forStore.post("/update-overlay", expensive, limitBody(128 * 1024), idempotent(), validate({ body: S.body.updateOverlay }), generation.updateOverlay);
forStore.get("/status/:uniqueTag/:videoType", validate({ params: S.params.tagType }), generation.status);
forStore.post("/generated/:uniqueTag/:videoType/cancel", validate({ params: S.params.tagType, body: S.body.emptyish }), generation.cancel);

forStore.delete("/generated/:uniqueTag/:videoType", validate({ params: S.params.tagType }), versions.deleteSlot);
forStore.get("/generated/:uniqueTag/:videoType/versions", validate({ params: S.params.tagType }), versions.listVersions);
forStore.post("/generated/:uniqueTag/:videoType/versions/:versionId/restore", validate({ params: S.params.tagTypeVersion, body: S.body.emptyish }), versions.restoreVersion);
forStore.delete("/generated/:uniqueTag/:videoType/versions/:versionId", validate({ params: S.params.tagTypeVersion }), versions.deleteVersion);
forStore.post("/generated/:uniqueTag/:videoType/discard-candidates", validate({ params: S.params.tagType, body: S.body.discardCandidates }), versions.discardCandidates);

forStore.post("/generated/:uniqueTag/:videoType/push-to-magento", validate({ params: S.params.tagType, body: S.body.emptyish }), publish.pushToMagento);
forStore.get("/generated/:uniqueTag/:videoType/download-link", validate({ params: S.params.tagType, query: S.query.versionQuery }), download.link);

forStore.get("/billing/status", h(billing.status));
forStore.post("/billing/checkout", limitBody(2 * 1024), idempotent(), validate({ body: S.body.checkout }), h(billing.checkout));
forStore.get("/billing/orders/:id", validate({ params: S.params.orderId }), h(billing.orderStatus));
forStore.post("/billing/orders/:id/cancel", validate({ params: S.params.orderId, body: S.body.emptyish }), h(billing.cancelOrder));
forStore.post("/billing/cancel", validate({ body: S.body.emptyish }), h(billing.cancel));
forStore.get("/billing/history", h(billing.history));
forStore.get("/billing/invoices/:id/link", validate({ params: S.params.invoiceId }), h(billing.invoiceLink));

router.use("/api", forStore);

module.exports = router;
