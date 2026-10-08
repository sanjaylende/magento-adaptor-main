-- Plans, per-store subscription state, usage and credits. Money is always an integer in minor units (cents/paise).
CREATE TABLE plans (
  code          TEXT PRIMARY KEY,
  label         TEXT NOT NULL,
  sort_order    INT NOT NULL DEFAULT 0,
  free_videos   INT NOT NULL DEFAULT 0,      -- lifetime free allowance (trial only)
  is_active     BOOLEAN NOT NULL DEFAULT TRUE
);

-- One row per (plan, interval, currency). budget_usd_cents is the included video budget per paid period, always in USD
-- cents whatever currency the plan is paid in, so entitlement does not depend on the exchange rate.
CREATE TABLE plan_prices (
  plan_code        TEXT NOT NULL REFERENCES plans(code),
  billing_interval TEXT NOT NULL CHECK (billing_interval IN ('monthly', 'annual')),
  currency         CHAR(3) NOT NULL CHECK (currency IN ('USD', 'INR')),
  amount_minor     BIGINT NOT NULL CHECK (amount_minor >= 0),
  budget_usd_cents BIGINT NOT NULL CHECK (budget_usd_cents >= 0),
  PRIMARY KEY (plan_code, billing_interval, currency)
);

-- What one video draws from the budget (or from credits), by plan tier and video type.
CREATE TABLE plan_video_rates (
  plan_code  TEXT NOT NULL REFERENCES plans(code),
  video_type TEXT NOT NULL,
  usd_cents  BIGINT NOT NULL CHECK (usd_cents > 0),
  PRIMARY KEY (plan_code, video_type)
);

-- Current subscription state of a store (history is in audit_log and payment_orders).
CREATE TABLE store_subscriptions (
  store_id               BIGINT PRIMARY KEY REFERENCES stores(id),
  plan_code              TEXT NOT NULL REFERENCES plans(code) DEFAULT 'trial',
  billing_interval       TEXT CHECK (billing_interval IN ('monthly', 'annual')),
  currency               CHAR(3),
  status                 TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'grace', 'expired', 'canceled')),
  period_start           TIMESTAMPTZ,
  period_end             TIMESTAMPTZ,
  cancel_at_period_end   BOOLEAN NOT NULL DEFAULT FALSE,
  free_videos_used       INT NOT NULL DEFAULT 0,
  cycle_videos_used      INT NOT NULL DEFAULT 0,
  cycle_value_used_cents BIGINT NOT NULL DEFAULT 0,
  usage_cap_reached_at   TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Prepaid credit (top-ups). Balance = SUM(amount_usd_cents). Positive: purchase, refund reversal, manual grant.
-- Negative: a video drawn from credit, a credit removed by a refund.
CREATE TABLE credit_ledger (
  id               BIGSERIAL PRIMARY KEY,
  store_id         BIGINT NOT NULL REFERENCES stores(id),
  amount_usd_cents BIGINT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('topup', 'consume', 'refund', 'manual')),
  ref_type         TEXT,
  ref_id           TEXT,
  note             TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_credit_ledger_store ON credit_ledger (store_id);
-- A credit-funded video can only be charged once.
CREATE UNIQUE INDEX uq_credit_consume_once ON credit_ledger (ref_type, ref_id) WHERE kind = 'consume';

-- One row per billable video (a render that reached "ready"). Unique on the video version: a retry can never bill twice.
CREATE TABLE usage_events (
  id               BIGSERIAL PRIMARY KEY,
  store_id         BIGINT NOT NULL REFERENCES stores(id),
  video_version_id BIGINT NOT NULL UNIQUE,
  video_type       TEXT NOT NULL,
  cost_usd_cents   BIGINT NOT NULL,
  source           TEXT NOT NULL CHECK (source IN ('trial', 'plan', 'credit', 'unbilled')),
  period_start     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_usage_events_store ON usage_events (store_id, created_at);
