-- Payments, refunds and invoices.
CREATE SEQUENCE invoice_number_seq START 1;

CREATE TABLE payment_orders (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id        BIGINT NOT NULL REFERENCES stores(id),
  merchant_id     BIGINT NOT NULL REFERENCES merchants(id),
  kind            TEXT NOT NULL CHECK (kind IN ('plan', 'topup')),
  plan_code       TEXT REFERENCES plans(code),
  billing_interval TEXT CHECK (billing_interval IN ('monthly', 'annual')),
  topup_usd_cents BIGINT,                      -- credit granted when kind = 'topup'
  currency        CHAR(3) NOT NULL,
  subtotal_minor  BIGINT NOT NULL CHECK (subtotal_minor > 0),
  tax_minor       BIGINT NOT NULL DEFAULT 0,
  total_minor     BIGINT NOT NULL CHECK (total_minor > 0),
  tax_rate_bp     INT NOT NULL DEFAULT 0,      -- basis points, 1800 = 18%
  status          TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'pending', 'paid', 'failed', 'canceled', 'refunded', 'partially_refunded')),
  gateway         TEXT NOT NULL,
  merchant_txn_no TEXT NOT NULL UNIQUE,        -- our reference, sent to the gateway
  gateway_ref     TEXT,                        -- gateway's transaction id once known
  redirect_url    TEXT,
  failure_reason  TEXT,
  idempotency_key TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at         TIMESTAMPTZ,
  CHECK ((kind = 'plan' AND plan_code IS NOT NULL AND billing_interval IS NOT NULL) OR (kind = 'topup' AND topup_usd_cents > 0))
);
CREATE INDEX idx_payment_orders_store ON payment_orders (store_id, created_at DESC);
CREATE INDEX idx_payment_orders_status ON payment_orders (status);

CREATE TABLE payment_attempts (
  id         BIGSERIAL PRIMARY KEY,
  order_id   UUID NOT NULL REFERENCES payment_orders(id),
  status     TEXT NOT NULL,
  response   JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Raw gateway callbacks and status checks. event_key is unique per gateway so a duplicate is detected, not re-applied.
CREATE TABLE gateway_events (
  id          BIGSERIAL PRIMARY KEY,
  gateway     TEXT NOT NULL,
  event_key   TEXT NOT NULL,
  order_id    UUID REFERENCES payment_orders(id),
  payload     JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (gateway, event_key)
);

CREATE TABLE refunds (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id           UUID NOT NULL REFERENCES payment_orders(id),
  store_id           BIGINT NOT NULL REFERENCES stores(id),
  amount_minor       BIGINT NOT NULL CHECK (amount_minor > 0),
  currency           CHAR(3) NOT NULL,
  reason             TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'succeeded', 'failed')),
  entitlement_action TEXT NOT NULL DEFAULT 'none' CHECK (entitlement_action IN ('none', 'cancel_plan', 'remove_credit')),
  gateway_ref        TEXT,
  failure_reason     TEXT,
  requested_by       TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at       TIMESTAMPTZ
);
CREATE INDEX idx_refunds_order ON refunds (order_id);

-- Tax invoices for paid orders, and credit notes for refunds (kind = 'credit_note', negative amounts).
CREATE TABLE invoices (
  id             BIGSERIAL PRIMARY KEY,
  number         TEXT NOT NULL UNIQUE,
  kind           TEXT NOT NULL DEFAULT 'invoice' CHECK (kind IN ('invoice', 'credit_note')),
  order_id       UUID NOT NULL REFERENCES payment_orders(id),
  refund_id      UUID REFERENCES refunds(id),
  store_id       BIGINT NOT NULL REFERENCES stores(id),
  merchant_id    BIGINT NOT NULL REFERENCES merchants(id),
  currency       CHAR(3) NOT NULL,
  subtotal_minor BIGINT NOT NULL,
  tax_minor      BIGINT NOT NULL,
  total_minor    BIGINT NOT NULL,
  tax_rate_bp    INT NOT NULL,
  description    TEXT NOT NULL,
  buyer          JSONB NOT NULL,               -- merchant name, address, GST number at the time of issue
  issued_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_invoice_per_order ON invoices (order_id) WHERE kind = 'invoice';
CREATE UNIQUE INDEX uq_credit_note_per_refund ON invoices (refund_id) WHERE kind = 'credit_note';
CREATE INDEX idx_invoices_store ON invoices (store_id, issued_at DESC);
