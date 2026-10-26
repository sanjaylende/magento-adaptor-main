// Single place where environment variables are read.
require("dotenv").config();

module.exports = {
  port: process.env.PORT || 4200,
  // Public address of this service: used in payment return URLs and links in invoices.
  publicBaseUrl: String(process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 4200}`).replace(/\/+$/, ""),
  isProduction: process.env.NODE_ENV === "production",
  // Where researchers send vulnerability reports (served at /.well-known/security.txt).
  securityContact: process.env.SECURITY_CONTACT || "mailto:security@flipick.com",
  database: {
    // The running service connects as a role without BYPASSRLS; migrations use the owner role.
    url: process.env.DATABASE_URL || "postgresql://adapter_app:adapter_app_local@127.0.0.1:5434/magento_adapter",
    adminUrl: process.env.DATABASE_ADMIN_URL || "postgresql://adapter_owner:adapter_owner_local@127.0.0.1:5434/magento_adapter",
    // disable | require (encrypted AND the server certificate is verified) | no-verify (encrypted, NOT verified: never in production)
    sslMode: ["require", "no-verify"].includes(process.env.DB_SSL) ? process.env.DB_SSL : "disable",
    sslCaFile: process.env.DB_SSL_CA || "",   // path to the CA certificate that signed the database server (cloud providers publish it)
  },
  // 32-byte hex key: encrypts installation secrets and Magento tokens at rest, and signs UI session tokens.
  secretKey: process.env.ADAPTER_SECRET_KEY || "",
  admin: {
    // Staff sign in with their LTX account (see src/services/adminUserService.js): no staff passwords are stored here. Defaults to the
    // video engine address, the same LTX that holds the accounts.
    authBaseUrl: process.env.ADMIN_AUTH_BASE_URL || process.env.FLIPICK_VIDEO_ENGINE_BASE_URL || "",
    idleMinutes: Number(process.env.ADMIN_IDLE_MINUTES || 30),            // signed out after this long without a request
    sessionHours: Number(process.env.ADMIN_SESSION_HOURS || 8),           // absolute limit, however active
  },
  billing: {
    graceDays: Number(process.env.BILLING_GRACE_DAYS || 3),
    // The Plans & Billing dialog polls an order every few seconds while the bank page is open; the bank is asked about it at most this often.
    orderCheckMinIntervalMs: Number.isFinite(Number(process.env.BILLING_ORDER_CHECK_MIN_INTERVAL_MS)) && process.env.BILLING_ORDER_CHECK_MIN_INTERVAL_MS !== "" && process.env.BILLING_ORDER_CHECK_MIN_INTERVAL_MS != null ? Math.max(0, Number(process.env.BILLING_ORDER_CHECK_MIN_INTERVAL_MS)) : 10000,
    reminderDays: Number(process.env.BILLING_REMINDER_DAYS || 5),
    // GST on INR invoices to Indian merchants, in basis points. PLACEHOLDER: confirm with your accountant.
    gstRateBp: Number(process.env.GST_RATE_BP || 1800),
    sellerGstNumber: process.env.SELLER_GST_NUMBER || "",
    sellerName: process.env.SELLER_NAME || "Flipick",
    sellerAddress: process.env.SELLER_ADDRESS || "",
    topupPacksUsd: [1000, 2500, 5000], // credit packs in USD cents ($10, $25, $50)
    inrPerUsd: Number(process.env.INR_PER_USD || 83), // PLACEHOLDER rate for INR top-up packs; set the real one before launch
  },
  payment: {
    icici: {
      baseUrl: process.env.ICICI_PG_BASE_URL || "https://pgpayuat.icicibank.com",
      merchantId: process.env.ICICI_PG_MERCHANT_ID || "",
      aggregatorId: process.env.ICICI_PG_AGGREGATOR_ID || "",
      secretKey: process.env.ICICI_PG_SECRET_KEY || "",
      // Source addresses (comma separated, CIDR allowed) of ICICI's Payment Advice webhook; empty = not restricted.
      callbackAllowedIps: String(process.env.ICICI_CALLBACK_ALLOWED_IPS || "").split(",").map((s) => s.trim()).filter(Boolean),
    },
  },
  // Flipick video engine / VVP backend.
  // Shared secret the video engine sends in X-Webhook-Secret on its callback; empty = the callback is accepted unsigned.
  videoEngineWebhookSecret: process.env.VIDEO_ENGINE_WEBHOOK_SECRET || "",
  // Shared secret for server-to-server calls between LTX and this adapter (X-Internal-Secret header, see src/middleware/internalSecret.js); empty = such calls are refused.
  internalApiSecret: process.env.INTERNAL_API_SECRET || "",
  flipick: {
    baseUrl: process.env.FLIPICK_SPONSORED_ADS_BASE_URL,
    videoEngineBaseUrl: process.env.FLIPICK_VIDEO_ENGINE_BASE_URL,
    videoEngineApiKey: process.env.FLIPICK_VIDEO_ENGINE_API_KEY,
    vvpApiKey: process.env.FLIPICK_VVP_API_KEY,
    tenantId: process.env.FLIPICK_TENANT_ID,
    retailerName: process.env.RETAILER_NAME,
  },
  // Magento catalogue: the product attribute whose option labels name a product's category (default for every store; a store can
  // override it in its own settings). Each merchant's Magento address and access token come from the Connect step, not from here.
  catalog: {
    categoryAttributeCode: process.env.MAGENTO_CATEGORY_ATTRIBUTE_CODE || "product_type",
  },
};
