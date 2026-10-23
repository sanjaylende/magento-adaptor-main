const js = require("@eslint/js");

// Same minimal, bug-finding ruleset as the Shopify adapter (undefined names, unreachable code, and so on; no style rules), with the
// globals this service needs: Node's built-in fetch family and the browser globals of public/js (the page script).
const nodeGlobals = {
  require: "readonly", module: "writable", exports: "writable", process: "readonly", __dirname: "readonly", __filename: "readonly",
  console: "readonly", Buffer: "readonly", setTimeout: "readonly", setInterval: "readonly", clearTimeout: "readonly",
  clearInterval: "readonly", setImmediate: "readonly", URL: "readonly", URLSearchParams: "readonly", fetch: "readonly",
  Headers: "readonly", Request: "readonly", Response: "readonly", AbortController: "readonly", AbortSignal: "readonly",
  FormData: "readonly", Blob: "readonly", TextEncoder: "readonly", TextDecoder: "readonly", structuredClone: "readonly", TransformStream: "readonly",
};
const browserGlobals = {
  window: "readonly", document: "readonly", navigator: "readonly", location: "readonly", history: "readonly", console: "readonly",
  fetch: "readonly", URL: "readonly", URLSearchParams: "readonly", FormData: "readonly", Blob: "readonly", File: "readonly",
  setTimeout: "readonly", setInterval: "readonly", clearTimeout: "readonly", clearInterval: "readonly", sessionStorage: "readonly",
  localStorage: "readonly", requestAnimationFrame: "readonly", getComputedStyle: "readonly", confirm: "readonly", alert: "readonly",
  AbortController: "readonly", Image: "readonly", Event: "readonly", CustomEvent: "readonly", MutationObserver: "readonly",
  IntersectionObserver: "readonly", ResizeObserver: "readonly", CSS: "readonly", DOMParser: "readonly", Intl: "readonly", crypto: "readonly",
};

module.exports = [
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2022, sourceType: "commonjs", globals: nodeGlobals },
    // Unused function arguments are common and fine in route handlers.
    rules: { "no-unused-vars": ["warn", { args: "none" }] },
  },
  {
    // The page script: top-level functions are called from inline attributes in the HTML, so only local names can be "unused".
    files: ["public/js/**/*.js"],
    languageOptions: { sourceType: "script", globals: browserGlobals },
    rules: { "no-unused-vars": ["warn", { args: "none", vars: "local" }] },
  },
  {
    // app.js and billing.js are two plain scripts of one page and share these top-level names.
    files: ["public/js/**/*.js"],
    languageOptions: { globals: Object.fromEntries(["apiUrl", "escapeHtml", "openPlanModal", "closePlanModal", "renderUsageBadge", "refreshBilling", "isBillingBlocked", "GATE_MESSAGES"].map((n) => [n, "readonly"])) },
    rules: { "no-redeclare": ["error", { builtinGlobals: false }] },
  },
  {
    // Browser journeys pass functions to page.evaluate(), which run in the page.
    files: ["test-journeys/**/*.js"],
    languageOptions: { globals: { ...nodeGlobals, ...browserGlobals } },
  },
  { ignores: ["node_modules/**", "data/**", "logs/**", "coverage/**", "deploy/**", "docs/**", "scripts/**"] },
];
