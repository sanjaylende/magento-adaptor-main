// Pure plan/metering rules (no I/O), ported from the Shopify adapter's billing.js and made data-driven: plans, prices and
// per-video rates arrive as a catalogue loaded from the database. Unit-tested in test/billingRules.test.js.
//
// Catalogue shape:
//   { plans: { trial: { label, freeVideos }, starter: { label, prices: { monthly: { USD: { amountMinor, budgetUsdCents } } }, videoPriceCents: {...} } } }
// Subscription shape: { planCode, billingInterval, currency, status, periodEnd, freeVideosUsed, cycleValueUsedCents, usageCapReachedAt }

const GATE = { TRIAL_EXHAUSTED: "trial_exhausted", SUBSCRIPTION_INACTIVE: "subscription_inactive", USAGE_CAP: "usage_cap_reached" };

function videoCostCents(catalogue, planCode, videoType) {
  const rates = (catalogue.plans[planCode] && catalogue.plans[planCode].videoPriceCents) || catalogue.plans.trial.videoPriceCents;
  const cents = rates && rates[videoType];
  if (cents == null) throw new Error(`Unknown video type: ${videoType}`);
  return cents;
}

function budgetCents(catalogue, sub) {
  const price = sub.planCode && sub.billingInterval && sub.currency
    ? catalogue.plans[sub.planCode]?.prices?.[sub.billingInterval]?.[sub.currency]
    : null;
  return price ? price.budgetUsdCents : 0;
}

// The subscription as it stands at `now`: an active paid period that has ended is "grace" for graceDays, then "expired".
function effectiveStatus(sub, now, graceDays) {
  if (sub.planCode === "trial" || sub.status === "canceled") return sub.status;
  if (!sub.periodEnd) return sub.status;
  const end = new Date(sub.periodEnd).getTime();
  const t = now.getTime();
  if (t < end) return "active";
  return t < end + graceDays * 86400000 ? "grace" : "expired";
}

// Why generation is blocked right now, or null if a video of this type may start. `creditCents` is the store's prepaid
// credit balance. Mirrors the server gate in the Shopify adapter (same three reasons).
function checkAllowed({ catalogue, sub, creditCents, videoType, now = new Date(), graceDays = 3 }) {
  const cost = videoCostCents(catalogue, sub.planCode, videoType);
  if (sub.planCode === "trial") {
    if (sub.freeVideosUsed < catalogue.plans.trial.freeVideos) return null;
    return creditCents >= cost ? null : GATE.TRIAL_EXHAUSTED;
  }
  const status = effectiveStatus(sub, now, graceDays);
  if (status !== "active" && status !== "grace") return GATE.SUBSCRIPTION_INACTIVE;
  const withinBudget = sub.cycleValueUsedCents + cost <= budgetCents(catalogue, sub);
  if (withinBudget || creditCents >= cost) return null;
  return GATE.USAGE_CAP;
}

// How a finished video is paid for. Trial: the free allowance first. Paid: the cycle budget while the video fits in it
// (the video that exactly exhausts the budget is still included), otherwise prepaid credit. "unbilled" means a render
// finished after its funding ran out (several videos started together); it is recorded, not charged.
function fundingFor({ catalogue, sub, creditCents, videoType }) {
  const cost = videoCostCents(catalogue, sub.planCode, videoType);
  if (sub.planCode === "trial" && sub.freeVideosUsed < catalogue.plans.trial.freeVideos) return { source: "trial", cost };
  if (sub.planCode !== "trial" && sub.cycleValueUsedCents + cost <= budgetCents(catalogue, sub)) return { source: "plan", cost };
  return creditCents >= cost ? { source: "credit", cost } : { source: "unbilled", cost };
}

// Period end for a purchase: one calendar month or year after the later of `now` and the current period end, when the
// same plan is renewed while still valid (remaining time carries over).
function nextPeriodEnd({ now, currentEnd, interval }) {
  const from = currentEnd && new Date(currentEnd) > now ? new Date(currentEnd) : new Date(now);
  const end = new Date(from);
  if (interval === "annual") end.setUTCFullYear(end.getUTCFullYear() + 1);
  else end.setUTCMonth(end.getUTCMonth() + 1);
  return end;
}

// GST: charged on INR invoices to Indian merchants; everything else is untaxed. rateBp = basis points (1800 = 18%).
function taxFor({ subtotalMinor, currency, countryCode, gstRateBp }) {
  const rateBp = currency === "INR" && (countryCode || "").toUpperCase() === "IN" ? gstRateBp : 0;
  const taxMinor = Math.round((subtotalMinor * rateBp) / 10000);
  return { rateBp, taxMinor, totalMinor: subtotalMinor + taxMinor };
}

// Number of videos a budget covers at the cheapest rate; shown as "up to N videos" on plan cards.
const approxVideos = (budget, cheapestRate) => Math.floor(budget / cheapestRate);

module.exports = { GATE, videoCostCents, budgetCents, effectiveStatus, checkAllowed, fundingFor, nextPeriodEnd, taxFor, approxVideos };
