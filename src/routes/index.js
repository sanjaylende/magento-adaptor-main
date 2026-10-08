// Route table: HTTP verb + path -> controller. No logic here.
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
const billing = require("../controllers/billingController");
const paymentWeb = require("../controllers/paymentWebController");
const invoice = require("../controllers/invoiceController");
const asyncHandler = require("../middleware/asyncHandler");
const tenantAuth = require("../middleware/tenantAuth");
const idempotent = require("../middleware/idempotency");
const { perIp, perInstallation, perStore } = require("../middleware/rateLimit");
const generatedState = require("../services/generatedState");

const router = express.Router();
const h = asyncHandler;

// ---- Public: the UI shell, onboarding, sessions, payment pages, signed links, webhooks ----
router.get("/", h(page.index));
router.post("/api/v1/register", perIp("register", 10), h(installation.register));
router.post("/api/session", perIp("session", 60), h(session.exchange));
router.get("/billing/return", perIp("pay-return", 60), h(paymentWeb.returnPage));
router.post("/billing/return", perIp("pay-return", 60), h(paymentWeb.returnPage));
router.post("/api/payments/callback/:gateway", perIp("pay-callback", 120), h(paymentWeb.callback));
router.get("/mockpay/:txn", paymentWeb.mockEnabled, h(paymentWeb.mockPage));
router.post("/mockpay/:txn/complete", paymentWeb.mockEnabled, h(paymentWeb.mockComplete));
router.get("/invoice/:token", h(invoice.show));
router.get("/dl/:token", h(download.download));
router.get("/img/:token", perIp("img", 600), h(image.show));
router.post("/api/webhooks/video-engine", h(webhook.videoEngine));

// ---- Extension, server to server (signed): no store needed ----
const signedOnly = [tenantAuth({ requireStore: false }), perInstallation(300)];
router.post("/api/v1/ping", ...signedOnly, h(installation.ping));
router.post("/api/v1/stores/sync", ...signedOnly, h(installation.syncStores));
router.post("/api/v1/rotate-secret", ...signedOnly, h(installation.rotateSecret));
router.post("/api/v1/uninstall", ...signedOnly, h(installation.uninstall));

// ---- Everything below acts for one store (signed request or browser session) ----
const forStore = express.Router();
forStore.use(tenantAuth(), perInstallation(600), perStore("store", 300), h(async (req, res, next) => { await generatedState.ensureLoaded(); next(); }));
const expensive = perStore("expensive", 20);

forStore.get("/bootstrap", h(bootstrap.bootstrap));
forStore.get("/products", h(catalog.list));
forStore.post("/refresh", perStore("refresh", 6), catalog.refresh);
forStore.get("/product-attributes/:uniqueTag", catalog.productAttributes);
forStore.post("/prompt-default", catalog.promptDefault);

forStore.get("/overlay-families", overlay.families);
forStore.get("/overlay-families/:name/preview", expensive, overlay.preview);

forStore.post("/preview-images", expensive, idempotent(), generation.previewImages);
forStore.post("/generate", expensive, idempotent(), h(generation.generate));
forStore.post("/update-overlay", expensive, idempotent(), generation.updateOverlay);
forStore.get("/status/:uniqueTag/:videoType", generation.status);
forStore.post("/generated/:uniqueTag/:videoType/cancel", generation.cancel);

forStore.delete("/generated/:uniqueTag/:videoType", versions.deleteSlot);
forStore.get("/generated/:uniqueTag/:videoType/versions", versions.listVersions);
forStore.post("/generated/:uniqueTag/:videoType/versions/:versionId/restore", versions.restoreVersion);
forStore.delete("/generated/:uniqueTag/:videoType/versions/:versionId", versions.deleteVersion);
forStore.post("/generated/:uniqueTag/:videoType/discard-candidates", versions.discardCandidates);

forStore.post("/generated/:uniqueTag/:videoType/push-to-magento", publish.pushToMagento);
forStore.get("/generated/:uniqueTag/:videoType/download-link", download.link);

forStore.get("/billing/status", h(billing.status));
forStore.post("/billing/checkout", idempotent(), h(billing.checkout));
forStore.get("/billing/orders/:id", h(billing.orderStatus));
forStore.post("/billing/cancel", h(billing.cancel));
forStore.get("/billing/history", h(billing.history));
forStore.get("/billing/invoices/:id/link", h(billing.invoiceLink));

router.use("/api", forStore);

module.exports = router;
