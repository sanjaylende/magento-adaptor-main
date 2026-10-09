// Single place where environment variables are read.
require("dotenv").config();

const magentoBaseUrl = String(process.env.MAGENTO_BASE_URL || "").replace(/\/+$/, "");

module.exports = {
  port: process.env.PORT || 4200,
  // Public address of this service: used in payment return URLs and links in invoices.
  publicBaseUrl: String(process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 4200}`).replace(/\/+$/, ""),
  isProduction: process.env.NODE_ENV === "production",
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
    bootstrapEmail: process.env.ADMIN_BOOTSTRAP_EMAIL || "",
    bootstrapPassword: process.env.ADMIN_BOOTSTRAP_PASSWORD || "",
    maxFailedLogins: Number(process.env.ADMIN_MAX_FAILED_LOGINS || 5),   // consecutive failures before the account is locked
    lockMinutes: Number(process.env.ADMIN_LOCK_MINUTES || 15),
    idleMinutes: Number(process.env.ADMIN_IDLE_MINUTES || 30),            // signed out after this long without a request
    sessionHours: Number(process.env.ADMIN_SESSION_HOURS || 8),           // absolute limit, however active
    // Two-factor is mandatory in production: a staff member without it can only reach the enrolment page.
    require2fa: process.env.ADMIN_REQUIRE_2FA != null && process.env.ADMIN_REQUIRE_2FA !== "" ? /^(1|true|yes)$/i.test(process.env.ADMIN_REQUIRE_2FA) : process.env.NODE_ENV === "production",
  },
  billing: {
    graceDays: Number(process.env.BILLING_GRACE_DAYS || 3),
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
    gateway: process.env.PAYMENT_GATEWAY || "mock", // mock | icici
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
  flipick: {
    baseUrl: process.env.FLIPICK_SPONSORED_ADS_BASE_URL,
    videoEngineBaseUrl: process.env.FLIPICK_VIDEO_ENGINE_BASE_URL,
    videoEngineApiKey: process.env.FLIPICK_VIDEO_ENGINE_API_KEY,
    vvpApiKey: process.env.FLIPICK_VVP_API_KEY,
    sponsoredApiKey: process.env.FLIPICK_SPONSORED_ADS_API_KEY,
    tenantId: process.env.FLIPICK_TENANT_ID,
    retailerName: process.env.RETAILER_NAME,
  },
  // Default Magento connection of the pre-multi-tenant setup; only used to create the first "internal" installation.
  legacyMagento: {
    baseUrl: magentoBaseUrl,
    accessToken: process.env.MAGENTO_ACCESS_TOKEN,
    categoryAttributeCode: process.env.MAGENTO_CATEGORY_ATTRIBUTE_CODE || "product_type",
    mediaBaseUrl: String(process.env.MAGENTO_MEDIA_BASE_URL || magentoBaseUrl).replace(/\/+$/, ""),
    currencyCode: process.env.MAGENTO_CURRENCY_CODE || "USD",
  },
};
