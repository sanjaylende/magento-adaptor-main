// Browser client for the product picker. boot.js signs in, fetches /api/bootstrap into window.__BOOTSTRAP__ (currency map,
// products, generated slots, store label, last sync time, plan and usage), then loads billing.js and this file.
const BOOTSTRAP = window.__BOOTSTRAP__;
const CURRENCY_SYMBOLS = BOOTSTRAP.currencySymbols;
const PRODUCTS = BOOTSTRAP.products;
const generated = BOOTSTRAP.generated;
// Used by renderListPage() to reconstruct the top-bar subtitle after navigating away from and back to the list page.
const STORE_DOMAIN = BOOTSTRAP.storeUrl;
// When the product cache was last refreshed -- null before its first successful refresh.
const PRODUCTS_SYNCED_AT = BOOTSTRAP.syncedAt;
// Appends ?shop=STORE_DOMAIN (or &shop= if the path already has a query
// string) to every API call -- the one thing that makes server-side
// per-shop state resolution possible, since fetch() has no other way to
// tell the server which shop a page's requests belong to.
function apiUrl(path) {
  return path; // one Magento store: nothing to route per shop
}
// The video download route (GET .../download) is reached via a plain
// <a href> browser navigation, not fetch() -- so it can never carry the
// Authorization header the patch above attaches. Exempting it from
// requireSessionToken entirely would reopen a scoped version of the
// exact hole that middleware exists to close, so instead: ask for a
// short-lived signed download URL over an authenticated fetch() first
// (src/downloadToken.js verifies it server-side), then navigate to
// that. Shared by every "Download" action (panel card, detail page,
// version history) instead of each building its own href.
async function downloadVideo(tag, videoType, versionId) {
  try {
    const path = "/api/generated/" + encodeURIComponent(tag) + "/" + encodeURIComponent(videoType) + "/download-link" +
      (versionId ? "?versionId=" + encodeURIComponent(versionId) : "");
    const res = await fetch(apiUrl(path));
    const body = await res.json();
    if (!res.ok || !body.url) throw new Error(body.error || "Could not prepare download");
    window.location.href = body.url;
  } catch (err) {
    alert(err.message);
  }
}
// Plan/usage snapshot for the usage badge + Plan modal's first paint --
// same shape GET /api/billing/status returns (buildBillingSnapshot),
// refreshed from there after anything that could change it.
// Replaces the old single categoryFilter -- one object for the toolbar's
// search/sort/category/status/page controls, all funneled through
// visibleProducts(). Defaults to "recent" (Most recent generation),
// matching the mockup -- see mostRecentSlotUpdate()/sortProducts() below.
// Persisted to sessionStorage by refresh() (see below) and restored here
// so a "Refresh from Magento" reload doesn't silently drop the merchant's
// current sort/filter/page -- a plain tab close/reopen still starts fresh,
// same as everywhere else in this app that uses sessionStorage.
const LIST_FILTERS_KEY = "flipickListFilters";
let listFilters = { search: "", category: "All", status: "All", sort: "recent", page: 1 };
try {
  const saved = JSON.parse(sessionStorage.getItem(LIST_FILTERS_KEY) || "null");
  if (saved) listFilters = { ...listFilters, ...saved };
} catch { /* corrupt/old-shape value -- ignore, use defaults */ }
sessionStorage.removeItem(LIST_FILTERS_KEY);
let pollTimers = {};
// "Page" state -- there's still only one Express route (GET /); mode
// switches what #appRoot renders client-side, same pattern the modal
// already uses (openModal/renderModal) just applied at page scope. Detail
// mode (tag/tab/selectedType/expandedType) lands in a later phase --
// renderApp() only ever produces "list" today.
let view = { mode: "list", tag: null, tab: "videos", selectedType: null, expandedType: null };

function navigate(next) {
  view = { ...view, ...next };
  renderApp();
}

// The single place that decides what #appRoot shows -- called by
// navigate() on every mode/tag/tab change, so it always does a full
// rebuild of that page (header/tabs included). Background state syncs
// (polling, delete, push) go through renderAfterStateChange() below
// instead, which updates only the parts that reflect generated/PRODUCTS
// data without rebuilding the whole page around them.
function renderApp() {
  const root = document.getElementById("appRoot");
  if (view.mode === "detail") {
    root.innerHTML = renderProductDetail(view.tag);
    return;
  }
  root.innerHTML = renderListPage();
  renderToolbar();
  renderAfterStateChange();
  renderUsageBadge();
}

// Replaces every "renderRows(); renderPanel();" pair -- view-aware so a
// background poll/delete/push tick updates whichever page is actually
// showing instead of only ever the list page's containers (which
// wouldn't exist while on the detail page and would silently no-op via
// renderRows/renderPanel's own null guards).
function renderAfterStateChange() {
  if (view.mode === "detail") {
    const mainEl = document.getElementById("detailMain");
    const sideEl = document.getElementById("detailSide");
    const subEl = document.getElementById("detailHeaderSub");
    if (!mainEl && !sideEl) return; // mid-transition -- nothing to update yet
    const product = PRODUCTS.find((p) => p.uniqueTag === view.tag);
    if (!product) return;
    const slots = productSlots(view.tag);
    if (mainEl) mainEl.innerHTML = renderDetailTabBody(product, slots);
    if (sideEl) sideEl.innerHTML = renderVideoSlotList(product, slots);
    if (subEl) subEl.innerHTML = detailHeaderSubHtml(product, slots);
    return;
  }
  renderRows();
  renderPanel();
}

// "5 min ago" / "Yesterday" / "Aug 12" -- shared by the sync line, the
// Updated column, and (later) the Recent videos panel.
function relativeTime(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return diffMin + " min ago";
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return diffHr + " hr" + (diffHr === 1 ? "" : "s") + " ago";
  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
  const startOfYesterday = new Date(startOfToday); startOfYesterday.setDate(startOfYesterday.getDate() - 1);
  if (date >= startOfYesterday && date < startOfToday) return "Yesterday";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- Product table ----------

function categories() {
  return ["All", ...new Set(PRODUCTS.map((p) => p.category))];
}

function matchesSearch(p, search) {
  if (!search) return true;
  const q = search.toLowerCase();
  return p.name.toLowerCase().includes(q) || p.category.toLowerCase().includes(q);
}

// A product matches a status filter if ANY of its (up to 3) slots derive
// to that status -- "none" is special-cased to mean ALL three slots are
// absent, not "any slot is absent" (every product has at least one
// missing slot most of the time).
function matchesStatusFilter(p, status) {
  if (status === "All") return true;
  if (status === "none") return VIDEO_TYPES.every((t) => !generated[genKey(p.uniqueTag, t)]);
  return VIDEO_TYPES.some((t) => slotStatus(generated[genKey(p.uniqueTag, t)]) === status);
}

// The latest updatedAt across a product's (up to 3) generated slots, or
// null if it has none yet -- used for "Most recent generation" sort and
// the Updated column.
function mostRecentSlotUpdate(product) {
  const timestamps = VIDEO_TYPES
    .map((t) => generated[genKey(product.uniqueTag, t)])
    .filter(Boolean)
    .map((g) => g.updatedAt)
    .filter(Boolean);
  if (!timestamps.length) return null;
  return timestamps.reduce((latest, t) => (t > latest ? t : latest));
}

function sortProducts(list, sort) {
  const sorted = list.slice();
  if (sort === "price-desc") sorted.sort((a, b) => b.price - a.price);
  else if (sort === "price-asc") sorted.sort((a, b) => a.price - b.price);
  else if (sort === "category") sorted.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  else if (sort === "updated") {
    // Shopify's own last-modified timestamp (normalize.js), NOT
    // mostRecentSlotUpdate -- "recent" (below) is about OUR generation
    // activity, this is about THEIR product data. No-timestamp products
    // sort last, same convention as "recent".
    sorted.sort((a, b) => {
      if (!a.updatedAt && !b.updatedAt) return a.name.localeCompare(b.name);
      if (!a.updatedAt) return 1;
      if (!b.updatedAt) return -1;
      return b.updatedAt.localeCompare(a.updatedAt);
    });
  } else if (sort === "recent") {
    // Products with no generation yet sort last, regardless of direction.
    sorted.sort((a, b) => {
      const at = mostRecentSlotUpdate(a), bt = mostRecentSlotUpdate(b);
      if (!at && !bt) return a.name.localeCompare(b.name);
      if (!at) return 1;
      if (!bt) return -1;
      return bt.localeCompare(at);
    });
  } else sorted.sort((a, b) => a.name.localeCompare(b.name));
  return sorted;
}

function visibleProducts() {
  let list = listFilters.category === "All" ? PRODUCTS : PRODUCTS.filter((p) => p.category === listFilters.category);
  list = list.filter((p) => matchesSearch(p, listFilters.search) && matchesStatusFilter(p, listFilters.status));
  return sortProducts(list, listFilters.sort);
}

const PAGE_SIZE = 50;

function totalPages(count) {
  return Math.max(1, Math.ceil(count / PAGE_SIZE));
}

function paginate(list) {
  const start = (listFilters.page - 1) * PAGE_SIZE;
  return list.slice(start, start + PAGE_SIZE);
}

// Renders the toolbar's structure ONCE (called only at initial mount,
// never on a filter change) -- re-rendering an <input>/<select> on every
// keystroke/change would wipe focus and the caret position mid-typing.
// Filter changes below only ever touch #rows/#count.
function renderToolbar() {
  const categorySelect = document.getElementById("categorySelect");
  if (!categorySelect) return;
  categorySelect.innerHTML = categories().map((c) =>
    '<option value="' + escapeHtml(c) + '">' + (c === "All" ? "Category: All" : escapeHtml(c)) + '</option>'
  ).join("");
  categorySelect.value = listFilters.category;
  document.getElementById("sortSelect").value = listFilters.sort;
  document.getElementById("statusSelect").value = listFilters.status;
  document.getElementById("searchInput").value = listFilters.search;
  renderActiveFilterChips();
}

const STATUS_FILTER_LABELS = { rendering: "Rendering", ready: "Ready", published: "Published", failed: "Failed", none: "No videos" };

// One chip per non-default listFilters entry, each independently
// clearable, plus "Clear all" once more than one is active -- sort isn't
// treated as a "filter" here (it reorders, it doesn't narrow the list).
function renderActiveFilterChips() {
  const el = document.getElementById("filterChips");
  if (!el) return;
  const chips = [];
  if (listFilters.search) chips.push({ key: "search", label: 'Search: "' + listFilters.search + '"' });
  if (listFilters.category !== "All") chips.push({ key: "category", label: "Category: " + listFilters.category });
  if (listFilters.status !== "All") chips.push({ key: "status", label: "Status: " + (STATUS_FILTER_LABELS[listFilters.status] || listFilters.status) });
  if (!chips.length) { el.innerHTML = ""; return; }
  el.innerHTML = chips.map((c) =>
    '<span class="filter-chip">' + escapeHtml(c.label) + '<button type="button" data-action="clear-filter" data-filter-key="' + c.key + '" aria-label="Clear">✕</button></span>'
  ).join("") + (chips.length > 1 ? '<button type="button" class="filter-chip-clear-all" data-action="clear-all-filters">Clear all</button>' : "");
}

function renderPagination(totalCount) {
  const el = document.getElementById("pagination");
  if (!el) return;
  const pages = totalPages(totalCount);
  if (pages <= 1) { el.innerHTML = ""; return; }
  el.innerHTML =
    '<button type="button" class="stroked" data-action="prev-page" ' + (listFilters.page <= 1 ? "disabled" : "") + '>Previous</button>' +
    '<span class="muted">Page ' + listFilters.page + ' of ' + pages + '</span>' +
    '<button type="button" class="stroked" data-action="next-page" ' + (listFilters.page >= pages ? "disabled" : "") + '>Next</button>';
}

// formatMoney mirrors src/money.js exactly (CURRENCY_SYMBOLS is injected
// from there below) -- this runs in the browser and can't require() it.
function formatMoney(amount, currencyCode) {
  if (amount == null) return "";
  const code = (currencyCode || "USD").toUpperCase();
  const symbol = CURRENCY_SYMBOLS[code];
  const value = Number(amount).toFixed(2);
  return symbol ? symbol + value : code + " " + value;
}

function priceLabel(p) {
  let html = formatMoney(p.price, p.currencyCode);
  if (p.offer) {
    html += ' <s>' + formatMoney(p.offer.originalPrice, p.currencyCode) + '</s><span class="offer-pct">' + p.offer.discountPercent + '% off</span>';
  }
  return html;
}

// A product can have an independent Hero Product, Lifestyle, AND Image
// Transitions video (or none, or any subset) -- so the row's status
// reflects whichever slot(s) exist, keyed by genKey(tag, videoType) not
// tag alone.
function genKey(tag, videoType) { return tag + "::" + (videoType || "lifestyle"); }
const VIDEO_TYPES = ["hero_product", "lifestyle", "image_transition"];
const TYPE_LABELS = { hero_product: "Hero", lifestyle: "Lifestyle", image_transition: "Image Trans." };

// Real SVGs (Font Awesome Free solid glyphs), not emoji -- emoji rendering
// (color, weight, even shape) varies by OS/font and can't be made to match
// another emoji on purpose. fill=currentColor means both pick up whatever
// color .panel-card-delete/.panel-card-icon-btn set, so the two are
// guaranteed pixel-identical in color rather than "close enough".
const DOWNLOAD_ICON_SVG = '<svg width="14" height="14" viewBox="0 0 512 512" fill="currentColor" aria-hidden="true"><path d="M288 32c0-17.7-14.3-32-32-32s-32 14.3-32 32V274.7l-73.4-73.4c-12.5-12.5-32.8-12.5-45.3 0s-12.5 32.8 0 45.3l128 128c12.5 12.5 32.8 12.5 45.3 0l128-128c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0L288 274.7V32zM64 352c-35.3 0-64 28.7-64 64v32c0 35.3 28.7 64 64 64H448c35.3 0 64-28.7 64-64V416c0-35.3-28.7-64-64-64H346.5l-45.3 45.3c-25 25-65.5 25-90.5 0L165.5 352H64zm368 56a24 24 0 1 1 0 48 24 24 0 1 1 0-48z"/></svg>';
const TRASH_ICON_SVG = '<svg width="14" height="14" viewBox="0 0 448 512" fill="currentColor" aria-hidden="true"><path d="M135.2 17.7L128 32H32C14.3 32 0 46.3 0 64S14.3 96 32 96H416c17.7 0 32-14.3 32-32s-14.3-32-32-32H320l-7.2-14.3C307.4 6.8 296.3 0 284.2 0H163.8c-12.1 0-23.2 6.8-28.6 17.7zM416 128H32L53.2 467c1.6 25.3 22.6 45 47.9 45H346.9c25.3 0 46.3-19.7 47.9-45L416 128z"/></svg>';

// Derived per-slot status for the list page's badges -- distinct from
// the raw persisted status field: "published" is computed (ready +
// shopifyMediaId), not its own persisted value. "candidates" (preview
// images generated, awaiting a pick) and "expired" (a candidates row
// whose signed image URLs aged out unpicked) ARE real persisted
// statuses now, from the preview-images route's allocateVersion call.
function slotStatus(gen) {
  if (!gen) return "none";
  if (gen.status === "generating") return "rendering";
  if (gen.status === "error") return "failed";
  if (gen.status === "ready") return gen.pushedToMagento ? "published" : "ready";
  if (gen.status === "candidates") return "candidates";
  if (gen.status === "expired") return "failed";
  if (gen.status === "canceled") return "canceled";
  return "candidates"; // unrecognized status -- shouldn't happen
}

const STATUS_ORDER = ["rendering", "candidates", "ready", "published", "failed", "canceled"];

// Aggregates a product's (up to 3) slots into count badges, e.g.
// "2 rendering" + "1 published" -- fixed order so badges don't reshuffle
// between polls as slots settle.
// renderingSlotType: when exactly one slot is generating, the badge
// becomes a click target that jumps straight to it (Active-job access,
// story criterion #4) -- omitted (no click target) when zero or more
// than one slot races, same ambiguity-avoidance as the row action.
function rowStatusBadges(product, renderingSlotType) {
  const counts = {};
  VIDEO_TYPES.forEach((t) => {
    const s = slotStatus(generated[genKey(product.uniqueTag, t)]);
    if (s === "none") return;
    counts[s] = (counts[s] || 0) + 1;
  });
  const active = STATUS_ORDER.filter((s) => counts[s]);
  if (!active.length) return '<span class="status-badge none">No videos</span>';
  return active.map((s) => {
    if (s === "rendering" && renderingSlotType) {
      return '<span class="status-badge rendering clickable" data-action="open-product" data-tag="' + escapeHtml(product.uniqueTag) +
        '" data-video-type="' + renderingSlotType + '"><span class="spinner spinner-inline"></span>' + counts[s] + ' rendering</span>';
    }
    return '<span class="status-badge ' + s + '">' + counts[s] + ' ' + s + '</span>';
  }).join(" ");
}

// The slot whose snapshot to diff against current product data --
// whichever existing slot was generated most recently, so "what
// changed" reflects the merchant's latest video, not an older one.
function latestSnapshotSlot(slots) {
  const withSnapshot = slots.filter((s) => s.gen && s.gen.productSnapshot && s.gen.updatedAt);
  if (!withSnapshot.length) return null;
  return withSnapshot.reduce((a, b) => (b.gen.updatedAt > a.gen.updatedAt ? b : a));
}

// [] for products with no snapshotted slot at all (nothing to compare
// against -- never flagged as "changed") or a slot whose snapshot still
// matches current data.
function productChangedFields(product, slots) {
  const slot = latestSnapshotSlot(slots);
  if (!slot) return [];
  const snap = slot.gen.productSnapshot;
  const fields = [];
  if (snap.name !== product.name) fields.push({ label: "Title", from: snap.name, to: product.name });
  if (Number(snap.price) !== Number(product.price)) {
    fields.push({ label: "Price", from: formatMoney(Number(snap.price), product.currencyCode), to: formatMoney(Number(product.price), product.currencyCode) });
  }
  const currentImage = product.imageSource || product.image;
  if (snap.image !== currentImage) fields.push({ label: "Image", from: snap.image || "(none)", to: currentImage || "(none)" });
  return fields;
}

// Which product's "changed" detail row is currently expanded -- one at
// a time, same toggle pattern as the detail page's expandedType.
let expandedChangedTag = null;

function renderRows() {
  const rowsEl = document.getElementById("rows");
  if (!rowsEl) return;
  const vp = visibleProducts();
  const countText = vp.length + ' of ' + PRODUCTS.length + ' product' + (PRODUCTS.length === 1 ? '' : 's');
  const syncedText = PRODUCTS_SYNCED_AT ? ' · Synced ' + relativeTime(PRODUCTS_SYNCED_AT) : '';
  document.getElementById("count").textContent = countText + syncedText;
  if (listFilters.page > totalPages(vp.length)) listFilters.page = totalPages(vp.length);
  const pageItems = paginate(vp);
  rowsEl.innerHTML = pageItems.map((p) => {
    const thumb = p.image
      ? '<img src="' + escapeHtml(p.image) + '" class="thumb" />'
      : '<div class="thumb-placeholder"></div>';
    const slots = VIDEO_TYPES.map((t) => ({ type: t, gen: generated[genKey(p.uniqueTag, t)] }));
    const hasAny = slots.some((s) => s.gen);
    const label = hasAny ? "Manage video" : "Generate video";
    const updated = mostRecentSlotUpdate(p);
    const changedFields = productChangedFields(p, slots);
    const changedBadge = changedFields.length
      ? '<div class="row-changed" data-action="toggle-changed" data-tag="' + escapeHtml(p.uniqueTag) + '">⚠ Product changed since video generation</div>'
      : "";
    const changedDetailRow = (changedFields.length && expandedChangedTag === p.uniqueTag)
      ? '<tr class="changed-detail-row"><td colspan="7"><div class="changed-detail">' +
          changedFields.map((f) =>
            '<div><strong>' + escapeHtml(f.label) + ':</strong> ' + escapeHtml(String(f.from)) + ' → ' + escapeHtml(String(f.to)) + '</div>'
          ).join("") +
        '</div></td></tr>'
      : "";
    // The single rendering slot to jump to if the badge is clicked --
    // only when unambiguous, same reasoning the row action already
    // applies elsewhere in this file (don't guess between simultaneous jobs).
    const renderingSlots = slots.filter((s) => s.gen && s.gen.status === "generating");
    const statusBadges = rowStatusBadges(p, renderingSlots.length === 1 ? renderingSlots[0].type : null);
    return '<tr data-tag="' + escapeHtml(p.uniqueTag) + '">' +
      '<td><span class="clickable-thumb" data-action="open-product-details" data-tag="' + escapeHtml(p.uniqueTag) + '">' + thumb + '</span></td>' +
      '<td><span class="clickable-name" data-action="open-product-details" data-tag="' + escapeHtml(p.uniqueTag) + '">' + escapeHtml(p.name) + '</span></td>' +
      '<td>' + escapeHtml(p.category) + '</td>' +
      '<td>' + priceLabel(p) + '</td>' +
      '<td>' + statusBadges + changedBadge + '</td>' +
      '<td>' + (updated ? relativeTime(updated) : '<span class="muted">—</span>') + '</td>' +
      '<td><button class="action-btn" data-action="open-product" data-tag="' + escapeHtml(p.uniqueTag) + '"' + (hasAny ? "" : ' data-open-modal="1"') + '>' + label + '</button></td>' +
    '</tr>' + changedDetailRow;
  }).join("");
  renderPagination(vp.length);
}

// Each key in generated IS already one card (one product+videoType
// slot) -- so this no longer needs any per-product grouping, just split
// the composite key back into tag/videoType.
function renderPanel() {
  const cardsEl = document.getElementById("panelCards");
  if (!cardsEl) return;
  const cards = Object.keys(generated).map((key) => {
    const sep = key.lastIndexOf("::");
    const tag = key.slice(0, sep);
    return { key, tag, product: PRODUCTS.find((p) => p.uniqueTag === tag), ...generated[key] };
  }).filter((c) => c.product);
  document.getElementById("genCount").textContent = cards.length;
  document.getElementById("panelEmpty").style.display = cards.length ? "none" : "block";
  cardsEl.innerHTML = cards.slice().reverse().map((g) => {
    let media;
    if (g.status === "generating") {
      media = '<div class="spinner"></div>';
    } else if (g.status === "error") {
      media = '<div class="panel-card-error">Generation failed. Try again, or contact support if this keeps happening.</div>';
    } else {
      const thumbSrc = g.thumbnailUrl || "";
      // Thumbnail generation upstream occasionally fails silently while the
      // video itself renders fine -- hide the img on load failure so a dead
      // link shows the plain placeholder background instead of a broken-image glyph.
      media = (thumbSrc ? '<img src="' + escapeHtml(thumbSrc) + '" alt="" onerror="this.style.display=\'none\'" />' : '') + '<div class="panel-card-play"></div>';
    }
    const clickable = g.status === "ready"
      ? ' class="panel-card-media playable" data-video-url="' + escapeHtml(g.videoUrl) + '" data-video-title="' + escapeHtml(g.product.name) + '" data-aspect-ratio="' + escapeHtml(g.aspectRatio || "16:9") + '"'
      : ' class="panel-card-media"';
    const badge = g.videoType ? '<span class="video-type-badge ' + g.videoType + '">' + (TYPE_LABELS[g.videoType] || g.videoType) + '</span>' : '';
    const downloadIconBtn = g.status === "ready"
      ? '<a class="panel-card-icon-btn" href="javascript:void(0)" data-action="download-video" data-tag="' + escapeHtml(g.tag) + '" data-video-type="' + escapeHtml(g.videoType) + '" title="Download video">' + DOWNLOAD_ICON_SVG + '</a>'
      : '';
    const deleteBtn = g.status !== "generating"
      ? '<button type="button" class="panel-card-delete" data-action="delete-video" data-tag="' + escapeHtml(g.tag) + '" data-video-type="' + escapeHtml(g.videoType) + '" title="Delete video">' + TRASH_ICON_SVG + '</button>'
      : '';
    const pushBtn = g.status === "ready"
      ? '<button type="button" class="action-btn" data-action="push-magento" data-tag="' + escapeHtml(g.tag) + '" data-video-type="' + escapeHtml(g.videoType) + '">' +
          (g.pushedToMagento ? "Update on product page" : "Add to product page") +
        '</button>'
      : '';
    const pushedNote = g.pushedToMagento ? '<div class="row-status">✓ Shown on the product page</div>' : '';
    return '<div class="panel-card">' +
      '<div class="panel-card-header"><span>' + escapeHtml(g.product.name) + '</span>' + badge + '</div>' +
      '<div' + clickable + '>' + media + '</div>' +
      '<div class="panel-card-footer">' +
        '<span>' + (g.status === "ready" ? "Ready — click to play" : g.status === "error" ? "Failed" : "Generating…") + '</span>' +
        '<span>' + downloadIconBtn + deleteBtn + '</span>' +
      '</div>' +
      (g.status === "ready" ? '<div class="panel-card-footer">' + pushBtn + pushedNote + '</div>' : '') +
    '</div>';
  }).join("");
}
// Single delegated listener on #appRoot for everything the list page
// needs -- the open-modal action, delete/push-to-Shopify, and the
// video-preview trigger. Previously these were three separate listeners
// bound directly to #chips/#rows/#panelCards; binding to the page-level
// root instead means future full re-renders of #appRoot's content (e.g.
// switching to a per-product detail view) don't silently lose them the
// way a container-level listener would.
document.getElementById("appRoot").addEventListener("click", async (e) => {
  const downloadBtn = e.target.closest('[data-action="download-video"]');
  if (downloadBtn) {
    downloadVideo(downloadBtn.dataset.tag, downloadBtn.dataset.videoType, downloadBtn.dataset.versionId || null);
    return;
  }

  // Navigates to the per-product detail page -- the list row's action
  // button (list mode). Only pre-checked when the row has no video yet
  // (label reads "Generate video" -- the sole point of clicking it is
  // to start a new one); a row with existing videos ("Manage video")
  // still navigates through normally regardless of billing status, so
  // a blocked shop can still view/push/delete what it already has.
  const openProductBtn = e.target.closest('[data-action="open-product"]');
  if (openProductBtn) {
    const tag = openProductBtn.dataset.tag;
    const preselect = openProductBtn.dataset.videoType || null;
    navigate({ mode: "detail", tag, tab: "videos", selectedType: preselect, expandedType: null });
    // "Generate video" (no slots yet) -- land straight in the modal
    // instead of an empty Videos tab (story criterion #8), using the
    // existing modal machinery rather than a new workspace section.
    if (openProductBtn.dataset.openModal === "1") openModal(tag, null, true);
    return;
  }

  // Row name/thumbnail -- opens on Overview ("Product details"),
  // distinct from the action button above, which opens on Videos.
  const openDetailsEl = e.target.closest('[data-action="open-product-details"]');
  if (openDetailsEl) {
    navigate({ mode: "detail", tag: openDetailsEl.dataset.tag, tab: "overview", selectedType: null, expandedType: null });
    return;
  }

  const enlargeImg = e.target.closest('[data-action="enlarge-image"]');
  if (enlargeImg) {
    openImagePreview(enlargeImg.dataset.imageUrl, enlargeImg.dataset.imageTitle);
    return;
  }

  const toggleChangedEl = e.target.closest('[data-action="toggle-changed"]');
  if (toggleChangedEl) {
    const tag = toggleChangedEl.dataset.tag;
    expandedChangedTag = expandedChangedTag === tag ? null : tag;
    renderRows();
    return;
  }

  const clearFilterEl = e.target.closest('[data-action="clear-filter"]');
  if (clearFilterEl) {
    const key = clearFilterEl.dataset.filterKey;
    listFilters[key] = key === "search" ? "" : "All";
    listFilters.page = 1;
    renderToolbar();
    renderRows();
    return;
  }

  const clearAllEl = e.target.closest('[data-action="clear-all-filters"]');
  if (clearAllEl) {
    listFilters.search = ""; listFilters.category = "All"; listFilters.status = "All"; listFilters.page = 1;
    renderToolbar();
    renderRows();
    return;
  }

  const prevPageEl = e.target.closest('[data-action="prev-page"]');
  if (prevPageEl && !prevPageEl.disabled) { listFilters.page--; renderRows(); return; }
  const nextPageEl = e.target.closest('[data-action="next-page"]');
  if (nextPageEl && !nextPageEl.disabled) { listFilters.page++; renderRows(); return; }

  const backBtn = e.target.closest('[data-action="back-to-list"]');
  if (backBtn) { navigate({ mode: "list", tag: null }); return; }

  const tabBtn = e.target.closest('[data-action="select-tab"]');
  if (tabBtn) { navigate({ tab: tabBtn.dataset.tab }); return; }

  const slotRow = e.target.closest('[data-action="select-slot"]');
  if (slotRow) {
    const type = slotRow.dataset.videoType;
    navigate({ selectedType: type, expandedType: view.expandedType === type ? null : type });
    return;
  }

  const shareBtn = e.target.closest('[data-action="share-preview"]');
  if (shareBtn) {
    try {
      await navigator.clipboard.writeText(shareBtn.dataset.videoUrl);
      alert("Video link copied — note it expires 7 days after generation.");
    } catch {
      alert(shareBtn.dataset.videoUrl);
    }
    return;
  }

  const cancelBtn = e.target.closest('[data-action="cancel-slot"]');
  if (cancelBtn) {
    const tag = cancelBtn.dataset.tag, videoType = cancelBtn.dataset.videoType;
    cancelBtn.disabled = true;
    try {
      const res = await fetch(apiUrl("/api/generated/" + encodeURIComponent(tag) + "/" + encodeURIComponent(videoType) + "/cancel"), { method: "POST" });
      const resBody = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(resBody.error || "Failed to cancel");
      const statusRes = await fetch(apiUrl("/api/status/" + encodeURIComponent(tag) + "/" + encodeURIComponent(videoType)));
      const state = await statusRes.json();
      generated[genKey(tag, videoType)] = { ...generated[genKey(tag, videoType)], ...state };
      renderAfterStateChange();
    } catch (err) {
      alert(err.message);
      cancelBtn.disabled = false;
    }
    return;
  }

  // Opens the Generate Video modal -- either a specific slot's Regenerate
  // button (detail page, carries data-video-type) or a generic entry
  // point with nothing preselected (detail page's "Generate another
  // video", carries no data-video-type).
  const openModalBtn = e.target.closest('[data-action="open-modal"]');
  if (openModalBtn) { openModal(openModalBtn.dataset.tag, openModalBtn.dataset.videoType || undefined); return; }

  const versionsBtn = e.target.closest('[data-action="open-versions"]');
  if (versionsBtn) { openVersionsPanel(versionsBtn.dataset.tag, versionsBtn.dataset.videoType); return; }

  const updateOverlayBtn = e.target.closest('[data-action="open-update-overlay"]');
  if (updateOverlayBtn) { openUpdateOverlayModal(updateOverlayBtn.dataset.tag, updateOverlayBtn.dataset.videoType); return; }

  const deleteBtn = e.target.closest('[data-action="delete-video"]');
  if (deleteBtn) {
    const tag = deleteBtn.dataset.tag, videoType = deleteBtn.dataset.videoType;
    delete generated[genKey(tag, videoType)];
    renderAfterStateChange();
    await fetch(apiUrl("/api/generated/" + encodeURIComponent(tag) + "/" + encodeURIComponent(videoType)), { method: "DELETE" });
    return;
  }

  const pushBtn = e.target.closest('[data-action="push-magento"]');
  if (pushBtn) {
    const tag = pushBtn.dataset.tag, videoType = pushBtn.dataset.videoType;
    pushBtn.disabled = true;
    const originalLabel = pushBtn.textContent;
    pushBtn.textContent = "Pushing…";
    try {
      const res = await fetch(apiUrl("/api/generated/" + encodeURIComponent(tag) + "/" + encodeURIComponent(videoType) + "/push-to-magento"), { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Failed to push video to Magento");
      const key = genKey(tag, videoType);
      generated[key] = { ...generated[key], pushedToMagento: true };
      // A product shows one video: pushing this type replaces whichever type was live before.
      VIDEO_TYPES.forEach((t) => { if (t !== videoType && generated[genKey(tag, t)]) generated[genKey(tag, t)] = { ...generated[genKey(tag, t)], pushedToMagento: false }; });
      renderAfterStateChange();
    } catch (err) {
      alert(err.message);
      pushBtn.disabled = false;
      pushBtn.textContent = originalLabel;
    }
    return;
  }

  const videoEl = e.target.closest("[data-video-url]");
  if (videoEl) openVideoPreview(videoEl.dataset.videoUrl, videoEl.dataset.videoTitle, videoEl.dataset.aspectRatio);
});

// Toolbar filters -- the toolbar itself is only ever rendered once (see
// renderToolbar), so these handlers just update listFilters and rewrite
// #rows/#count via renderRows(), never touching the controls themselves.
document.getElementById("appRoot").addEventListener("input", (e) => {
  if (e.target.id === "searchInput") {
    listFilters.search = e.target.value;
    listFilters.page = 1;
    renderRows();
    renderActiveFilterChips();
  }
});
document.getElementById("appRoot").addEventListener("change", (e) => {
  if (e.target.id === "sortSelect") listFilters.sort = e.target.value;
  else if (e.target.id === "categorySelect") { listFilters.category = e.target.value; listFilters.page = 1; }
  else if (e.target.id === "statusSelect") { listFilters.status = e.target.value; listFilters.page = 1; }
  else return;
  renderRows();
  renderActiveFilterChips();
});

// ---------- Per-product detail page ----------
// Zero new endpoints -- driven entirely from PRODUCTS/generated, already
// inlined into the page. Reachable via the list row's "Manage video" /
// "Generate video" action (data-action="open-product").

const DETAIL_TABS = [
  { key: "overview", label: "Overview" },
  { key: "videos", label: "Videos" },
  { key: "product_page", label: "Product page" },
];

function productSlots(tag) {
  return VIDEO_TYPES.map((t) => ({ type: t, gen: generated[genKey(tag, t)] }));
}

// The Videos tab's currently-displayed slot -- view.selectedType if it's
// still valid, else whichever slot already has a video, else just the
// first type (Hero Product).
function selectedSlot(slots) {
  const bySelection = view.selectedType && slots.find((s) => s.type === view.selectedType);
  return bySelection || slots.find((s) => s.gen) || slots[0];
}

function renderDetailTabBody(product, slots) {
  if (view.tab === "overview") {
    return '<div class="detail-overview">' +
      '<div class="field"><label>Category</label><div>' + escapeHtml(product.category) + '</div></div>' +
      '<div class="field"><label>Price</label><div>' + priceLabel(product) + '</div></div>' +
      '<div class="field"><label>Videos</label><div>' + slots.filter((s) => s.gen).length + ' of ' + VIDEO_TYPES.length + ' types generated</div></div>' +
    '</div>';
  }

  if (view.tab === "product_page") {
    return '<div class="detail-overview">' + slots.map((s) =>
      '<div class="field"><label>' + FULL_TYPE_LABELS[s.type] + '</label><div>' +
        (s.gen && s.gen.pushedToMagento
          ? 'Shown on the Magento product page'
          : '<span class="muted">Not on the product page yet</span>') +
      '</div></div>'
    ).join("") + '</div>';
  }

  // "videos" tab (default)
  const slot = selectedSlot(slots);
  const gen = slot.gen;
  const label = FULL_TYPE_LABELS[slot.type];
  if (!gen) {
    return '<div class="detail-player-title">' + label + '</div>' +
      '<div class="detail-player-empty muted">No ' + label + ' video yet.</div>' +
      '<div class="detail-actions">' +
        '<button type="button" class="btn-primary" data-action="open-modal" data-tag="' + escapeHtml(product.uniqueTag) + '" data-video-type="' + slot.type + '">Generate ' + label + ' video</button>' +
      '</div>';
  }

  const status = slotStatus(gen);
  let player;
  if (gen.status === "generating") player = '<div class="detail-player"><div class="spinner"></div></div>';
  else if (gen.status === "error") player = '<div class="detail-player-empty row-error">Generation failed. Try again, or contact support if this keeps happening.</div>';
  else player = '<div class="detail-player"><video src="' + escapeHtml(gen.videoUrl) + '" controls poster="' + escapeHtml(gen.thumbnailUrl || "") + '"></video></div>';

  const shareBtn = gen.status === "ready"
    ? '<button type="button" class="btn-text" data-action="share-preview" data-video-url="' + escapeHtml(gen.videoUrl) + '">Share preview</button>'
    : "";
  const downloadBtn = gen.status === "ready"
    ? '<a class="action-btn" href="javascript:void(0)" data-action="download-video" data-tag="' + escapeHtml(product.uniqueTag) + '" data-video-type="' + escapeHtml(slot.type) + '">Download</a>'
    : "";
  const pushBtn = gen.status === "ready"
    ? '<button type="button" class="action-btn" data-action="push-magento" data-tag="' + escapeHtml(product.uniqueTag) + '" data-video-type="' + slot.type + '">' +
        (gen.pushedToMagento ? "Update on product page" : "Add to product page") +
      '</button>'
    : "";
  const regenBtn = gen.status === "generating"
    ? '<button type="button" class="action-btn" data-action="cancel-slot" data-tag="' + escapeHtml(product.uniqueTag) + '" data-video-type="' + slot.type + '">' + (slot.type === "lifestyle" ? "Discard" : "Cancel") + '</button>'
    : '<button type="button" class="action-btn" data-action="open-modal" data-tag="' + escapeHtml(product.uniqueTag) + '" data-video-type="' + slot.type + '">Regenerate video</button>';
  // Only meaningful for a ready, overlay-backed video with a stored
  // project id -- see POST /api/update-overlay. Lets a merchant fix a
  // price/label typo without a full re-render or a billing charge.
  const updateOverlayBtn = gen.status === "ready" && gen.overlayFamily && gen.projectId
    ? '<button type="button" class="action-btn" data-action="open-update-overlay" data-tag="' + escapeHtml(product.uniqueTag) + '" data-video-type="' + slot.type + '">Update Overlay</button>'
    : "";
  const versionSuffix = gen.versionNo ? ' · Version ' + gen.versionNo : '';
  const historyBtn = gen.versionNo > 1
    ? '<button type="button" class="btn-text" data-action="open-versions" data-tag="' + escapeHtml(product.uniqueTag) + '" data-video-type="' + slot.type + '">Version history</button>'
    : "";
  const templateLine = gen.overlayFamily
    ? '<p class="muted">Overlay: ' + escapeHtml(gen.overlayFamily) + '</p>'
    : gen.templateName
    ? '<p class="muted">Current template: ' + escapeHtml(gen.templateName) + '</p>'
    : '';

  return '<div class="detail-player-title">' + label + versionSuffix + ' <span class="status-badge ' + status + '">' + status + '</span></div>' +
    templateLine +
    '<div class="detail-actions">' + shareBtn + downloadBtn + pushBtn + regenBtn + updateOverlayBtn + historyBtn + '</div>' +
    player;
}

function renderVideoSlotList(product, slots) {
  const cards = slots.map((s) => {
    const gen = s.gen;
    const status = slotStatus(gen);
    const expanded = view.expandedType === s.type;
    const thumb = gen && gen.thumbnailUrl
      ? '<img src="' + escapeHtml(gen.thumbnailUrl) + '" class="slot-card-thumb" />'
      : '<div class="thumb-placeholder"></div>';
    const versionSuffix = gen && gen.versionNo ? ' · Version ' + gen.versionNo : '';
    let body = "";
    if (expanded && gen) {
      const errorLine = gen.status === "error" ? '<div class="row-error">Generation failed. Try again, or contact support if this keeps happening.</div>' : "";
      const templateLine = gen.overlayFamily
        ? '<p class="muted">Overlay: ' + escapeHtml(gen.overlayFamily) + '</p>'
        : gen.templateName ? '<p class="muted">Current template: ' + escapeHtml(gen.templateName) + '</p>' : "";
      // A plain ready slot with no overlay family/template name and no
      // error has nothing to show here -- an empty .slot-card-body still
      // has its own padding, so wrapping nothing in it silently grew the
      // card by ~10px on every click with no visible content to justify it.
      if (errorLine || templateLine) body = '<div class="slot-card-body">' + errorLine + templateLine + '</div>';
    }
    const footerBtn = gen && gen.status === "generating"
      ? '<button type="button" class="action-btn" data-action="cancel-slot" data-tag="' + escapeHtml(product.uniqueTag) + '" data-video-type="' + s.type + '">' + (s.type === "lifestyle" ? "Discard" : "Cancel") + '</button>'
      : '<button type="button" class="action-btn" data-action="open-modal" data-tag="' + escapeHtml(product.uniqueTag) + '" data-video-type="' + s.type + '">' + (gen ? "Regenerate video" : "Generate video") + '</button>';
    const updateOverlayBtn = gen && gen.status === "ready" && gen.overlayFamily && gen.projectId
      ? '<button type="button" class="action-btn" data-action="open-update-overlay" data-tag="' + escapeHtml(product.uniqueTag) + '" data-video-type="' + s.type + '">Update Overlay</button>'
      : "";
    return '<div class="panel-card slot-card">' +
      '<div class="slot-card-row" data-action="select-slot" data-video-type="' + s.type + '">' +
        thumb +
        '<div class="slot-card-meta">' +
          '<div class="slot-card-type">' + FULL_TYPE_LABELS[s.type] + versionSuffix + '</div>' +
          '<span class="status-badge ' + status + '">' + status + '</span>' +
        '</div>' +
      '</div>' +
      body +
      // .panel-card-footer is justify-content:space-between (for the
      // OTHER footer shape elsewhere -- a button on one side, a note on
      // the other) -- two plain sibling buttons here would get pushed to
      // opposite edges of the card instead of sitting next to each
      // other, so they're wrapped as this footer's one single flex child.
      // Reuses .detail-actions rather than a new one-off gap value --
      // the same class the main player's own action-btn row uses, so
      // the two action-btn groups in this app share one spacing rule.
      '<div class="panel-card-footer"><div class="detail-actions" style="margin-bottom:0;">' + footerBtn + updateOverlayBtn + '</div></div>' +
    '</div>';
  }).join("");
  return cards + '<button type="button" class="btn-text" data-action="open-modal" data-tag="' + escapeHtml(product.uniqueTag) + '">Generate another video</button>';
}

// Shared by renderProductDetail's initial paint and
// renderAfterStateChange's poll-driven refresh, so the header's video
// count can never drift out of sync between the two like it used to --
// the header used to be built only once (renderProductDetail), so a
// video that finished rendering (candidates -> ready) while the
// merchant stayed on the page never updated its "0 videos" count until
// they navigated away and back.
function detailHeaderSubHtml(product, slots) {
  const slotCount = slots.filter((s) => s.gen).length;
  return escapeHtml(product.category) + ' · ' + priceLabel(product) + ' · ' + slotCount + ' video' + (slotCount === 1 ? '' : 's');
}

function renderProductDetail(tag) {
  const product = PRODUCTS.find((p) => p.uniqueTag === tag);
  if (!product) {
    return '<button type="button" class="btn-text back-link" data-action="back-to-list">← Back to products</button>' +
      '<p class="muted">Product not found — try Refresh.</p>';
  }
  const slots = productSlots(tag);
  // Clickable -- "view thumbnail at a larger size without leaving the
  // app" (story criterion #1). The list row's thumbnail already
  // navigates here on click; this is the actual enlarge affordance.
  const thumb = product.image
    ? '<img src="' + escapeHtml(product.image) + '" class="thumb enlargeable" data-action="enlarge-image" data-image-url="' + escapeHtml(product.image) + '" data-image-title="' + escapeHtml(product.name) + '" />'
    : '<div class="thumb-placeholder"></div>';

  return '<button type="button" class="btn-text back-link" data-action="back-to-list">← Back to products</button>' +
    '<div class="detail-header">' +
      thumb +
      '<div>' +
        '<h1 class="detail-header-title">' + escapeHtml(product.name) + '</h1>' +
        '<p class="detail-header-sub" id="detailHeaderSub">' + detailHeaderSubHtml(product, slots) + '</p>' +
      '</div>' +
    '</div>' +
    '<div class="tabs">' +
      DETAIL_TABS.map((t) => '<button type="button" class="tab' + (view.tab === t.key ? ' active' : '') + '" data-action="select-tab" data-tab="' + t.key + '">' + t.label + '</button>').join("") +
    '</div>' +
    '<div class="detail-layout">' +
      '<div class="detail-main" id="detailMain">' + renderDetailTabBody(product, slots) + '</div>' +
      '<div class="detail-side" id="detailSide">' + renderVideoSlotList(product, slots) + '</div>' +
    '</div>';
}

// Reconstructs the list page's static skeleton -- needed because
// navigating to the detail page replaces #appRoot's entire innerHTML,
// destroying it. Keep this in sync with the server-rendered body markup
// above (the initial page load uses that markup directly and never
// calls this -- this only rebuilds it after it's been torn down).
function renderListPage() {
  return '<div class="top-bar">' +
      '<div><h1>Select products</h1><p class="subtitle">' + escapeHtml(STORE_DOMAIN) + '</p></div>' +
      '<div style="display:flex; align-items:center; gap:10px;">' +
        '<div class="usage-badge" id="usageBadge"></div>' +
        '<button class="btn-primary" id="planCta" onclick="openPlanModal(\'manual\')">View Plans</button>' +
        '<button class="stroked" id="refresh" onclick="refresh()">Refresh from Magento</button>' +
      '</div>' +
    '</div>' +
    '<div class="selection-layout">' +
      '<div class="main-column">' +
        '<div class="toolbar">' +
          '<input type="text" class="toolbar-search" id="searchInput" placeholder="Search products" />' +
          '<select class="toolbar-select" id="sortSelect">' +
            '<option value="recent">Most recent generation</option>' +
            '<option value="name">Name (A-Z)</option>' +
            '<option value="category">Category</option>' +
            '<option value="updated">Recently updated</option>' +
            '<option value="price-desc">Price: high to low</option>' +
            '<option value="price-asc">Price: low to high</option>' +
          '</select>' +
          '<select class="toolbar-select" id="categorySelect"></select>' +
          '<select class="toolbar-select" id="statusSelect">' +
            '<option value="All">Status: All</option>' +
            '<option value="rendering">Rendering</option>' +
            '<option value="ready">Ready</option>' +
            '<option value="published">Published</option>' +
            '<option value="failed">Failed</option>' +
            '<option value="none">No videos</option>' +
          '</select>' +
          '<span class="product-count" id="count"></span>' +
        '</div>' +
        '<div class="filter-chips" id="filterChips"></div>' +
        '<div class="refresh-error" id="refreshError" style="display:none"></div>' +
        '<table>' +
          '<thead><tr><th></th><th>Name</th><th>Category</th><th>Price</th><th>Video status</th><th>Updated</th><th>Actions</th></tr></thead>' +
          '<tbody id="rows"></tbody>' +
        '</table>' +
        '<div class="pagination" id="pagination"></div>' +
      '</div>' +
      '<div class="detail-panel">' +
        '<h2>Generated videos <span class="panel-count" id="genCount">0</span></h2>' +
        '<div class="panel-empty" id="panelEmpty">Generated videos will appear here.</div>' +
        '<div id="panelCards"></div>' +
      '</div>' +
    '</div>';
}

// ---------- Version history panel ----------
// A lightweight modal-like overlay (same .modal-backdrop/.modal CSS as
// the Generate Video modal), fetching /api/generated/:tag/:type/versions
// on demand -- outside #appRoot (sibling of #modalRoot) so its own click
// listener survives #appRoot being torn down/rebuilt on navigation.

let versionsPanel = null; // { tag, videoType, loading, versions }

async function openVersionsPanel(tag, videoType) {
  versionsPanel = { tag, videoType, loading: true, versions: [] };
  renderVersionsPanel();
  try {
    const res = await fetch(apiUrl("/api/generated/" + encodeURIComponent(tag) + "/" + encodeURIComponent(videoType) + "/versions"));
    const body = await res.json();
    versionsPanel.versions = body.versions || [];
  } catch {
    versionsPanel.versions = [];
  }
  versionsPanel.loading = false;
  renderVersionsPanel();
}

function closeVersionsPanel() {
  versionsPanel = null;
  document.getElementById("versionsPanelRoot").innerHTML = "";
}

async function restoreVersion(tag, videoType, versionId) {
  await fetch(apiUrl("/api/generated/" + encodeURIComponent(tag) + "/" + encodeURIComponent(videoType) + "/versions/" + encodeURIComponent(versionId) + "/restore"), { method: "POST" });
  const res = await fetch(apiUrl("/api/status/" + encodeURIComponent(tag) + "/" + encodeURIComponent(videoType)));
  const state = await res.json();
  generated[genKey(tag, videoType)] = { ...generated[genKey(tag, videoType)], ...state };
  renderAfterStateChange();
  closeVersionsPanel();
}

function renderVersionsPanel() {
  const root = document.getElementById("versionsPanelRoot");
  if (!versionsPanel) { root.innerHTML = ""; return; }
  const { tag, videoType, loading, versions } = versionsPanel;
  const currentVersionId = generated[genKey(tag, videoType)]?.currentVersionId;
  const label = FULL_TYPE_LABELS[videoType];
  let body;
  if (loading) {
    body = '<div class="loading-block"><div class="spinner"></div></div>';
  } else if (!versions.length) {
    body = '<p class="muted">No versions yet.</p>';
  } else {
    body = versions.map((v) => {
      const isCurrent = String(v.id) === String(currentVersionId);
      const thumb = v.thumbnailUrl ? '<img src="' + escapeHtml(v.thumbnailUrl) + '" alt="" />' : '';
      return '<div class="panel-card">' +
        '<div class="panel-card-header"><span>Version ' + v.versionNo + (isCurrent ? ' (current)' : '') + '</span>' +
          '<span class="status-badge ' + v.status + '">' + v.status + '</span></div>' +
        (thumb ? '<div class="panel-card-media">' + thumb + '</div>' : '') +
        '<div class="panel-card-footer">' +
          '<span>' + (v.overlayFamily ? escapeHtml(v.overlayFamily) : v.templateName ? escapeHtml(v.templateName) : '') + '</span>' +
          (v.status === "ready" ? '<a class="action-btn" href="javascript:void(0)" data-action="download-video" data-tag="' + escapeHtml(tag) + '" data-video-type="' + escapeHtml(videoType) + '" data-version-id="' + escapeHtml(String(v.id)) + '">Download</a>' : '') +
          (!isCurrent ? '<button type="button" class="action-btn" data-action="restore-version" data-tag="' + escapeHtml(tag) + '" data-video-type="' + videoType + '" data-version-id="' + v.id + '">Restore</button>' : '') +
        '</div>' +
      '</div>';
    }).join("");
  }
  root.innerHTML = '<div class="modal-backdrop"><div class="modal">' +
    '<div class="modal-header">' + label + ' — version history</div>' +
    '<div class="modal-body">' + body + '</div>' +
    '<div class="modal-actions"><button type="button" class="btn-text" data-action="close-versions-panel">Close</button></div>' +
  '</div></div>';
}

document.getElementById("versionsPanelRoot").addEventListener("click", (e) => {
  if (e.target.closest('[data-action="close-versions-panel"]')) { closeVersionsPanel(); return; }
  const restoreBtn = e.target.closest('[data-action="restore-version"]');
  if (restoreBtn) { restoreVersion(restoreBtn.dataset.tag, restoreBtn.dataset.videoType, restoreBtn.dataset.versionId); return; }
  const downloadBtn = e.target.closest('[data-action="download-video"]');
  if (downloadBtn) downloadVideo(downloadBtn.dataset.tag, downloadBtn.dataset.videoType, downloadBtn.dataset.versionId || null);
});

// ---------- Video preview popup ----------

// Sizes the popup box to the video's real aspect ratio instead of always
// assuming 16:9 -- a portrait (9:16) or square (1:1) video previously got
// shown inside a landscape-shaped box (object-fit:contain avoided visible
// distortion, but left large empty bars either way).
function boxDimensionsForAspectRatio(aspectRatio) {
  const ratio = aspectRatio === "9:16" ? 9 / 16 : aspectRatio === "1:1" ? 1 : 16 / 9;
  const maxWidth = Math.min(window.innerWidth * 0.7, 960);
  const maxHeight = window.innerHeight * 0.8;
  let width = maxWidth;
  let height = width / ratio;
  if (height > maxHeight) {
    height = maxHeight;
    width = height * ratio;
  }
  return { width, height };
}

function openVideoPreview(url, title, aspectRatio) {
  const { width, height } = boxDimensionsForAspectRatio(aspectRatio);
  document.getElementById("videoPreviewRoot").innerHTML =
    '<div class="video-preview-backdrop" id="videoPreviewBackdrop">' +
      '<div class="video-preview-box" style="width:' + Math.round(width) + 'px;height:' + Math.round(height) + 'px">' +
        '<div class="video-preview-header">' +
          '<span class="video-preview-title">' + escapeHtml(title) + '</span>' +
          '<button type="button" class="video-preview-close" data-action="close-video-preview" aria-label="Close">✕</button>' +
        '</div>' +
        '<div class="video-preview-body">' +
          '<video src="' + escapeHtml(url) + '" controls controlslist="nofullscreen" autoplay></video>' +
        '</div>' +
      '</div>' +
    '</div>';
}

function closeVideoPreview() {
  document.getElementById("videoPreviewRoot").innerHTML = "";
}

// Same backdrop/box pattern as the video preview above, for "view the
// product thumbnail at a larger size without leaving the app" (story
// criterion #1) -- a plain <img>, no aspect-ratio box sizing needed.
function openImagePreview(url, title) {
  document.getElementById("imagePreviewRoot").innerHTML =
    '<div class="video-preview-backdrop" id="imagePreviewBackdrop">' +
      '<div class="video-preview-box image-preview-box">' +
        '<div class="video-preview-header">' +
          '<span class="video-preview-title">' + escapeHtml(title || "") + '</span>' +
          '<button type="button" class="video-preview-close" data-action="close-image-preview" aria-label="Close">✕</button>' +
        '</div>' +
        '<div class="video-preview-body"><img src="' + escapeHtml(url) + '" alt="" /></div>' +
      '</div>' +
    '</div>';
}

function closeImagePreview() {
  document.getElementById("imagePreviewRoot").innerHTML = "";
}

document.getElementById("imagePreviewRoot").addEventListener("click", (e) => {
  if (e.target.id === "imagePreviewBackdrop" || e.target.closest('[data-action="close-image-preview"]')) {
    closeImagePreview();
  }
});

document.getElementById("videoPreviewRoot").addEventListener("click", (e) => {
  if (e.target.id === "videoPreviewBackdrop" || e.target.closest('[data-action="close-video-preview"]')) {
    closeVideoPreview();
  }
});
document.getElementById("videoPreviewRoot").addEventListener("webkitbeginfullscreen", (e) => {
  if (e.target.tagName === "VIDEO" && e.target.webkitExitFullscreen) e.target.webkitExitFullscreen();
}, true);

async function showRefreshError(message) {
  const el = document.getElementById("refreshError");
  if (!el) return;
  el.textContent = message;
  el.style.display = "block";
}

async function refresh() {
  const btn = document.getElementById("refresh");
  btn.disabled = true;
  const errEl = document.getElementById("refreshError");
  if (errEl) errEl.style.display = "none";
  try {
    // apiUrl(), not a raw path -- this app is multi-shop, and every
    // other fetch appends ?shop= this way; a raw path would refresh
    // the wrong (or no) shop's cache.
    const res = await fetch(apiUrl("/api/refresh"), { method: "POST" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || "Refresh failed (" + res.status + ")");
    }
    // Only the reload path needs filters/page restored -- persist right
    // before it, not any earlier, so a failed refresh leaves the current
    // in-memory state (and the controls showing it) untouched.
    sessionStorage.setItem(LIST_FILTERS_KEY, JSON.stringify(listFilters));
    window.location.reload();
  } catch (err) {
    showRefreshError("Couldn't refresh from Magento: " + err.message);
    btn.disabled = false;
  }
}

// ---------- Polling ----------

// MAX_POLL_ATTEMPTS is a backstop, not the expected path -- generation
// normally settles within a few minutes. It exists so a request that
// silently vanishes server-side (e.g. this adapter's own process
// restarting mid-render) surfaces as a clear error instead of leaving
// "Generating..." on screen forever with no way to tell it's actually dead.
const MAX_POLL_ATTEMPTS = 200; // 200 * 3s = 10 minutes
// Keyed by genKey(tag, videoType) -- Hero and Lifestyle poll independently
// for the same product. onSettled (optional) drives the Generate Video
// modal's sequential queue: fires once this slot leaves "generating",
// whether it ended up ready, errored, or timed out.
function startPolling(tag, videoType, onSettled) {
  const key = genKey(tag, videoType);
  if (pollTimers[key]) return;
  let attempts = 0;
  pollTimers[key] = setInterval(async () => {
    attempts++;
    let state;
    try {
      const res = await fetch(apiUrl("/api/status/" + encodeURIComponent(tag) + "/" + encodeURIComponent(videoType)));
      // A non-OK response (e.g. a transient 401 -- shopifyAuthedFetch
      // fetches a fresh session token via idToken() on every single poll
      // tick, for the entire duration of a multi-minute generation, so a
      // brief failure there is expected occasionally) is NOT a settled
      // state and must never be treated like one. Its body still parses
      // as valid, truthy JSON (e.g. {error: "Invalid session token..."})
      // with no .status field -- previously that fell through to the
      // merge/settle logic below, which doesn't overwrite the existing
      // "generating" status (nothing in the error body to overwrite it
      // with) but DOES see state.status !== "generating" and clears the
      // interval anyway -- permanently freezing the slot at "generating"
      // forever, with nothing left to ever poll again and correct it,
      // even though the backend finishes the render normally. Falling
      // through to the exact same "no useful answer this tick, retry"
      // path a network failure already takes costs one harmless retry on
      // a real transient failure, never a wrong early settle.
      state = res.ok ? await res.json() : null;
    } catch (err) {
      state = null; // transient network hiccup -- try again next tick, same as a "none" response
    }
    if (!state || state.status === "none") {
      if (attempts >= MAX_POLL_ATTEMPTS) {
        generated[key] = { status: "error", videoType, error: "Timed out waiting for a response — try generating again." };
        renderAfterStateChange();
        clearInterval(pollTimers[key]);
        delete pollTimers[key];
        if (onSettled) onSettled();
      }
      return;
    }
    // Merge, don't replace -- /api/status returns the server's record
    // shape, but any field the client set optimistically and the server
    // doesn't happen to echo back (or a future field the route hasn't
    // been updated to return yet) would otherwise be silently erased
    // on every poll tick.
    const merged = { ...generated[key], ...state };
    // renderAfterStateChange() rebuilds the main player/sidebar via a
    // full innerHTML replace -- tearing down and recreating the "generating"
    // spinner (and any thumbnail <img>) from scratch on every single 3s
    // tick, even when literally nothing changed, which reads as a brief
    // flicker/reset ("the progress layer vanishes") rather than steady
    // progress. Skip the re-render when this tick's merged state is
    // identical to what's already on screen.
    const changed = JSON.stringify(merged) !== JSON.stringify(generated[key]);
    generated[key] = merged;
    // Always render on a settle transition, diff or no diff -- polling
    // unconditionally stops the moment status leaves "generating" below,
    // so this is the one tick where skipping the render would leave the
    // preview stuck on stale "generating" state forever, with no later
    // tick left to correct it.
    if (changed || state.status !== "generating") renderAfterStateChange();
    if (state.status !== "generating") {
      clearInterval(pollTimers[key]);
      delete pollTimers[key];
      // A settled slot may have just moved the needle on usage (a
      // completed render counts toward quota; a failed one doesn't) --
      // cheap enough to just re-fetch rather than try to predict it.
      refreshBilling();
      if (onSettled) onSettled();
    }
  }, 3000);
}

// (Plans & Billing lives in billing.js, loaded before this file.)

// ---------- Generate Video modal ----------
// Mirrors circular-importer's GenerateVideoDialogComponent: form -> loading-preview -> picking -> preview-error.

let modal = null;
const FULL_TYPE_LABELS = { hero_product: "Hero Product", lifestyle: "Lifestyle", image_transition: "Image Transitions" };

function defaultAspectRatio() { return "16:9"; }

// The modal is always scoped to exactly ONE video type -- there's no
// longer a multi-checkbox "pick any subset" form. preselectType is set
// whenever the caller already knows which type (every per-slot
// Generate/Regenerate button on the detail page); when it's absent (the
// list row's quick-generate action, or the detail page's generic
// "Generate another video"), the form's first step asks which type
// before showing any fields for it (see selectVideoType()).
async function openModal(tag, preselectType, quickGenerate) {
  const blockedReason = isBillingBlocked();
  if (blockedReason) {
    openPlanModal(blockedReason);
    return;
  }
  // A specific slot's own Generate/Regenerate button (sidebar or main
  // player) -- switch the main preview to that slot right away, so it
  // shows this slot's progress/result instead of whatever was selected
  // before (previously stuck wherever it last was, e.g. Hero Product,
  // even after generating/updating a completely different slot).
  if (preselectType && view.mode === "detail" && view.tag === tag) {
    navigate({ selectedType: preselectType, expandedType: preselectType });
  }
  const product = PRODUCTS.find((p) => p.uniqueTag === tag);
  modal = {
    tag, product,
    // Set only by the list row's "Generate video" action (zero videos
    // yet) auto-opening this modal on arrival -- cancelModal() uses it
    // to decide whether canceling should drop the merchant back on the
    // list instead of stranding them on the detail page they never
    // meant to visit (story criterion #8's own intent: a quick in-and-out
    // action, not a permanent move into the workspace).
    quickGenerate: !!quickGenerate,
    step: "form",
    // videoType (singular) is set only via selectVideoType, for the
    // preselectType path (per-slot Regenerate/Generate -- always exactly
    // one, already-known type). videoTypes (plural) is the checkbox
    // multi-select's own state, used only when preselectType is absent
    // -- the two never coexist in one modal instance.
    videoType: null,
    videoTypes: [],
    promptByType: {}, loadingDefaultByType: {},
    aspectRatio: defaultAspectRatio(),
    prompt: "", loadingDefault: false,
    overlayFamily: "", overlayFamilies: [], loadingOverlayFamilies: false,
    overlayPreviewUrl: null, loadingOverlayPreview: false,
    // Flipick has no API that exposes which overlay tokens a template
    // declares, or which convention it uses -- some templates use
    // positional keys (v1, v2, ...), others use named offer-style keys
    // ($$Description$$, $$SalePrice$$, ...). Only visible in LTX Studio's
    // overlay editor -- the token name is pre-filled positionally
    // (v1, v2, ...) so picking a value alone is enough to work for the
    // common case, but stays free text the user can overwrite (e.g. to
    // "Description") when a template uses named tokens instead. Its
    // value is picked from this product's own attributes (see
    // attributeOptions below) rather than typed -- e.g. mapping v1 to
    // MRP -- with a "Custom text" escape hatch per row for values that
    // aren't a product attribute at all. variablesTouched (not merely
    // "any row has a key", since every row always has one now) is what
    // decides whether this overlay applies at all: leaving the section
    // alone entirely still falls back to the Offers overlay.
    variableRows: [{ key: "v1", value: "", customMode: true }],
    variablesTouched: false,
    // Set by applyDynamicVariableFields() once an Overlay Family with
    // declared content fields (renderer_config.variables) is picked --
    // the row layout/add/remove UX above stays exactly the same, this
    // just makes each row's key cell a dropdown of the overlay's real
    // field names (e.g. price/label/strike) instead of free text, since
    // that name has to match exactly what the overlay's renderer reads.
    dynamicVariableOptions: [],
    attributeOptions: [], loadingAttributeOptions: true,
    animation: "", // only meaningful for image_transition
    queue: [],
    queueIndex: 0,
    selections: [],
    previewImages: [],
    previewError: null,
  };
  loadAttributeOptions();
  if (preselectType) await selectVideoType(preselectType);
  else renderModal();
}

// "Update Overlay" -- a much narrower modal than the full Generate flow
// above: no Size/Prompt/starting-frame steps, and the Overlay Family is
// fixed to whatever this slot already has (family-switching was
// deliberately dropped from this feature's scope -- see POST
// /api/update-overlay) -- just the declared field values. Reuses the
// exact same variable-row machinery (variableFieldsHtml/keyFieldHtml/
// onVariableKeyChange/...) as the Generate modal's own Variables section.
async function openUpdateOverlayModal(tag, videoType) {
  const gen = generated[genKey(tag, videoType)];
  if (!gen || !gen.overlayFamily || !gen.projectId) return;
  // Same reasoning as openModal's identical check -- clicking this
  // slot's own action button should switch the main preview to it.
  if (view.mode === "detail" && view.tag === tag) {
    navigate({ selectedType: videoType, expandedType: videoType });
  }
  const product = PRODUCTS.find((p) => p.uniqueTag === tag);
  modal = {
    tag, product,
    mode: "update-overlay",
    quickGenerate: false,
    step: "update-overlay-form",
    videoType, videoTypes: [],
    promptByType: {}, loadingDefaultByType: {},
    aspectRatio: gen.aspectRatio || defaultAspectRatio(),
    prompt: "", loadingDefault: false,
    // Fixed to this slot's existing family -- loadModalOverlayFamilies()
    // below only confirms it's still valid and loads its declared
    // fields; there's no family picker for this step (see renderModal).
    // Starts "loading" (not false) so the very first render shows a
    // placeholder instead of a single blank row that then jumps to
    // however many fields the family actually declares once that load
    // resolves -- see renderModal's update-overlay-form branch.
    overlayFamily: gen.overlayFamily, overlayFamilies: [], loadingOverlayFamilies: true,
    overlayPreviewUrl: null, loadingOverlayPreview: false,
    variableRows: [{ key: "v1", value: "", customMode: true }],
    variablesTouched: false,
    dynamicVariableOptions: [],
    // The values this slot was last generated/updated with (see
    // /api/generate and /api/update-overlay persisting overlayValues) --
    // applyDynamicVariableFields() uses this to prefill rows instead of
    // starting blank, since the merchant is editing an existing overlay,
    // not creating one from scratch.
    prefillOverlayValues: gen.overlayValues || {},
    attributeOptions: [], loadingAttributeOptions: true,
    animation: "",
    queue: [], queueIndex: 0, selections: [],
    previewImages: [], previewError: null,
  };
  renderModal();
  // Awaited (unlike openModal's fire-and-forget call) -- applyDynamicVariableFields()
  // (called from within loadModalOverlayFamilies below) needs modal.attributeOptions
  // already populated to re-select a field's original dropdown attribute correctly.
  await loadAttributeOptions();
  // Preview NOT skipped here (unlike the initial cut of this feature) --
  // shown below the "Overlay: X" line (see renderModal's
  // update-overlay-form branch) so the merchant can see exactly which
  // on-screen element each Variable row maps to before editing it.
  await loadModalOverlayFamilies();
}

async function loadAttributeOptions() {
  try {
    // apiUrl(), not a raw path -- this app is multi-shop, and a raw
    // path silently resolves against whichever shop this server's
    // .env fallback happens to be, returning an empty options list
    // (a 404, not a thrown error) for every other shop -- confirmed
    // live against the deployed stage instance, whose fallback shop
    // doesn't match san2-test-store.
    const res = await fetch(apiUrl("/api/product-attributes/" + encodeURIComponent(modal.tag)));
    const body = await res.json();
    modal.attributeOptions = body.options || [];
  } catch {
    modal.attributeOptions = [];
  }
  modal.loadingAttributeOptions = false;
  renderModal();
}

// Picks (or switches) which type this modal instance is for -- seeds
// Size from that type's existing record if there is one, and (re)loads
// its Prompt default + Overlay Family list. Called either once, right after
// openModal (when the caller already knew the type), or interactively
// from the form's Video Type picker (when it didn't).
async function selectVideoType(videoType) {
  modal.videoType = videoType;
  const existing = generated[genKey(modal.tag, videoType)];
  modal.aspectRatio = (existing && existing.aspectRatio) || defaultAspectRatio();
  modal.overlayFamily = ""; modal.overlayFamilies = [];
  modal.variableRows = [{ key: "v1", value: "", customMode: true }];
  modal.variablesTouched = false;
  modal.dynamicVariableOptions = [];
  modal.prompt = ""; modal.animation = "";
  renderModal();
  await refillPromptDefault();
  await loadModalOverlayFamilies();
}

function onVideoTypeChange(value) { selectVideoType(value); }

// The checkbox multi-select's own toggle -- distinct from
// onVideoTypeChange/selectVideoType above (the single, preselected-type
// radio path), since here more than one type can be active at once,
// sharing one Size/Overlay Family/Variables section but each keeping its
// own Prompt. Only the FIRST type checked triggers the shared Size/
// Overlay Family load -- the family catalog isn't video-type-specific at
// all, so re-loading on every subsequent toggle would just repeat the
// same request for no reason.
async function onVideoTypeToggle(type) {
  const index = modal.videoTypes.indexOf(type);
  if (index === -1) {
    const isFirst = modal.videoTypes.length === 0;
    modal.videoTypes.push(type);
    renderModal();
    if (isFirst) await loadModalOverlayFamilies();
    if (modal.promptByType[type] === undefined) await loadPromptDefaultFor(type);
  } else {
    modal.videoTypes.splice(index, 1);
    renderModal();
  }
}

async function loadPromptDefaultFor(type) {
  modal.loadingDefaultByType[type] = true;
  renderModal();
  try {
    const res = await fetch(apiUrl("/api/prompt-default"), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uniqueTag: modal.tag, videoType: type }),
    });
    const body = await res.json();
    modal.promptByType[type] = body.prompt || "";
  } catch {
    modal.promptByType[type] = modal.promptByType[type] || "";
  }
  modal.loadingDefaultByType[type] = false;
  renderModal();
}

function onPromptByTypeChange(type, value) {
  modal.promptByType[type] = value;
}

// Fetches the Overlay Family list (LTX Brand-tab concept -- replaces the
// old per-type Video Template picker) for the modal's current size --
// called once a type is chosen (openModal/selectVideoType) and again
// whenever Size changes, since the list is aspect-ratio-filtered. One
// shared catalog regardless of video type (unlike the old Template
// picker, which drew from two different hosts' separate catalogs), so
// the checkbox multi-select can load it once for whichever type was
// checked first. No "default" concept exists for Overlay Families (no
// analog to Template Groups' is_default bundle) -- the user always picks
// explicitly, starting from "(none)".
async function loadModalOverlayFamilies() {
  modal.loadingOverlayFamilies = true;
  renderModal();
  try {
    // apiUrl(), not a raw path -- same multi-shop bug class as
    // loadAttributeOptions above: a raw path resolves against whichever
    // shop this server's .env fallback happens to be, so on any OTHER
    // shop this silently returns that wrong shop's family list (a 404,
    // not a thrown error). Harmless for a brand-new Generate modal
    // (nothing to preserve yet), but openUpdateOverlayModal seeds
    // modal.overlayFamily from an existing video BEFORE this call, and a
    // wrong-shop list won't contain it -- so it got reset to "" here,
    // even though the family really is attached.
    const res = await fetch(apiUrl("/api/overlay-families?aspectRatio=" + encodeURIComponent(modal.aspectRatio)));
    const body = await res.json();
    modal.overlayFamilies = body.families || [];
  } catch {
    modal.overlayFamilies = [];
  }
  // Keep the current selection if it's still valid for this size;
  // otherwise reset to "(none)" -- no auto-default to pick from instead.
  if (!modal.overlayFamilies.some((f) => f.name === modal.overlayFamily)) {
    modal.overlayFamily = "";
  }
  applyDynamicVariableFields();
  modal.loadingOverlayFamilies = false;
  renderModal();
  loadOverlayPreview();
}

// Mirrors the old Template picker's loadTemplatePreview() one-for-one --
// fetches a live render of the currently chosen family at the current
// Size, revoking the previous object URL first (these are real, if
// small, browser-held resources -- letting them pile up across several
// family/size changes in one modal session is a real leak, not just
// theoretical). "(none)" clears the preview instead of fetching.
async function loadOverlayPreview() {
  const family = modal.overlayFamily;
  if (modal.overlayPreviewUrl) { URL.revokeObjectURL(modal.overlayPreviewUrl); modal.overlayPreviewUrl = null; }
  if (!family) { modal.loadingOverlayPreview = false; renderModal(); return; }
  modal.loadingOverlayPreview = true;
  renderModal();
  let objectUrl = null;
  try {
    // uniqueTag lets the server substitute this product's own
    // price/MRP/name/category into the preview's declared fields (see
    // /api/overlay-families/:name/preview) instead of generic sample
    // text -- apiUrl(), not a raw path, since resolving that product
    // needs the right shop (same reasoning as refillPromptDefault's).
    const res = await fetch(apiUrl("/api/overlay-families/" + encodeURIComponent(family) + "/preview?aspectRatio=" + encodeURIComponent(modal.aspectRatio) + "&uniqueTag=" + encodeURIComponent(modal.tag)));
    if (!res.ok) throw new Error();
    objectUrl = URL.createObjectURL(await res.blob());
  } catch {
    objectUrl = null;
  }
  // The user may have changed the family (or cleared it) while this was
  // in flight -- don't stomp a newer selection's state with this stale
  // result, and don't leak the object URL we just created for nothing.
  if (!modal || modal.overlayFamily !== family) {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    return;
  }
  modal.overlayPreviewUrl = objectUrl;
  modal.loadingOverlayPreview = false;
  renderModal();
}

function onAspectRatioChange(value) {
  modal.aspectRatio = value;
  loadModalOverlayFamilies();
}

async function refillPromptDefault() {
  modal.loadingDefault = true;
  renderModal();
  try {
    // apiUrl(), not a raw path -- /api/prompt-default resolves the
    // product via resolveShop(req), which falls back to the .env
    // default shop with no ?shop= present. Same silent-empty-result
    // bug class as loadAttributeOptions above, just landing on the
    // prompt field instead of the attribute dropdown.
    const res = await fetch(apiUrl("/api/prompt-default"), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uniqueTag: modal.tag, videoType: modal.videoType }),
    });
    const body = await res.json();
    modal.prompt = body.prompt || "";
  } catch { /* leave prompt as-is */ }
  modal.loadingDefault = false;
  renderModal();
}

function onFieldChange(field, value) {
  modal[field] = value;
}

function onOverlayFamilyChange(value) {
  modal.overlayFamily = value;
  applyDynamicVariableFields();
  renderModal();
  loadOverlayPreview();
}

// A family's declared content fields (renderer_config.variables --
// e.g. ["price","label","strike"] for a Price Card, ["line1","line2"]
// for a Promo Burst) just swap each row's free-text key input for a
// dropdown of those real names -- the row/add/remove layout underneath
// is untouched, since the name has to match exactly what that overlay's
// renderer actually reads and a wrong/missing name means that field
// silently never renders (the bug this whole thing exists to fix).
// Falls back to the original free-form v1/v2/... system for any family
// with none declared -- most hand-built templates don't have this
// backfilled yet, only Price Card/Promo Burst/Lower Third/Caption strip
// — dark/the two Headline styles as of this writing.
function applyDynamicVariableFields() {
  const family = modal.overlayFamilies.find((f) => f.name === modal.overlayFamily);
  const declared = family && Array.isArray(family.variables) ? family.variables : [];
  modal.dynamicVariableOptions = declared;
  // modal.prefillOverlayValues is only ever set by openUpdateOverlayModal
  // -- every other caller (fresh Generate/Regenerate) leaves it unset, so
  // this still starts blank for them exactly as before.
  //
  // Stored shape is { values: {key: text}, selections: {key: attributeKey} }
  // (see buildVariablePayload/POST /api/generate & /api/update-overlay);
  // a bare flat map is also accepted (older-shaped data, or nothing ever
  // picked from the dropdown for that field) and treated as values-only.
  const existing = modal.prefillOverlayValues;
  const existingValues = existing && (existing.values || existing);
  const existingSelections = (existing && existing.selections) || {};
  // A field that was originally picked from the attribute dropdown (e.g.
  // "Price") should reopen re-selected, not fall back to "Custom text"
  // showing just the frozen old text -- and showing it live/current
  // (modal.attributeOptions must already be loaded; openUpdateOverlayModal
  // awaits that before this runs) rather than the value at generation time,
  // consistent with how picking the option fresh always behaves.
  const buildRow = (key) => {
    const attributeKey = existingSelections[key];
    const option = attributeKey && modal.attributeOptions.find((o) => o.key === attributeKey);
    if (option) return { key, value: option.value, customMode: false, selectedAttributeKey: attributeKey };
    return { key, value: (existingValues && existingValues[key]) || "", customMode: true };
  };
  // Only reopen rows the merchant actually filled in -- a non-blank
  // value, or an attribute picked even if it happened to resolve blank
  // (e.g. "Offer" on a product with no discount). A declared field left
  // untouched (e.g. "strike" on a product with no MRP -- commitCurrent
  // unions every declared field in as "" so it's always present in
  // existingValues) stays hidden behind "+ Add variable", same as it
  // would in a fresh Generate modal.
  const candidateKeys = existingValues ? (declared.length ? declared : Object.keys(existingValues)) : [];
  const usedKeys = candidateKeys.filter((key) => !!(existingValues && existingValues[key]) || !!existingSelections[key]);
  modal.variableRows = usedKeys.length
    ? usedKeys.map(buildRow)
    : [{ key: declared[0] || "v1", value: "", customMode: true }];
  modal.variablesTouched = false;
}

// "price" -> "Price", "line1" -> "Line 1", "strike" -> "Strike-through
// price" (override -- reads better than the bare word alone).
const VARIABLE_LABEL_OVERRIDES = { strike: "Strike-through price" };
function humanizeVariableName(key) {
  if (VARIABLE_LABEL_OVERRIDES[key]) return VARIABLE_LABEL_OVERRIDES[key];
  return key.replace(/([a-z])([0-9])/gi, "$1 $2").replace(/^./, (c) => c.toUpperCase());
}

// Templates don't agree on one token convention -- some use positional
// v1..v5, others use named offer-style tokens ($$Description$$,
// $$SalePrice$$, ...). With no API to say which, the token name is free
// text the user copies from LTX Studio's overlay editor.
const MAX_OVERLAY_VARIABLES = 8;
const CUSTOM_VALUE_SENTINEL = "__custom__";

function onVariableKeyChange(index, value) {
  modal.variableRows[index].key = value;
  modal.variablesTouched = true;
}

// Free-text path -- only reachable while that row's dropdown is on
// "Custom text" (see onVariableValueSelect).
function onVariableValueChange(index, value) {
  modal.variableRows[index].value = value;
  modal.variablesTouched = true;
}

// The dropdown itself -- either a product attribute (already-resolved
// literal value, picked by its key so two attributes that happen to
// resolve to the same text don't get confused with each other) or the
// "Custom text" escape hatch, which reveals a free-text field instead.
function onVariableValueSelect(index, selectedKey) {
  const row = modal.variableRows[index];
  if (selectedKey === CUSTOM_VALUE_SENTINEL) {
    row.customMode = true;
    row.selectedAttributeKey = "";
    row.value = "";
  } else {
    const option = modal.attributeOptions.find((o) => o.key === selectedKey);
    row.customMode = false;
    row.selectedAttributeKey = selectedKey;
    // The bare attribute value only (e.g. "$885.95", not "Price
    // $885.95") -- a label prefix made sense back when every row was a
    // meaningless positional token (v1/v2/...) that needed the words
    // spelled out for context, but it's what was overflowing/wrapping
    // inside the renderer's fixed-width box for the new dynamic fields
    // (e.g. "Price $54.99" wrapping in _htmlPriceCard's price line
    // instead of a single-line "$54.99"), and it's redundant either
    // way once the token itself (or its dropdown label in the value
    // picker) already says what the number is.
    row.value = option ? option.value : "";
  }
  modal.variablesTouched = true;
  renderVariableFields();
}

function addVariableRow() {
  if (modal.variableRows.length >= MAX_OVERLAY_VARIABLES) return;
  const usedKeys = modal.variableRows.map((r) => r.key);
  const nextDeclared = modal.dynamicVariableOptions.find((k) => !usedKeys.includes(k));
  const key = modal.dynamicVariableOptions.length
    ? (nextDeclared || modal.dynamicVariableOptions[0])
    : "v" + (modal.variableRows.length + 1);
  modal.variableRows.push({ key, value: "", customMode: true });
  modal.variablesTouched = true;
  renderVariableFields();
}

// Only the last row can be removed -- keeps removal unambiguous without
// needing to track row identity.
function removeLastVariableRow() {
  if (modal.variableRows.length <= 1) return;
  modal.variableRows.pop();
  renderVariableFields();
}

// Flipick has no API to say which overlay tokens a template declares
// or which convention it uses (positional v1/v2/... vs named
// $$Description$$/$$SalePrice$$/...), so the token name is pre-filled
// positionally (v1, v2, ...) but stays free text the user can
// overwrite (e.g. to "Description") for a named-token template. Its
// value is picked from this product's own attributes (Price, MRP, a
// Metafield, ...) via a dropdown -- e.g. mapping v1 to MRP -- rather
// than typed, with "Custom text" as the escape hatch for values that
// aren't a product attribute at all. Untouched, the whole section
// falls back to the Offers overlay (see commitCurrent).
// Top-level (not nested in renderModal) so a variable row change can
// re-render just this section via renderVariableFields() below,
// instead of tearing down and rebuilding the ENTIRE modal on every
// keystroke/selection here.
function valueSelectHtml(row, index) {
  if (modal.loadingAttributeOptions) {
    return '<select disabled><option>Loading product attributes…</option></select>';
  }
  const customOption = '<option value="' + CUSTOM_VALUE_SENTINEL + '"' + (row.customMode ? ' selected' : '') + '>Custom text…</option>';
  const attributeOptions = modal.attributeOptions.map((opt) =>
    '<option value="' + escapeHtml(opt.key) + '"' + (!row.customMode && row.selectedAttributeKey === opt.key ? ' selected' : '') +
      '>' + escapeHtml(opt.label) + ': ' + escapeHtml(opt.value) + '</option>'
  ).join("");
  const customInput = row.customMode
    ? ' <input type="text" placeholder="Value" value="' + escapeHtml(row.value) +
        '" oninput="onVariableValueChange(' + index + ', this.value)" />'
    : "";
  return '<select onchange="onVariableValueSelect(' + index + ', this.value)">' + customOption + attributeOptions + '</select>' + customInput;
}

// Key cell for one variable row -- a dropdown of the selected Overlay
// Family's declared real field names (e.g. price/label/strike) when
// any are known, since that name has to match exactly what the
// overlay's renderer reads; otherwise the original free-text input,
// unchanged, for families with no declared fields.
function keyFieldHtml(row, index) {
  if (!modal.dynamicVariableOptions.length) {
    return '<input type="text" placeholder="Token name (e.g. v1 or Description)" value="' + escapeHtml(row.key) +
      '" oninput="onVariableKeyChange(' + index + ', this.value)" />';
  }
  const options = modal.dynamicVariableOptions.map((key) =>
    '<option value="' + escapeHtml(key) + '"' + (key === row.key ? ' selected' : '') + '>' +
      escapeHtml(humanizeVariableName(key)) + '</option>'
  ).join("");
  return '<select onchange="onVariableKeyChange(' + index + ', this.value)">' + options + '</select>';
}

function variableFieldsHtml() {
  // No Overlay Family selected -- nothing for these values to apply to
  // (the video renders with no overlay at all, see the Overlay field's
  // own hint above), so showing empty Variable rows here is just
  // confusing clutter. Scoped to the fresh Generate/Regenerate flow
  // only (mode !== "update-overlay") -- Update Overlay's own entry
  // guard (openUpdateOverlayModal) already requires gen.overlayFamily
  // to be truthy, so a family IS genuinely attached there regardless
  // of this check; loadModalOverlayFamilies can still reset
  // modal.overlayFamily to "" afterward on a known wrong-shop-list
  // edge case, and hiding real, already-prefilled values in that state
  // would leave the merchant unable to see or edit their existing
  // overlay's content with no explanation why.
  if (modal.mode !== "update-overlay" && !modal.overlayFamily) return "";
  const rows = modal.variableRows.map((row, index) => {
    const removeBtn = (index === modal.variableRows.length - 1 && modal.variableRows.length > 1)
      ? ' <button type="button" class="btn-text" onclick="removeLastVariableRow()">Remove</button>'
      : "";
    return '<div class="field variable-row"><label>Variable ' + (index + 1) + '</label>' +
      keyFieldHtml(row, index) + ' ' +
      valueSelectHtml(row, index) + removeBtn + '</div>';
  }).join("");
  const addBtn = modal.variableRows.length < MAX_OVERLAY_VARIABLES
    ? '<button type="button" class="btn-text" onclick="addVariableRow()">+ Add variable</button>'
    : "";
  return rows + addBtn;
}

// Re-renders only the variable-rows section (wrapped in
// #variableFieldsRoot by singleTypeFieldsHtml/multiTypeFieldsHtml
// below) -- leaves the Prompt and everything else in the modal
// completely untouched.
function renderVariableFields() {
  const el = document.getElementById("variableFieldsRoot");
  if (el) el.innerHTML = variableFieldsHtml();
}

function canSubmit() {
  if (!modal.videoType) return false;
  return !modal.loadingDefault && !!modal.prompt.trim();
}

function submitLabel() {
  return generated[genKey(modal.tag, modal.videoType)] ? "Regenerate" : "Generate";
}

// The checkbox multi-select's own submit gate -- every checked type
// needs its own Prompt resolved (not just the shared Overlay Family), since
// each is sent as its own separate /api/generate call.
function canSubmitMulti() {
  if (!modal.videoTypes.length) return false;
  return modal.videoTypes.every((t) => !modal.loadingDefaultByType[t] && !!(modal.promptByType[t] || "").trim());
}

function currentTypeLabel() {
  const current = modal.queue[modal.queueIndex];
  return current ? FULL_TYPE_LABELS[current.videoType] : "";
}

function isImageTransitionCurrent() {
  const current = modal.queue[modal.queueIndex];
  return !!current && current.videoType === "image_transition";
}

// The queue/selections machinery below supports more than one item --
// the preview-picker step is identical either way, walking one type at
// a time regardless of how many are queued. This single-type path
// always builds a one-item queue; startGenerationMulti below (the
// checkbox path) is what actually uses more than one.
function startGeneration() {
  modal.queue = [{
    videoType: modal.videoType, prompt: modal.prompt.trim(), aspectRatio: modal.aspectRatio,
    overlayFamily: modal.overlayFamily || undefined,
    animation: modal.videoType === "image_transition" ? (modal.animation || undefined) : undefined,
  }];
  modal.queueIndex = 0;
  modal.selections = [];
  generatePreviewForCurrent();
}

// One queue item per checked type, sharing the same Size/Overlay Family
// and Variables (folded into overlay in commitCurrent) but each carrying
// its own Prompt -- walks the identical preview-picker flow one type at
// a time, same as the single-type path, but the FINAL kickoff (once
// every type's preview is resolved) fires all of them in parallel
// instead of one-at-a-time (see commitCurrent).
function startGenerationMulti() {
  modal.queue = modal.videoTypes.map((videoType) => ({
    videoType, prompt: (modal.promptByType[videoType] || "").trim(), aspectRatio: modal.aspectRatio,
    overlayFamily: modal.overlayFamily || undefined,
    animation: videoType === "image_transition" ? (modal.animation || undefined) : undefined,
  }));
  modal.queueIndex = 0;
  modal.selections = [];
  generatePreviewForCurrent();
}

async function generatePreviewForCurrent() {
  const current = modal.queue[modal.queueIndex];
  modal.step = "loading-preview";
  modal.previewError = null;
  renderModal();
  try {
    const res = await fetch(apiUrl("/api/preview-images"), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uniqueTag: modal.tag, videoType: current.videoType, prompt: current.prompt, aspectRatio: current.aspectRatio }),
    });
    const body = await res.json();
    if (!res.ok || body.error) throw new Error(body.error || "Could not generate preview images");
    modal.previewImages = body.images || [];
    // The server already persisted this as a 'candidates' version --
    // carried through commitCurrent -> modal.selections -> /api/generate
    // so that call advances this same version instead of allocating a
    // fresh one.
    current.versionId = body.versionId;
    modal.step = modal.previewImages.length ? "picking" : "preview-error";
    if (!modal.previewImages.length) modal.previewError = "No preview images came back.";
  } catch (err) {
    // Never show a raw backend error to the merchant -- e.g. the known
    // video-engine Postgres constraint bug ("Known external dependency
    // issue" in CLAUDE.md) surfaces here verbatim otherwise. The server
    // already logs the real message (logger.error in /api/preview-images);
    // this gets the same generic, non-leaking treatment as a failed
    // generation (see renderDetailTabBody's row-error text).
    console.error("Preview image generation failed:", err.message);
    modal.previewError = "Couldn't generate preview options. Try again, or contact support if this keeps happening.";
    modal.step = "preview-error";
  }
  renderModal();
}

function backToForm() { modal.step = "form"; renderModal(); }
function retryPreview() { generatePreviewForCurrent(); }

function selectImage(url) { commitCurrent({ startImageUrl: url }); }
function skipPreview() { commitCurrent({}); }
// Image Transitions has no per-tile pick / skip -- all 4 preview images
// are required (no text-to-video fallback for this render mode), so
// this is the only way to advance past its 'picking' step.
function confirmImageTransitionImages() { commitCurrent({ startImageUrls: modal.previewImages.map((img) => img.url) }); }

// Shared by commitCurrent (Generate/Regenerate) and submitUpdateOverlay
// -- turns a modal's variable rows into the two payloads the server
// needs: variableValues (the flat token->text map the renderer actually
// reads) and variableSelections (token->attribute-key, only for rows
// picked from the dropdown rather than typed as custom text). The
// latter is what lets a LATER "Update Overlay" open re-select the same
// product attribute (e.g. "Price") instead of falling back to "Custom
// text" with just the frozen old value -- see applyDynamicVariableFields.
function buildVariablePayload(rows, dynamicVariableOptions) {
  // Rows are dropped if their key was blanked out entirely, since an
  // empty key can't address a token; every remaining row is sent
  // regardless of value (see customOverlayValues in src/index.js) so an
  // intentionally-blank one clears the template's own placeholder text
  // instead of leaving it on screen.
  const namedRows = rows.filter((r) => r.key.trim() !== "");
  const variableValues = Object.fromEntries(namedRows.map((r) => [r.key.trim(), r.value]));
  const variableSelections = Object.fromEntries(
    namedRows.filter((r) => !r.customMode && r.selectedAttributeKey).map((r) => [r.key.trim(), r.selectedAttributeKey])
  );
  // A dynamic family's declared field the merchant never added a row for
  // (e.g. left "strike" out because this product has no MRP) must still
  // reach the backend as an explicit blank, not be left out of the
  // payload entirely -- LTX's own $$token$$ substitution (vvp-shot-
  // renderer.js) only blanks a field it was TOLD about (even as ""); a
  // key it never received at all is deliberately left as a visible
  // "$$strike$$" placeholder (its own "needs data" signal for the VVP
  // batch-tooling case that convention exists for). Unioning in every
  // declared field here keeps that placeholder from leaking into a real
  // generated video just because the merchant didn't add every row.
  for (const key of dynamicVariableOptions) {
    if (!(key in variableValues)) variableValues[key] = "";
  }
  return { namedRows, variableValues, variableSelections };
}

function commitCurrent(input) {
  const current = modal.queue[modal.queueIndex];
  modal.selections.push({ ...current, startImageUrl: input.startImageUrl, startImageUrls: input.startImageUrls });
  modal.queueIndex++;
  if (modal.queueIndex < modal.queue.length) {
    generatePreviewForCurrent();
    return;
  }
  // Every checked type has now been resolved (picked, skipped, or
  // confirmed) -- close the modal and hand the full selection list off
  // to the parallel generate+poll runner (every type kicked off at
  // once, not one waiting on the previous to finish or fail first).
  const tag = modal.tag, selections = modal.selections;
  // Which overlay style applies is decided by whether the user actually
  // interacted with the variable rows at all -- captured here since
  // closeModal() below wipes the modal. Every row always has a
  // (pre-filled, positional) key now, so an empty-key check can't tell
  // "untouched" apart from "in use" -- variablesTouched is what does.
  const { namedRows, variableValues, variableSelections } = buildVariablePayload(modal.variableRows, modal.dynamicVariableOptions);
  // Dynamic mode (a declared field dropdown, not free-text keys) always
  // sends custom -- these rows are the real field names the overlay's
  // renderer reads, so they need to reach it regardless of
  // variablesTouched (the merchant didn't rename anything; there's
  // nothing to "touch" to opt in).
  const overlay = (modal.dynamicVariableOptions.length || (modal.variablesTouched && namedRows.length))
    ? { overlayStyle: "custom", variableValues, variableSelections }
    : { overlayStyle: "offers" };
  closeModal();
  runSelectionsInParallel(tag, selections, overlay);
}

// Fires every selection's /api/generate call at once -- each type polls
// independently (startPolling's timers are already keyed per videoType,
// so concurrent polling was always safe), so nothing here waits on
// another selection to finish or fail before starting.
function runSelectionsInParallel(tag, selections, overlay) {
  selections.forEach((next) => startOneGeneration(tag, next, overlay));
}

function startOneGeneration(tag, next, overlay) {
  const key = genKey(tag, next.videoType);
  generated[key] = { status: "generating", videoType: next.videoType, aspectRatio: next.aspectRatio };
  renderAfterStateChange();
  fetch(apiUrl("/api/generate"), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      uniqueTag: tag, videoType: next.videoType, prompt: next.prompt, aspectRatio: next.aspectRatio,
      startImageUrl: next.startImageUrl, startImageUrls: next.startImageUrls,
      // Overlay Family left at "(none)" -- /api/generate derives
      // noOverlay from this itself (never trusted as a separate field),
      // rendering with no overlay at all instead of silently falling
      // back to the tenant's default template.
      overlayFamily: next.overlayFamily,
      animation: next.animation,
      overlayStyle: overlay.overlayStyle, variableValues: overlay.variableValues,
      variableSelections: overlay.variableSelections,
      versionId: next.versionId,
    }),
  })
    .then((res) => res.json().catch(() => ({})).then((body) => {
      // Billing gate -- not a per-slot failure, applies to the whole
      // shop. Revert the optimistic "generating" placeholder and open
      // the Plan modal instead of marking this slot errored; don't
      // continue the queue, since the rest would just hit the same wall.
      if (res.status === 402 && GATE_MESSAGES[body.error]) {
        delete generated[key];
        renderAfterStateChange();
        openPlanModal(body.error);
        return;
      }
      if (!res.ok || body.error) throw new Error(body.error || "Failed to start generation");
      // Only start polling once the server has actually acknowledged and
      // recorded "generating" -- starting it earlier meant a failed/dropped
      // request here left the UI showing "Generating..." forever, since
      // every poll would just see the server's real state (never set) and
      // silently keep waiting.
      startPolling(tag, next.videoType, null);
    }))
    .catch((err) => {
      generated[key] = { status: "error", videoType: next.videoType, aspectRatio: next.aspectRatio, error: err.message };
      renderAfterStateChange();
    });
}

// Submits the "Update Overlay" modal (openUpdateOverlayModal) -- POSTs
// to /api/update-overlay instead of /api/generate: no queue/selections,
// no preview-image step, and the server reuses this slot's own stored
// aspectRatio/overlayFamily/projectId rather than anything read from
// modal state beyond the variable values themselves.
function submitUpdateOverlay() {
  const { variableValues, variableSelections } = buildVariablePayload(modal.variableRows, modal.dynamicVariableOptions);
  const tag = modal.tag, videoType = modal.videoType;
  closeModal();
  const key = genKey(tag, videoType);
  generated[key] = { ...generated[key], status: "generating" };
  renderAfterStateChange();
  fetch(apiUrl("/api/update-overlay"), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uniqueTag: tag, videoType, variableValues, variableSelections }),
  })
    .then((res) => res.json().catch(() => ({})).then((body) => {
      if (!res.ok || body.error) throw new Error(body.error || "Failed to update overlay");
      startPolling(tag, videoType, null);
    }))
    .catch((err) => {
      generated[key] = { ...generated[key], status: "error", error: err.message };
      renderAfterStateChange();
    });
}

function closeModal() {
  if (modal && modal.overlayPreviewUrl) URL.revokeObjectURL(modal.overlayPreviewUrl);
  modal = null;
  document.getElementById("modalRoot").innerHTML = "";
}

// The form step's own "Cancel" button -- distinct from closeModal()
// itself, which is also used on successful submit (where staying on the
// detail page to watch the render is correct). Only when this modal was
// auto-opened from the list's "Generate video" action AND nothing ended
// up generated does canceling return to the list.
function cancelModal() {
  const wasQuickGenerate = modal && modal.quickGenerate;
  const tag = modal && modal.tag;
  closeModal();
  if (wasQuickGenerate && tag && VIDEO_TYPES.every((t) => !generated[genKey(tag, t)])) {
    navigate({ mode: "list" });
  }
}

function renderModal() {
  const root = document.getElementById("modalRoot");
  if (!modal) { root.innerHTML = ""; return; }

  // Matches LTX's own project-wizard "Video size" picker (4 ratios,
  // same set its backend already validates against -- videoEngineClient.js's
  // listOverlayFamilies/getOverlayFamilyPreview and LTX's own
  // /overlay-families route all accept exactly these 4) -- this dropdown
  // previously stopped at 3, silently hiding 5:4 and any 5:4-only
  // overlay family from merchants.
  function sizeSelect() {
    return '<select onchange="onAspectRatioChange(this.value)">' +
      '<option value="16:9"' + (modal.aspectRatio === "16:9" ? ' selected' : '') + '>16:9 (landscape)</option>' +
      '<option value="9:16"' + (modal.aspectRatio === "9:16" ? ' selected' : '') + '>9:16 (portrait)</option>' +
      '<option value="1:1"' + (modal.aspectRatio === "1:1" ? ' selected' : '') + '>1:1 (square)</option>' +
      '<option value="5:4"' + (modal.aspectRatio === "5:4" ? ' selected' : '') + '>5:4 (near-square)</option>' +
    '</select>';
  }

  // Sorted alphabetically -- src/index.js's listOverlayFamilies already
  // excludes System families entirely and dedupes the rest by name, so
  // there's no System/Brand pair left to keep grouped by source.
  function overlayFamilySelect() {
    const sorted = [...modal.overlayFamilies].sort((a, b) => a.name.localeCompare(b.name));
    const options = '<option value="">(none)</option>' + sorted.map((f) =>
      '<option value="' + escapeHtml(f.name) + '"' + (modal.overlayFamily === f.name ? ' selected' : '') + '>' +
        escapeHtml(f.name) + (f.isSystem ? ' (System)' : '') + '</option>'
    ).join("");
    return '<select ' + (modal.loadingOverlayFamilies ? 'disabled' : '') +
      ' onchange="onOverlayFamilyChange(this.value)">' + options + '</select>';
  }

  // Mirrors the old Template picker's templatePreviewHtml() -- a live
  // render of the currently chosen family, right below the dropdown.
  function overlayPreviewHtml() {
    if (modal.loadingOverlayPreview) return '<div class="field-hint">Loading preview…</div>';
    if (!modal.overlayPreviewUrl) return "";
    return '<img src="' + modal.overlayPreviewUrl + '" style="max-width:100%;border-radius:8px;border:1px solid #d3d1c7;margin-top:8px;display:block;" />';
  }

  const EFFECT_OPTIONS = [
    ["", "Default"], ["ken_burns", "Ken Burns"], ["pan", "Pan"], ["fade", "Fade"], ["crossfade_only", "Crossfade"],
  ];
  function effectSelect() {
    const options = EFFECT_OPTIONS.map(([value, label]) =>
      '<option value="' + value + '"' + (modal.animation === value ? ' selected' : '') + '>' + label + '</option>'
    ).join("");
    return '<select onchange="onFieldChange(\'animation\', this.value)">' + options + '</select>';
  }

  const TYPE_HINTS = {
    hero_product: "Uses this product's own photo as a locked reference image — always renders fresh, no reuse.",
    lifestyle: "Overrides the category's default theme for this video only — also uses this product's photo, when it has one.",
    image_transition: "A single 8s clip assembled from 4 stills of this product (no AI video call) — next you'll see and confirm all 4 before generating.",
  };

  // The checkbox multi-select's own type picker (radio was single-select
  // only) -- shown with each type's own description right there, since
  // this is the ONLY place a merchant sees all three side by side before
  // committing to any of them.
  function videoTypesChecklist() {
    return '<div class="field"><label>Video Type</label>' +
      VIDEO_TYPES.map((t) =>
        '<label class="video-type-option" style="display:block;font-weight:normal;margin-bottom:10px;">' +
          '<input type="checkbox" ' + (modal.videoTypes.includes(t) ? 'checked' : '') + ' onchange="onVideoTypeToggle(\'' + t + '\')" /> ' +
          '<strong>' + FULL_TYPE_LABELS[t] + '</strong>' +
          '<div class="field-hint" style="margin-left:22px;">' + TYPE_HINTS[t] + '</div>' +
        '</label>'
      ).join("") +
    '</div>';
  }

  function singleTypeFieldsHtml() {
    const label = FULL_TYPE_LABELS[modal.videoType];
    // Effect (transition animation) only applies to Image Transitions --
    // Hero Product/Lifestyle have no discrete multi-still transition concept.
    const effectField = modal.videoType === "image_transition"
      ? '<div class="field"><label>Effect</label>' + effectSelect() +
          '<div class="field-hint">Leave as "Default" for a standard Ken Burns effect</div></div>'
      : "";
    return '<div class="field"><label>Aspect Ratio</label>' + sizeSelect() + '</div>' +
      '<div class="field"><label>Overlay</label>' + overlayFamilySelect() +
        '<div class="field-hint">' + (modal.loadingOverlayFamilies ? "Loading overlay styles for this size…" : "Filtered to overlay families matching the Aspect Ratio above. If left blank, the video has no overlay") + '</div>' +
        overlayPreviewHtml() +
      '</div>' +
      effectField +
      '<div id="variableFieldsRoot">' + variableFieldsHtml() + '</div>' +
      '<div class="field"><label>' + label + ' Prompt</label><textarea rows="3" ' + (modal.loadingDefault ? 'disabled' : '') +
        ' oninput="onFieldChange(\'prompt\', this.value)" placeholder="Describe the scene/creative direction">' + escapeHtml(modal.prompt) + '</textarea>' +
        '<div class="field-hint">' + (modal.loadingDefault ? "Loading default…" : TYPE_HINTS[modal.videoType]) + '</div></div>' +
      '<p class="muted">Fixed at 8 seconds. Next: pick a starting frame from 4 options' + (modal.videoType === "image_transition" ? " (all 4 are used)" : "") + '.</p>';
  }

  // The checkbox multi-select's shared Size/Overlay/Variables (one
  // configuration reused across every checked type -- see
  // startGenerationMulti) plus one Prompt field per checked type, since
  // each still renders from its own creative direction even though the
  // Overlay Family is shared.
  function multiTypeFieldsHtml() {
    if (!modal.videoTypes.length) return "";
    const effectField = modal.videoTypes.includes("image_transition")
      ? '<div class="field"><label>Effect</label>' + effectSelect() +
          '<div class="field-hint">Leave as "Default" for a standard Ken Burns effect — applies to the Image Transitions video only</div></div>'
      : "";
    const promptFields = VIDEO_TYPES.filter((t) => modal.videoTypes.includes(t)).map((t) => {
      const loading = modal.loadingDefaultByType[t];
      return '<div class="field"><label>' + FULL_TYPE_LABELS[t] + ' Prompt</label><textarea rows="3" ' + (loading ? 'disabled' : '') +
        ' oninput="onPromptByTypeChange(\'' + t + '\', this.value)" placeholder="Describe the scene/creative direction">' + escapeHtml(modal.promptByType[t] || "") + '</textarea>' +
        '<div class="field-hint">' + (loading ? "Loading default…" : TYPE_HINTS[t]) + '</div></div>';
    }).join("");
    return '<div class="field"><label>Aspect Ratio</label>' + sizeSelect() + '</div>' +
      '<div class="field"><label>Overlay</label>' + overlayFamilySelect() +
        '<div class="field-hint">' + (modal.loadingOverlayFamilies ? "Loading overlay styles for this size…" : "Filtered to overlay families matching the Aspect Ratio above — applied to every selected video type. If left blank, the video has no overlay") + '</div>' +
        overlayPreviewHtml() +
      '</div>' +
      effectField +
      '<div id="variableFieldsRoot">' + variableFieldsHtml() + '</div>' +
      promptFields +
      '<p class="muted">Fixed at 8 seconds each. Next: pick a starting frame from 4 options, one type at a time' + (modal.videoTypes.includes("image_transition") ? " (Image Transitions uses all 4)" : "") + '.</p>';
  }

  let body = "";
  if (modal.step === "update-overlay-form") {
    // No Size/Prompt/starting-frame/Overlay-Family picker here -- this
    // only changes overlay field values on the existing render (see
    // openUpdateOverlayModal/POST /api/update-overlay); switching
    // families isn't part of this feature's scope, so the name is shown
    // read-only (confirms which family's fields are being edited --
    // useful since a product's different video types can each carry a
    // different one) rather than as a picker.
    //
    // Fields render only once loadModalOverlayFamilies() has resolved --
    // rendering the eventual real field count immediately instead of a
    // single placeholder row first avoids the modal visibly growing/
    // resizing a beat after it opens. The preview (same live render as
    // the Generate modal's own Overlay field) sits right below the
    // family name so the merchant can see exactly where each Variable
    // row lands on screen before editing it.
    body = '<div class="modal-header">Update Overlay</div><div class="modal-body">' +
      '<p class="muted">Overlay: ' + escapeHtml(modal.overlayFamily) + '</p>' +
      overlayPreviewHtml() +
      (modal.loadingOverlayFamilies
        ? '<div class="loading-block"><div class="spinner"></div></div>'
        : '<div id="variableFieldsRoot">' + variableFieldsHtml() + '</div>') +
    '</div><div class="modal-actions">' +
      '<button class="btn-text" onclick="cancelModal()">Cancel</button>' +
      '<button class="btn-primary" ' + (modal.loadingOverlayFamilies ? 'disabled' : '') + ' onclick="submitUpdateOverlay()">Update Overlay</button>' +
    '</div>';
  } else if (modal.step === "form") {
    if (modal.videoType) {
      // The single, preselected-type path -- per-slot Regenerate/
      // Generate buttons on the detail page, always exactly one
      // already-known type. Unchanged from before the checkbox
      // multi-select existed.
      body = '<div class="modal-header">Generate ' + FULL_TYPE_LABELS[modal.videoType] + ' video</div><div class="modal-body">' +
        singleTypeFieldsHtml() +
      '</div><div class="modal-actions">' +
        '<button class="btn-text" onclick="cancelModal()">Cancel</button>' +
        '<button class="btn-primary" ' + (canSubmit() ? '' : 'disabled') + ' onclick="startGeneration()">' + submitLabel() + '</button>' +
      '</div>';
    } else {
      // The checkbox multi-select path -- list-row quick-generate and
      // "Generate another video", where the type isn't known yet.
      const count = modal.videoTypes.length;
      const topAction = count > 1
        ? '<div class="modal-top-action"><button class="btn-primary" ' + (canSubmitMulti() ? '' : 'disabled') + ' onclick="startGenerationMulti()">Generate ' + count + ' Videos</button></div>'
        : "";
      body = '<div class="modal-header">Generate video' + (count > 1 ? 's' : '') + '</div><div class="modal-body">' +
        topAction +
        videoTypesChecklist() +
        multiTypeFieldsHtml() +
      '</div><div class="modal-actions">' +
        '<button class="btn-text" onclick="cancelModal()">Cancel</button>' +
        (count === 1 ? '<button class="btn-primary" ' + (canSubmitMulti() ? '' : 'disabled') + ' onclick="startGenerationMulti()">Generate Video</button>' : '') +
      '</div>';
    }
  } else if (modal.step === "loading-preview") {
    // Image Transitions has no text-to-video fallback -- skipping the
    // preview would leave nothing to render, so this escape hatch only
    // applies to Hero Product/Lifestyle.
    const skipBtn = isImageTransitionCurrent() ? "" : '<button class="btn-text" onclick="skipPreview()">Skip preview, generate anyway</button>';
    body = '<div class="modal-header">Generating ' + currentTypeLabel() + ' preview options…</div><div class="modal-body"><div class="loading-block"><div class="spinner"></div><p class="muted">This takes about 10-20 seconds.</p></div></div>' +
      '<div class="modal-actions">' + skipBtn + '</div>';
  } else if (modal.step === "picking" && isImageTransitionCurrent()) {
    // stillCount reflects modal.previewImages.length, NOT a hardcoded 4 --
    // the video-engine backend's /preview-images endpoint (external,
    // Flipick-owned) doesn't always return exactly 4 stills despite the
    // doc comment on generatePreviewImages() describing a 4-image
    // response; this modal has to accurately describe whatever count
    // actually came back rather than claim "4" and show fewer.
    const stillCount = modal.previewImages.length;
    body = '<div class="modal-header">Confirm the ' + stillCount + ' Image Transitions still' + (stillCount === 1 ? '' : 's') + '</div><div class="modal-body">' +
      '<p class="muted">All ' + stillCount + ' image' + (stillCount === 1 ? '' : 's') + ' below will be used, animating between them (Ken Burns/pan/crossfade) in this order to make the final 8s clip — there\'s no pick-one or skip for this type.</p>' +
      '<div class="preview-grid">' + modal.previewImages.map((img) =>
        '<div class="preview-tile static"><img src="' + escapeHtml(img.url) + '" alt="Image Transitions still" /></div>'
      ).join("") + '</div></div>' +
      '<div class="modal-actions"><button class="btn-text" onclick="backToForm()">Back</button><button class="btn-text" onclick="retryPreview()">Regenerate these ' + stillCount + '</button><button class="btn-primary" onclick="confirmImageTransitionImages()">Use these ' + stillCount + ' image' + (stillCount === 1 ? '' : 's') + '</button></div>';
  } else if (modal.step === "picking") {
    body = '<div class="modal-header">Pick a ' + currentTypeLabel() + ' starting frame</div><div class="modal-body">' +
      '<p class="muted">The ' + currentTypeLabel() + ' video will be generated starting from whichever frame you pick.</p>' +
      '<div class="preview-grid">' + modal.previewImages.map((img) =>
        '<button type="button" class="preview-tile" data-preview-url="' + escapeHtml(img.url) + '"><img src="' + escapeHtml(img.url) + '" alt="Candidate starting frame" /></button>'
      ).join("") + '</div></div>' +
      '<div class="modal-actions"><button class="btn-text" onclick="backToForm()">Back</button><button class="btn-text" onclick="skipPreview()">None of these, skip</button></div>';
  } else if (modal.step === "preview-error") {
    // Image Transitions has no blind/skip fallback -- a failed preview
    // leaves nothing to generate from for this type.
    const skipBtn = isImageTransitionCurrent() ? "" : '<button class="btn-primary" onclick="skipPreview()">Generate anyway</button>';
    body = '<div class="modal-header">Couldn\'t generate ' + currentTypeLabel() + ' preview options</div><div class="modal-body"><p class="muted">' + escapeHtml(modal.previewError) + '</p></div>' +
      '<div class="modal-actions"><button class="btn-text" onclick="backToForm()">Back</button><button class="btn-text" onclick="retryPreview()">Try again</button>' + skipBtn + '</div>';
  }

  // Every field change (typing a Prompt, picking an Overlay Family, toggling a
  // variable row, ...) calls this via oninput/onchange, which replaces
  // the whole .modal element -- a brand new DOM node always starts at
  // scrollTop 0, so without this the modal visibly jumps to the top on
  // every keystroke once its content is tall enough to scroll. Carry
  // the previous scroll position over onto the new element instead.
  const prevScrollTop = root.querySelector(".modal")?.scrollTop || 0;
  root.innerHTML = '<div class="modal-backdrop"><div class="modal">' + body + '</div></div>';
  const newModalEl = root.querySelector(".modal");
  if (newModalEl) newModalEl.scrollTop = prevScrollTop;
}
document.getElementById("modalRoot").addEventListener("click", (e) => {
  const el = e.target.closest("[data-preview-url]");
  if (el) selectImage(el.dataset.previewUrl);
});

renderToolbar();
renderAfterStateChange();
renderUsageBadge();
Object.keys(generated).forEach((key) => {
  if (generated[key].status !== "generating") return;
  const sep = key.lastIndexOf("::");
  startPolling(key.slice(0, sep), generated[key].videoType);
});
// Keeps "Synced N ago"/"Updated" relative times from going stale on a
// long-open tab -- only while list mode's #rows actually exists.
setInterval(() => { if (view.mode === "list") renderRows(); }, 60000);

// Deep link used by the Magento admin: /?product=<uniqueTag> opens that product's detail page. embed=1 only tightens the
// page padding for the frame; the "Back to products" link stays.
{
  const params = new URLSearchParams(location.search);
  if (params.get("embed") === "1") document.body.classList.add("embed");
  const deepLinkTag = params.get("product");
  if (deepLinkTag) navigate({ mode: "detail", tag: deepLinkTag });
}

