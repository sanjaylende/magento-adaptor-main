// Input schemas for every route (H6). Request bodies are STRICT: a field that is not listed is rejected, not ignored, so a
// client cannot smuggle extra data in. Path and query values are checked for shape and length before any controller runs.
const { z } = require("zod");
const { VIDEO_TYPES } = require("../config/constants");

const VIDEO_TYPE_KEYS = Object.keys(VIDEO_TYPES);
const ASPECT_RATIOS = ["9:16", "16:9", "1:1", "5:4"];
const noControlChars = (s) => !/[\u0000-\u001f\u007f]/.test(s);

// ---- building blocks ----
const text = (max, min = 0) => z.string().min(min).max(max).refine(noControlChars, "contains control characters");
const multiline = (max) => z.string().max(max).refine((s) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s), "contains control characters");
const httpUrl = (max = 2048) => z.string().max(max).refine((s) => { try { return ["http:", "https:"].includes(new URL(s).protocol); } catch (err) { return false; } }, "must be an http(s) address");
const blankToUndefined = (schema) => z.preprocess((v) => (v === "" || v === null ? undefined : v), schema.optional());

const tag = z.string().regex(/^[A-Za-z0-9._:-]{1,120}$/, "invalid product tag");
const videoType = z.enum(VIDEO_TYPE_KEYS);
const versionId = z.union([z.string().regex(/^[A-Za-z0-9-]{1,64}$/), z.number().int().nonnegative()]);
const aspectRatio = blankToUndefined(z.enum(ASPECT_RATIOS));
const signedToken = z.string().regex(/^[A-Za-z0-9_.-]{10,4096}$/, "invalid token");
const gateway = z.enum(["mock", "icici"]);
const txnNo = z.string().regex(/^[A-Za-z0-9_-]{6,64}$/, "invalid reference");
const entityId = z.string().regex(/^[A-Za-z0-9-]{1,64}$/, "invalid id");
const variableMap = z.record(text(100, 1), z.union([text(2000), z.number().transform(String)])).refine((o) => Object.keys(o).length <= 60, "too many fields");
const selectionMap = z.record(text(100, 1), text(200)).refine((o) => Object.keys(o).length <= 60, "too many fields");

// ---- request bodies ----
const body = {
  register: z.strictObject({
    baseUrl: httpUrl(), magentoToken: text(512, 1),
    merchantName: blankToUndefined(text(200)), contactEmail: blankToUndefined(z.string().max(254).pipe(z.email())),
    countryCode: blankToUndefined(z.string().regex(/^[A-Za-z]{2}$/)), magentoVersion: blankToUndefined(text(40)), extensionVersion: blankToUndefined(text(40)),
  }),
  session: z.strictObject({ launch: text(4096, 1) }),
  ping: z.strictObject({ magentoVersion: blankToUndefined(text(40)), extensionVersion: blankToUndefined(text(40)) }),
  // Calls that carry no data: the extension may send {} or [] or nothing at all.
  emptyish: z.union([z.strictObject({}), z.array(z.never()).max(0)]).transform(() => ({})),
  tagAndType: z.strictObject({ uniqueTag: tag, videoType }),
  previewImages: z.strictObject({ uniqueTag: tag, videoType, prompt: blankToUndefined(multiline(4000)), aspectRatio }),
  generate: z.strictObject({
    uniqueTag: tag, videoType, prompt: blankToUndefined(multiline(4000)), aspectRatio,
    startImageUrl: blankToUndefined(httpUrl()), startImageUrls: blankToUndefined(z.array(httpUrl()).max(12)),
    brandId: blankToUndefined(text(100)), overlayFamily: blankToUndefined(text(200)), animation: blankToUndefined(text(100)),
    overlayStyle: blankToUndefined(z.enum(["custom", "offers"])), variableValues: blankToUndefined(variableMap),
    variableSelections: blankToUndefined(selectionMap), versionId: blankToUndefined(versionId),
  }),
  updateOverlay: z.strictObject({ uniqueTag: tag, videoType, variableValues: blankToUndefined(variableMap), variableSelections: blankToUndefined(selectionMap) }),
  discardCandidates: z.strictObject({ versionId: blankToUndefined(versionId) }),
  checkout: z.strictObject({
    kind: blankToUndefined(z.enum(["plan", "topup"])), tier: blankToUndefined(z.string().regex(/^[a-z0-9_]{1,40}$/)),
    cycle: blankToUndefined(z.enum(["monthly", "annual"])), currency: z.enum(["USD", "INR"]),
    packUsdCents: blankToUndefined(z.number().int().positive().max(10000000)),
  }),
  // Bank and gateway messages: field names are plain words, values are text, numbers or small objects (udfFields).
  gatewayMessage: z.record(z.string().regex(/^[A-Za-z0-9_]{1,60}$/), z.union([z.string().max(5000), z.number(), z.boolean(), z.null(), z.record(z.string(), z.unknown())]))
    .refine((o) => Object.keys(o).length <= 80, "too many fields"),
  // The video engine's callback: required fields checked, the engine may add more.
  videoEngineWebhook: z.looseObject({ project_id: z.union([z.string().max(200), z.number()]), event: text(100, 1) }),
  mockPay: z.strictObject({ result: z.enum(["paid", "failed", "pending"]) }),
};

// ---- path parameters ----
const params = {
  tagType: z.object({ uniqueTag: tag, videoType }),
  tagTypeVersion: z.object({ uniqueTag: tag, videoType, versionId }),
  tag: z.object({ uniqueTag: tag }),
  token: z.object({ token: signedToken }),
  txn: z.object({ txn: txnNo }),
  gateway: z.object({ gateway }),
  orderId: z.object({ id: z.string().regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/, "must be an order id (UUID)") }),
  invoiceId: z.object({ id: z.string().regex(/^[0-9]{1,18}$/, "must be an invoice number (digits)") }),
  overlayName: z.object({ name: text(200, 1) }),
};

// ---- query strings (unknown names are ignored: caches and trackers may add their own) ----
const query = {
  products: z.object({ refresh: blankToUndefined(z.enum(["0", "1"])) }),
  overlayFamilies: z.object({ aspectRatio }),
  overlayPreview: z.object({ aspectRatio, uniqueTag: blankToUndefined(tag) }),
  paymentReturn: z.object({ gw: blankToUndefined(gateway) }),
  versionQuery: z.object({ versionId: blankToUndefined(versionId) }),
};

// ---- staff console forms ----
const money = z.string().regex(/^-?\d{1,9}(\.\d{1,2})?$/, "invalid amount");
const admin = {
  merchantProfile: z.strictObject({ _csrf: text(200), country: blankToUndefined(z.string().regex(/^[A-Za-z]{2}$/)), gst: blankToUndefined(text(30)), address: blankToUndefined(text(500)) }),
  installationStatus: z.strictObject({ _csrf: text(200), status: z.enum(["active", "suspended"]) }),
  credit: z.strictObject({ _csrf: text(200), usd: money, note: blankToUndefined(text(300)) }),
  activatePlan: z.strictObject({ _csrf: text(200), plan: z.string().regex(/^[a-z0-9_]{1,40}$/), interval: z.enum(["monthly", "annual"]), currency: z.enum(["USD", "INR"]), note: blankToUndefined(text(300)) }),
  csrfOnly: z.strictObject({ _csrf: text(200) }),
  refund: z.strictObject({ _csrf: text(200), amount: money, reason: blankToUndefined(text(500)), entitlement: blankToUndefined(z.enum(["none", "cancel_plan", "remove_credit"])) }),
  planPrice: z.strictObject({ _csrf: text(200), plan: z.string().regex(/^[a-z0-9_]{1,40}$/), interval: z.enum(["monthly", "annual"]), currency: z.enum(["USD", "INR"]), amount: money, budget: money }),
  planRate: z.strictObject({ _csrf: text(200), plan: z.string().regex(/^[a-z0-9_]{1,40}$/), type: z.enum(VIDEO_TYPE_KEYS), rate: money }),
  login: z.strictObject({ email: text(254), password: text(200) }),
  code: z.strictObject({ code: text(10) }),
  codeCsrf: z.strictObject({ _csrf: text(200), code: text(10) }),
  paymentsFilter: z.object({ status: blankToUndefined(z.enum(["pending", "paid", "failed", "refunded", "partially_refunded", "canceled", "expired"])) }),
};

module.exports = { body, params, query, admin, ASPECT_RATIOS };
