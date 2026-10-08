// Plans & Billing UI: usage badge, plan gate, Plans & Billing modal (plans, credits, history) and the payment flow.
// Ported from the Shopify adapter's inline billing code; payments now go through the adapter's gateway (ICICI, or the mock
// gateway in development) in a separate browser tab, and the modal polls the order until it settles.
// Loaded before app.js; it uses app.js helpers (escapeHtml, apiUrl) only when called, after app.js has loaded.

let billing = window.__BOOTSTRAP__.billing;
let planModal = null; // { reason, tab, busy, error, notice, cycle, currency, orderId, history, historyLoading }

const GATE_MESSAGES = {
  trial_exhausted: "You've used all your free videos. Choose a plan or add credit to keep generating.",
  subscription_inactive: "Your plan has ended. Renew it to keep generating videos.",
  usage_cap_reached: "You've used this period's video budget. Add credit, or renew to start a new period.",
};

const RENEW_WINDOW_DAYS = 5;

function fmtMoney(minor, currency) {
  const major = minor / 100;
  if (currency === "INR") return "₹" + major.toLocaleString("en-IN", { minimumFractionDigits: major % 1 ? 2 : 0, maximumFractionDigits: 2 });
  return "$" + major.toFixed(2);
}
const usd = (cents) => "$" + (cents / 100).toFixed(2);
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "");

function daysLeft() {
  if (!billing.periodEnd) return null;
  return Math.ceil((new Date(billing.periodEnd).getTime() - Date.now()) / 86400000);
}

// Mirrors the server's /api/generate gate (same three reasons). The server remains the actual enforcement; this only
// decides whether to open the Plans modal before the Generate modal.
function isBillingBlocked() {
  if (billing.currentPlan === "trial") return billing.freeVideosUsed >= billing.freeTrialVideos && billing.usageCapReached ? "trial_exhausted" : null;
  if (billing.subscriptionStatus !== "active" && billing.subscriptionStatus !== "grace") return "subscription_inactive";
  if (billing.usageCapReached) return "usage_cap_reached";
  return null;
}

function billingBadgeInfo() {
  const credit = billing.creditCents > 0 ? " · " + usd(billing.creditCents) + " credit" : "";
  if (billing.currentPlan === "trial") {
    const used = billing.freeVideosUsed, total = billing.freeTrialVideos;
    if (used >= total) return isBillingBlocked() ? { text: "Free trial used up", variant: "blocked" } : { text: "Using credit" + credit, variant: "" };
    return { text: used + " / " + total + " free videos" + credit, variant: used >= total - 1 ? "warn" : "" };
  }
  if (billing.subscriptionStatus === "expired" || billing.subscriptionStatus === "canceled") return { text: "Plan ended", variant: "blocked" };
  if (billing.subscriptionStatus === "grace") return { text: "Plan ended — renew now", variant: "warn" };
  if (billing.usageCapReached) return { text: "Budget used up" + credit, variant: "blocked" };
  const left = daysLeft();
  const ends = left != null && left <= RENEW_WINDOW_DAYS ? " · ends in " + Math.max(left, 0) + " day" + (left === 1 ? "" : "s") : "";
  const text = usd(billing.cycleValueUsedCents) + " / " + usd(billing.includedValueCents) + " used this period" + credit + ends;
  return { text, variant: ends || billing.cycleValueUsedCents >= billing.includedValueCents ? "warn" : "" };
}

function planCtaLabel() {
  const reason = isBillingBlocked();
  if (reason === "trial_exhausted") return "Upgrade Plan";
  if (reason || billing.subscriptionStatus === "grace") return "Renew Plan";
  return "View Plans";
}

function renderUsageBadge() {
  const el = document.getElementById("usageBadge");
  if (!el) return; // the detail page has no top-bar badge
  const info = billingBadgeInfo();
  el.className = "usage-badge" + (info.variant ? " " + info.variant : "");
  el.textContent = info.text;
  const cta = document.getElementById("planCta");
  if (cta) cta.textContent = planCtaLabel();
}

async function refreshBilling() {
  try {
    const res = await fetch(apiUrl("/api/billing/status"));
    if (res.ok) billing = await res.json();
  } catch (e) {
    // transient: the next poll tick or modal open retries
  }
  renderUsageBadge();
  if (planModal) renderPlanModal();
}

function openPlanModal(reason) {
  planModal = {
    reason, tab: reason === "trial_exhausted" || reason === "usage_cap_reached" ? "plans" : "plans", busy: false, error: null, notice: null,
    cycle: billing.billingInterval || "monthly", currency: billing.currency || billing.defaultCurrency || "USD",
    orderId: null, history: null, historyLoading: false,
  };
  renderPlanModal();
  refreshBilling();
}

function closePlanModal() {
  planModal = null;
  document.getElementById("planModalRoot").innerHTML = "";
}

function setPlanCycle(cycle) { if (planModal) { planModal.cycle = cycle; renderPlanModal(); } }
function setPlanCurrency(currency) { if (planModal) { planModal.currency = currency; renderPlanModal(); } }
function setPlanTab(tab) {
  if (!planModal) return;
  planModal.tab = tab;
  if (tab === "history") loadHistory();
  renderPlanModal();
}

async function loadHistory() {
  planModal.historyLoading = true;
  try {
    const res = await fetch(apiUrl("/api/billing/history"));
    if (res.ok) planModal.history = (await res.json()).orders;
  } catch (e) { /* shown as empty */ }
  if (planModal) { planModal.historyLoading = false; renderPlanModal(); }
}

// ---------- Payment flow ----------

// Opens the gateway in a new tab (opened synchronously inside the click so pop-up blockers allow it), then follows the
// order until it settles. The page stays usable meanwhile.
async function startCheckout(payload) {
  if (!planModal || planModal.busy) return;
  const tab = window.open("", "_blank");
  if (tab) tab.document.write("<p style=\"font-family:system-ui;padding:24px\">Opening the payment page…</p>");
  planModal.busy = true;
  planModal.error = null;
  planModal.notice = null;
  renderPlanModal();
  try {
    const res = await fetch(apiUrl("/api/billing/checkout"), {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random() },
      body: JSON.stringify(payload),
    });
    const body = await res.json();
    if (!res.ok || !body.redirectUrl) throw new Error(body.error || "Could not start the payment");
    planModal.orderId = body.orderId;
    planModal.payLink = body.redirectUrl;
    if (tab) tab.location.href = body.redirectUrl;
    planModal.notice = tab
      ? "Complete the payment in the new tab. This window updates by itself when it is confirmed."
      : "Your browser blocked the payment tab. Use the link below to pay.";
    planModal.busy = false;
    renderPlanModal();
    pollOrder(body.orderId);
  } catch (err) {
    if (tab) tab.close();
    planModal.busy = false;
    planModal.error = err.message;
    renderPlanModal();
  }
}

function choosePlan(tier, cycleOverride) {
  startCheckout({ kind: "plan", tier, cycle: cycleOverride || planModal.cycle, currency: planModal.currency });
}

function buyCredit(packUsdCents) {
  startCheckout({ kind: "topup", packUsdCents, currency: planModal.currency });
}

async function pollOrder(orderId) {
  for (let i = 0; i < 300; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    if (!planModal || planModal.orderId !== orderId) return; // modal closed or a newer payment started
    try {
      const res = await fetch(apiUrl("/api/billing/orders/" + encodeURIComponent(orderId)));
      if (!res.ok) continue;
      const order = await res.json();
      if (order.status === "pending" || order.status === "created") continue;
      planModal.orderId = null;
      planModal.payLink = null;
      if (order.status === "paid") planModal.notice = order.kind === "plan" ? "Payment received. Your plan is active." : "Payment received. Credit added.";
      else { planModal.notice = null; planModal.error = "The payment did not go through" + (order.failureReason ? ": " + order.failureReason : "") + ". You have not been charged."; }
      await refreshBilling();
      if (planModal && planModal.tab === "history") loadHistory();
      return;
    } catch (e) { /* keep polling */ }
  }
}

async function cancelPlan() {
  if (!planModal) return;
  const label = billing.plans[billing.currentPlan] ? billing.plans[billing.currentPlan].label : "current";
  if (!window.confirm("Cancel your " + label + " plan and switch to the free trial? This takes effect immediately.")) return;
  planModal.busy = true;
  planModal.error = null;
  renderPlanModal();
  try {
    const res = await fetch(apiUrl("/api/billing/cancel"), { method: "POST", headers: { "Content-Type": "application/json" } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || "Could not cancel the plan");
    planModal.busy = false;
    billing = body;
    renderUsageBadge();
    renderPlanModal();
  } catch (err) {
    planModal.busy = false;
    planModal.error = err.message;
    renderPlanModal();
  }
}

async function openInvoice(invoiceId) {
  try {
    const res = await fetch(apiUrl("/api/billing/invoices/" + invoiceId + "/link"));
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "Could not open the invoice");
    window.open(body.url, "_blank");
  } catch (err) {
    planModal.error = err.message;
    renderPlanModal();
  }
}

// ---------- Rendering ----------

function priceFor(tier, cycle) {
  const plan = billing.plans[tier];
  return plan.prices && plan.prices[cycle] ? plan.prices[cycle][planModal.currency] : null;
}

function planCardHtml(tier) {
  const plan = billing.plans[tier];
  const cycle = tier === "trial" ? "monthly" : planModal.cycle;
  const days = daysLeft();
  const sameTier = billing.currentPlan === tier && (tier === "trial" || (billing.billingInterval === cycle && (billing.subscriptionStatus === "active" || billing.subscriptionStatus === "grace")));
  const renewable = sameTier && tier !== "trial" && (billing.subscriptionStatus === "grace" || billing.usageCapReached || (days != null && days <= RENEW_WINDOW_DAYS));
  let priceHtml, meta;
  if (tier === "trial") {
    priceHtml = '<div class="plan-price">' + fmtMoney(0, planModal.currency) + '</div>';
    meta = plan.freeVideos + " videos, no time limit";
  } else {
    const price = priceFor(tier, cycle);
    if (!price) return "";
    const rates = plan.videoPriceCents;
    const rateText = rates.hero_product === rates.lifestyle
      ? "Image Transition " + usd(rates.image_transition) + " · Cinematic AI (Hero & Lifestyle) " + usd(rates.hero_product)
      : "Image Transition " + usd(rates.image_transition) + " · Hero Product " + usd(rates.hero_product) + " · Lifestyle " + usd(rates.lifestyle);
    const includedVideos = Math.floor(price.budgetUsdCents / rates.image_transition);
    const monthly = priceFor(tier, "monthly");
    if (cycle === "annual" && monthly) {
      const regular = monthly.amountMinor * 12;
      priceHtml = '<div class="plan-price-row"><span class="plan-price">' + fmtMoney(price.amountMinor, planModal.currency) + '<small>/yr</small></span>' +
        '<span class="plan-price-strike">' + fmtMoney(regular, planModal.currency) + '</span>' +
        '<span class="plan-save-badge">Save ' + fmtMoney(regular - price.amountMinor, planModal.currency) + '/yr</span></div>';
    } else {
      priceHtml = '<div class="plan-price">' + fmtMoney(price.amountMinor, planModal.currency) + '<small>/mo</small></div>';
    }
    meta = "Up to " + includedVideos + " videos included per " + (cycle === "annual" ? "year" : "month") + " · after that, add credit (" + rateText + " per video)";
    if (billing.gstApplies && planModal.currency === "INR") meta += " · plus " + (billing.gstRateBp / 100) + "% GST";
  }
  let action;
  if (renewable) {
    action = '<button class="btn-primary" ' + (planModal.busy ? "disabled" : "") + " onclick=\"choosePlan('" + tier + "', '" + cycle + "')\">Renew now</button>";
  } else if (sameTier) {
    action = '<div class="plan-current-label">' + (tier === "trial" ? "Current plan" : "Current plan · renews by " + fmtDate(billing.periodEnd)) + '</div>';
  } else if (tier === "trial") {
    action = "";
  } else {
    action = '<button class="btn-primary" ' + (planModal.busy ? "disabled" : "") + " onclick=\"choosePlan('" + tier + "')\">Choose plan</button>";
  }
  return '<div class="plan-card' + (sameTier ? " current" : "") + '"><h4>' + escapeHtml(plan.label) + '</h4>' + priceHtml + '<div class="plan-meta">' + meta + '</div>' + action + '</div>';
}

function plansTabHtml() {
  const cur = planModal.currency;
  return '<div class="plan-top-row">' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
        '<div class="cycle-toggle">' +
          '<button type="button" class="' + (planModal.cycle === "monthly" ? "active" : "") + '" onclick="setPlanCycle(\'monthly\')">Monthly</button>' +
          '<button type="button" class="' + (planModal.cycle === "annual" ? "active" : "") + '" onclick="setPlanCycle(\'annual\')">Annual (2 months free)</button>' +
        '</div>' +
        '<div class="cycle-toggle">' +
          '<button type="button" class="' + (cur === "USD" ? "active" : "") + '" onclick="setPlanCurrency(\'USD\')">USD</button>' +
          '<button type="button" class="' + (cur === "INR" ? "active" : "") + '" onclick="setPlanCurrency(\'INR\')">INR</button>' +
        '</div>' +
      '</div>' +
      (billing.currentPlan !== "trial"
        ? '<button type="button" class="cancel-plan-btn" ' + (planModal.busy ? "disabled" : "") + ' onclick="cancelPlan()">Cancel Plan</button>' : "") +
    '</div>' +
    '<div class="plan-grid">' + planCardHtml("trial") + planCardHtml("starter") + planCardHtml("pro") + '</div>' +
    '<p class="muted" style="font-size:12px;margin:10px 0 0">Plans are paid for one period at a time. When a period ends, renew from here. ' +
      (cur === "USD" ? "Paying in USD needs an international card." : "") + '</p>';
}

function creditTabHtml() {
  const cur = planModal.currency;
  const packs = (billing.topupPacksUsd || []).map(function (cents) {
    const price = cur === "USD" ? cents : cents * (billing.inrPerUsd || 83);
    return '<div class="plan-card"><h4>' + usd(cents) + ' credit</h4><div class="plan-price">' + fmtMoney(price, cur) + '</div>' +
      '<div class="plan-meta">Pays for videos once your plan budget is used up' + (billing.gstApplies && cur === "INR" ? " · plus " + (billing.gstRateBp / 100) + "% GST" : "") + '</div>' +
      '<button class="btn-primary" ' + (planModal.busy ? "disabled" : "") + ' onclick="buyCredit(' + cents + ')">Buy credit</button></div>';
  }).join("");
  return '<p>Credit balance: <b>' + usd(billing.creditCents) + '</b>. Each video draws its own rate from the plan budget first, then from credit. Credit does not expire.</p>' +
    '<div class="plan-top-row"><div class="cycle-toggle">' +
      '<button type="button" class="' + (cur === "USD" ? "active" : "") + '" onclick="setPlanCurrency(\'USD\')">USD</button>' +
      '<button type="button" class="' + (cur === "INR" ? "active" : "") + '" onclick="setPlanCurrency(\'INR\')">INR</button></div></div>' +
    '<div class="plan-grid">' + packs + '</div>';
}

function historyTabHtml() {
  if (planModal.historyLoading && !planModal.history) return '<p class="muted">Loading…</p>';
  const orders = planModal.history || [];
  if (!orders.length) return '<p class="muted">No payments yet.</p>';
  const rows = orders.map(function (o) {
    const what = o.kind === "plan" ? (billing.plans[o.planCode] ? billing.plans[o.planCode].label : o.planCode) + " plan, " + o.billingInterval : "Credit " + usd(o.topupUsdCents);
    const invoices = (o.invoices || []).map((i) => '<a href="#" onclick="openInvoice(' + i.id + '); return false;">' + escapeHtml(i.number) + '</a>').join("<br>");
    const refunds = (o.refunds || []).filter((r) => r.status === "succeeded").map((r) => "Refunded " + fmtMoney(r.amountMinor, o.currency)).join("<br>");
    return '<tr><td>' + fmtDate(o.createdAt) + '</td><td>' + escapeHtml(what) + '</td><td class="num">' + fmtMoney(o.totalMinor, o.currency) + '</td>' +
      '<td><span class="pay-status ' + o.status + '">' + escapeHtml(o.status.replace("_", " ")) + '</span>' + (o.failureReason && o.status === "failed" ? '<div class="muted" style="font-size:11.5px">' + escapeHtml(o.failureReason) + '</div>' : "") + '</td>' +
      '<td>' + invoices + (refunds ? '<div class="muted" style="font-size:11.5px">' + refunds + '</div>' : "") + '</td></tr>';
  }).join("");
  return '<div class="history-wrap"><table class="history-table"><thead><tr><th>Date</th><th>Item</th><th class="num">Total</th><th>Status</th><th>Invoice</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
}

function planSummaryHtml() {
  if (billing.currentPlan === "trial") return "Free plan · " + billing.freeVideosUsed + " of " + billing.freeTrialVideos + " free videos used";
  const label = billing.plans[billing.currentPlan] ? billing.plans[billing.currentPlan].label : billing.currentPlan;
  const state = billing.subscriptionStatus === "active" ? "active until " : billing.subscriptionStatus === "grace" ? "ended " : "ended ";
  return label + " (" + billing.billingInterval + ") · " + state + fmtDate(billing.periodEnd) + " · " + usd(billing.cycleValueUsedCents) + " of " + usd(billing.includedValueCents) + " used";
}

function renderPlanModal() {
  const root = document.getElementById("planModalRoot");
  if (!planModal) { root.innerHTML = ""; return; }
  const gateMessage = GATE_MESSAGES[planModal.reason];
  const body = planModal.tab === "credit" ? creditTabHtml() : planModal.tab === "history" ? historyTabHtml() : plansTabHtml();
  // Same layout as the Shopify adapter's window: header, plan cards, Close. Credit and payment history are secondary
  // views reached from the footer, so the first thing shown is just the plans.
  const secondary = planModal.tab === "credit" || planModal.tab === "history";
  const leftActions = secondary
    ? '<button class="btn-text" onclick="setPlanTab(\'plans\')">← Back to plans</button>'
    : '<button class="btn-text" onclick="setPlanTab(\'credit\')">Add credit' + (billing.creditCents > 0 ? " (" + usd(billing.creditCents) + ")" : "") + '</button>' +
      '<button class="btn-text" onclick="setPlanTab(\'history\')">Payments &amp; invoices</button>';
  root.innerHTML =
    '<div class="modal-backdrop"><div class="modal plan-modal">' +
      '<div class="modal-header">Plans &amp; Billing</div>' +
      (gateMessage ? '<div class="plan-gate-banner">' + escapeHtml(gateMessage) + '</div>' : '') +
      (planModal.error ? '<div class="plan-error">' + escapeHtml(planModal.error) + '</div>' : '') +
      (planModal.notice ? '<div class="plan-notice">' + escapeHtml(planModal.notice) +
        (planModal.payLink && planModal.orderId ? ' <a href="' + escapeHtml(planModal.payLink) + '" target="_blank" rel="noopener">Open payment page</a>' : '') + '</div>' : '') +
      '<div class="modal-body">' + body + '</div>' +
      '<div class="modal-actions plan-footer"><div class="plan-footer-left">' + leftActions + '</div><button class="btn-text" onclick="closePlanModal()">Close</button></div>' +
    '</div></div>';
}
