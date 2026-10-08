const test = require("node:test");
const assert = require("node:assert/strict");
const rules = require("../src/services/billingRules");

const catalogue = {
  plans: {
    trial: { label: "Free", freeVideos: 5, videoPriceCents: { image_transition: 250, hero_product: 550, lifestyle: 550 } },
    starter: {
      label: "Starter",
      prices: {
        monthly: { USD: { amountMinor: 2750, budgetUsdCents: 2750 }, INR: { amountMinor: 229900, budgetUsdCents: 2750 } },
        annual: { USD: { amountMinor: 27500, budgetUsdCents: 33000 } },
      },
      videoPriceCents: { image_transition: 250, hero_product: 550, lifestyle: 550 },
    },
  },
};
const paid = (over = {}) => ({
  planCode: "starter", billingInterval: "monthly", currency: "USD", status: "active",
  periodEnd: "2026-11-01T00:00:00Z", freeVideosUsed: 5, cycleValueUsedCents: 0, ...over,
});
const now = new Date("2026-10-10T00:00:00Z");

test("trial: free videos run out, credit extends it", () => {
  const trial = (used) => ({ planCode: "trial", freeVideosUsed: used, cycleValueUsedCents: 0 });
  assert.equal(rules.checkAllowed({ catalogue, sub: trial(4), creditCents: 0, videoType: "hero_product", now }), null);
  assert.equal(rules.checkAllowed({ catalogue, sub: trial(5), creditCents: 0, videoType: "hero_product", now }), rules.GATE.TRIAL_EXHAUSTED);
  assert.equal(rules.checkAllowed({ catalogue, sub: trial(5), creditCents: 550, videoType: "hero_product", now }), null);
  assert.equal(rules.checkAllowed({ catalogue, sub: trial(5), creditCents: 549, videoType: "hero_product", now }), rules.GATE.TRIAL_EXHAUSTED);
});

test("paid: the video that exactly exhausts the budget is included, the next is not", () => {
  // 2200 used + 550 = 2750 = the whole budget: still within the plan.
  assert.deepEqual(rules.fundingFor({ catalogue, sub: paid({ cycleValueUsedCents: 2200 }), creditCents: 0, videoType: "lifestyle" }), { source: "plan", cost: 550 });
  assert.equal(rules.fundingFor({ catalogue, sub: paid({ cycleValueUsedCents: 2750 }), creditCents: 0, videoType: "lifestyle" }).source, "unbilled");
  assert.equal(rules.fundingFor({ catalogue, sub: paid({ cycleValueUsedCents: 2750 }), creditCents: 600, videoType: "lifestyle" }).source, "credit");
});

test("paid: per-type rates draw different amounts", () => {
  assert.equal(rules.videoCostCents(catalogue, "starter", "image_transition"), 250);
  assert.equal(rules.videoCostCents(catalogue, "starter", "hero_product"), 550);
  assert.throws(() => rules.videoCostCents(catalogue, "starter", "nope"));
});

test("paid: over budget is blocked unless credit covers the video", () => {
  const sub = paid({ cycleValueUsedCents: 2750 });
  assert.equal(rules.checkAllowed({ catalogue, sub, creditCents: 0, videoType: "image_transition", now }), rules.GATE.USAGE_CAP);
  assert.equal(rules.checkAllowed({ catalogue, sub, creditCents: 250, videoType: "image_transition", now }), null);
});

test("status moves active -> grace -> expired after the period ends", () => {
  const sub = paid({ periodEnd: "2026-10-01T00:00:00Z" });
  assert.equal(rules.effectiveStatus(sub, new Date("2026-09-30T00:00:00Z"), 3), "active");
  assert.equal(rules.effectiveStatus(sub, new Date("2026-10-03T00:00:00Z"), 3), "grace");
  assert.equal(rules.effectiveStatus(sub, new Date("2026-10-05T00:00:00Z"), 3), "expired");
  assert.equal(rules.checkAllowed({ catalogue, sub, creditCents: 0, videoType: "lifestyle", now: new Date("2026-10-05T00:00:00Z"), graceDays: 3 }), rules.GATE.SUBSCRIPTION_INACTIVE);
  assert.equal(rules.checkAllowed({ catalogue, sub, creditCents: 0, videoType: "lifestyle", now: new Date("2026-10-03T00:00:00Z"), graceDays: 3 }), null);
});

test("budget follows the currency-independent entitlement", () => {
  assert.equal(rules.budgetCents(catalogue, paid({ currency: "INR" })), 2750);
  assert.equal(rules.budgetCents(catalogue, paid({ billingInterval: "annual" })), 33000);
});

test("renewal while still valid carries the remaining time over", () => {
  const end = rules.nextPeriodEnd({ now, currentEnd: "2026-10-20T00:00:00Z", interval: "monthly" });
  assert.equal(end.toISOString(), "2026-11-20T00:00:00.000Z");
  const fresh = rules.nextPeriodEnd({ now, currentEnd: "2026-09-01T00:00:00Z", interval: "annual" });
  assert.equal(fresh.toISOString(), "2027-10-10T00:00:00.000Z");
});

test("GST applies to INR for Indian merchants only", () => {
  assert.deepEqual(rules.taxFor({ subtotalMinor: 229900, currency: "INR", countryCode: "IN", gstRateBp: 1800 }), { rateBp: 1800, taxMinor: 41382, totalMinor: 271282 });
  assert.equal(rules.taxFor({ subtotalMinor: 229900, currency: "INR", countryCode: "US", gstRateBp: 1800 }).taxMinor, 0);
  assert.equal(rules.taxFor({ subtotalMinor: 2750, currency: "USD", countryCode: "IN", gstRateBp: 1800 }).taxMinor, 0);
});
