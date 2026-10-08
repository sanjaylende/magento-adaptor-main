// Per-store subscription state, usage metering and credits, on top of the pure rules in billingRules.js.
const config = require("../config");
const logger = require("../utils/logger");
const { query, tx, asSystem, currentStoreId } = require("../db/connection");
const rules = require("./billingRules");
const audit = require("./auditService");

const CATALOGUE_TTL_MS = 60 * 1000;
let catalogueCache = null;

// Plans with prices per interval and currency, and per-video rates. Cached briefly; staff edits invalidate it.
async function loadCatalogue() {
  if (catalogueCache && Date.now() - catalogueCache.at < CATALOGUE_TTL_MS) return catalogueCache.value;
  const [plans, prices, rates] = await Promise.all([
    query("SELECT code, label, free_videos FROM plans WHERE is_active ORDER BY sort_order"),
    query("SELECT plan_code, billing_interval, currency, amount_minor, budget_usd_cents FROM plan_prices"),
    query("SELECT plan_code, video_type, usd_cents FROM plan_video_rates"),
  ]);
  const out = {};
  for (const p of plans.rows) out[p.code] = { label: p.label, freeVideos: p.free_videos, prices: {}, videoPriceCents: {} };
  for (const r of prices.rows) {
    const plan = out[r.plan_code];
    if (!plan) continue;
    ((plan.prices[r.billing_interval] ||= {})[r.currency.trim()] = { amountMinor: r.amount_minor, budgetUsdCents: r.budget_usd_cents });
  }
  for (const r of rates.rows) if (out[r.plan_code]) out[r.plan_code].videoPriceCents[r.video_type] = r.usd_cents;
  catalogueCache = { at: Date.now(), value: { plans: out } };
  return catalogueCache.value;
}

const invalidateCatalogue = () => { catalogueCache = null; };

const mapSub = (r) => ({
  storeId: r.store_id, planCode: r.plan_code, billingInterval: r.billing_interval, currency: r.currency && r.currency.trim(),
  status: r.status, periodStart: r.period_start && new Date(r.period_start).toISOString(),
  periodEnd: r.period_end && new Date(r.period_end).toISOString(), cancelAtPeriodEnd: r.cancel_at_period_end,
  freeVideosUsed: r.free_videos_used, cycleVideosUsed: r.cycle_videos_used, cycleValueUsedCents: r.cycle_value_used_cents,
  usageCapReachedAt: r.usage_cap_reached_at && new Date(r.usage_cap_reached_at).toISOString(),
});

async function getSubscription(storeId = currentStoreId()) {
  let { rows: [row] } = await query("SELECT * FROM store_subscriptions WHERE store_id = $1", [storeId]);
  if (!row) {
    ({ rows: [row] } = await query("INSERT INTO store_subscriptions (store_id) VALUES ($1) ON CONFLICT (store_id) DO UPDATE SET store_id = EXCLUDED.store_id RETURNING *", [storeId]));
  }
  return mapSub(row);
}

async function creditBalance(storeId = currentStoreId()) {
  const { rows: [row] } = await query("SELECT COALESCE(SUM(amount_usd_cents), 0) AS balance FROM credit_ledger WHERE store_id = $1", [storeId]);
  return row.balance;
}

// Why a video of this type cannot start now (one of rules.GATE), or null.
async function checkGenerationAllowed(videoType) {
  const [catalogue, sub, credit] = await Promise.all([loadCatalogue(), getSubscription(), creditBalance()]);
  return rules.checkAllowed({ catalogue, sub, creditCents: credit, videoType, graceDays: config.billing.graceDays });
}

// Called once when a render reaches "ready": counts it, funds it, and never fails the render (errors are logged).
// Idempotent per video version: a retried completion changes nothing.
async function recordVideoCompleted(videoVersionId, videoType) {
  try {
    return await tx(async () => {
      const storeId = currentStoreId();
      await query("SELECT store_id FROM store_subscriptions WHERE store_id = $1 FOR UPDATE", [storeId]);
      const { rows: [existing] } = await query("SELECT id FROM usage_events WHERE video_version_id = $1", [videoVersionId]);
      if (existing) return null;
      const [catalogue, sub, credit] = await Promise.all([loadCatalogue(), getSubscription(), creditBalance()]);
      const funding = rules.fundingFor({ catalogue, sub, creditCents: credit, videoType });
      await query(
        "INSERT INTO usage_events (store_id, video_version_id, video_type, cost_usd_cents, source, period_start) VALUES ($1, $2, $3, $4, $5, $6)",
        [storeId, videoVersionId, videoType, funding.cost, funding.source, sub.periodStart]
      );
      if (funding.source === "trial") {
        await query("UPDATE store_subscriptions SET free_videos_used = free_videos_used + 1, updated_at = now() WHERE store_id = $1", [storeId]);
      } else {
        await query(
          "UPDATE store_subscriptions SET cycle_videos_used = cycle_videos_used + 1, cycle_value_used_cents = cycle_value_used_cents + $2, updated_at = now() WHERE store_id = $1",
          [storeId, funding.cost]
        );
        if (funding.source === "credit") {
          await query(
            "INSERT INTO credit_ledger (store_id, amount_usd_cents, kind, ref_type, ref_id) VALUES ($1, $2, 'consume', 'video_version', $3)",
            [storeId, -funding.cost, String(videoVersionId)]
          );
        }
      }
      // Flag when the next video of any type would be blocked, so the UI can show it without a failed attempt.
      const after = await checkGenerationAllowed("image_transition");
      if (after === rules.GATE.USAGE_CAP) await query("UPDATE store_subscriptions SET usage_cap_reached_at = COALESCE(usage_cap_reached_at, now()) WHERE store_id = $1", [storeId]);
      return funding;
    });
  } catch (err) {
    logger.error("Failed to record video usage:", videoVersionId, err.message);
    return null;
  }
}

// Starts (or renews) a paid period after a verified payment. Remaining time of a still-valid same plan carries over;
// the cycle's usage counters restart.
async function activatePlan({ storeId, planCode, billingInterval, currency, orderId }) {
  return tx(async () => {
    const before = await getSubscription(storeId);
    const sameValidPlan = before.planCode === planCode && before.status !== "canceled";
    const end = rules.nextPeriodEnd({ now: new Date(), currentEnd: sameValidPlan ? before.periodEnd : null, interval: billingInterval });
    const { rows: [row] } = await query(
      `UPDATE store_subscriptions SET plan_code = $2, billing_interval = $3, currency = $4, status = 'active', period_start = now(),
              period_end = $5, cancel_at_period_end = FALSE, cycle_videos_used = 0, cycle_value_used_cents = 0,
              usage_cap_reached_at = NULL, updated_at = now()
       WHERE store_id = $1 RETURNING *`,
      [storeId, planCode, billingInterval, currency, end]
    );
    await audit.record({ actorType: "gateway", storeId, action: "subscription.activated", before, after: { ...mapSub(row), orderId } });
    return mapSub(row);
  });
}

async function addCredit({ storeId, usdCents, kind, refType = null, refId = null, note = null }) {
  await query(
    "INSERT INTO credit_ledger (store_id, amount_usd_cents, kind, ref_type, ref_id, note) VALUES ($1, $2, $3, $4, $5, $6)",
    [storeId, usdCents, kind, refType, refId, note]
  );
  await query("UPDATE store_subscriptions SET usage_cap_reached_at = NULL, updated_at = now() WHERE store_id = $1", [storeId]);
}

// "Cancel Plan", as in the Shopify adapter: takes effect immediately and drops the store back to the free plan. The free
// videos already used stay counted (cancelling and re-joining cannot refill the trial), prepaid credit is kept, and the
// paid period is not refunded automatically (a refund is a staff decision, see refundOrder).
async function cancelPlan(actor) {
  const storeId = currentStoreId();
  const before = await getSubscription(storeId);
  if (before.planCode === "trial") throw Object.assign(new Error("There is no paid plan to cancel"), { status: 400, userMessage: "There is no paid plan to cancel" });
  await query(
    `UPDATE store_subscriptions SET plan_code = 'trial', billing_interval = NULL, currency = NULL, status = 'active', period_start = NULL,
            period_end = NULL, cancel_at_period_end = FALSE, cycle_videos_used = 0, cycle_value_used_cents = 0, usage_cap_reached_at = NULL,
            updated_at = now()
     WHERE store_id = $1`,
    [storeId]
  );
  await audit.record({ actorType: actor.type, actorId: actor.id, storeId, action: "subscription.canceled", before, after: { planCode: "trial" } });
  return getSubscription(storeId);
}

// Immediate end of the paid period (staff action, e.g. with a full refund): the store drops back to an expired plan.
async function endPlanNow(storeId, actor) {
  const before = await getSubscription(storeId);
  await query("UPDATE store_subscriptions SET status = 'canceled', period_end = now(), cancel_at_period_end = FALSE, updated_at = now() WHERE store_id = $1", [storeId]);
  await audit.record({ actorType: actor.type, actorId: actor.id, storeId, action: "subscription.ended", before });
}

// The JSON the UI badge and Plans & Billing modal render from (same role as buildBillingSnapshot in the Shopify adapter).
async function snapshot(merchantCountry) {
  const [catalogue, sub, credit] = await Promise.all([loadCatalogue(), getSubscription(), creditBalance()]);
  const status = rules.effectiveStatus(sub, new Date(), config.billing.graceDays);
  const plans = {};
  for (const [code, p] of Object.entries(catalogue.plans)) {
    plans[code] = { label: p.label, freeVideos: p.freeVideos, prices: p.prices, videoPriceCents: p.videoPriceCents };
  }
  return {
    currentPlan: sub.planCode,
    billingInterval: sub.billingInterval,
    currency: sub.currency,
    subscriptionStatus: sub.planCode === "trial" ? "active" : status,
    periodStart: sub.periodStart,
    periodEnd: sub.periodEnd,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    freeVideosUsed: sub.freeVideosUsed,
    freeTrialVideos: catalogue.plans.trial.freeVideos,
    cycleVideosUsed: sub.cycleVideosUsed,
    cycleValueUsedCents: sub.cycleValueUsedCents,
    includedValueCents: rules.budgetCents(catalogue, sub),
    usageCapReached: sub.planCode === "trial"
      ? sub.freeVideosUsed >= catalogue.plans.trial.freeVideos && credit < 250
      : !!sub.usageCapReachedAt || status === "expired",
    creditCents: credit,
    plans,
    topupPacksUsd: config.billing.topupPacksUsd,
    defaultCurrency: (merchantCountry || "").toUpperCase() === "IN" ? "INR" : "USD",
    gstApplies: (merchantCountry || "").toUpperCase() === "IN",
    inrPerUsd: config.billing.inrPerUsd,
    gstRateBp: config.billing.gstRateBp,
  };
}

// Usage per store for the staff console and merchant history.
async function usageSummary(storeId, limit = 50) {
  const { rows } = await query(
    "SELECT video_version_id, video_type, cost_usd_cents, source, created_at FROM usage_events WHERE store_id = $1 ORDER BY id DESC LIMIT $2",
    [storeId, limit]
  );
  return rows;
}

module.exports = {
  loadCatalogue, invalidateCatalogue, getSubscription, creditBalance, checkGenerationAllowed, recordVideoCompleted,
  activatePlan, addCredit, cancelPlan, endPlanNow, snapshot, usageSummary,
};
