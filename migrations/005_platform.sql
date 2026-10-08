-- Platform support tables: replay protection, rate limiting, idempotency, audit trail, notifications.
CREATE TABLE request_nonces (
  installation_id BIGINT NOT NULL REFERENCES installations(id),
  nonce           TEXT NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (installation_id, nonce)
);
CREATE INDEX idx_request_nonces_expiry ON request_nonces (expires_at);

CREATE TABLE rate_limits (
  bucket       TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  hits         INT NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);

CREATE TABLE idempotency_keys (
  installation_id BIGINT NOT NULL REFERENCES installations(id),
  idem_key        TEXT NOT NULL,
  request_hash    TEXT NOT NULL,
  status_code     INT,
  response_body   JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (installation_id, idem_key)
);

CREATE TABLE audit_log (
  id              BIGSERIAL PRIMARY KEY,
  at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_type      TEXT NOT NULL,               -- staff, merchant, system, gateway
  actor_id        TEXT,
  merchant_id     BIGINT,
  installation_id BIGINT,
  store_id        BIGINT,
  action          TEXT NOT NULL,
  before_state    JSONB,
  after_state     JSONB,
  ip              TEXT
);
CREATE INDEX idx_audit_log_store ON audit_log (store_id, at DESC);
CREATE INDEX idx_audit_log_action ON audit_log (action, at DESC);

CREATE TABLE notifications (
  id        BIGSERIAL PRIMARY KEY,
  store_id  BIGINT NOT NULL REFERENCES stores(id),
  kind      TEXT NOT NULL,                     -- renewal_reminder, payment_failed, plan_expired, usage_cap
  dedupe_key TEXT NOT NULL UNIQUE,
  payload   JSONB,
  status    TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at   TIMESTAMPTZ
);
