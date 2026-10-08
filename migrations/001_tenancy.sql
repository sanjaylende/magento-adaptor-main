-- Tenancy: merchant (the paying organisation) -> installation (one Magento deployment) -> store (one Magento website).
CREATE TABLE merchants (
  id            BIGSERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  contact_email TEXT,
  country_code  CHAR(2),
  gst_number    TEXT,
  billing_address TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE installations (
  id                 BIGSERIAL PRIMARY KEY,
  merchant_id        BIGINT NOT NULL REFERENCES merchants(id),
  base_url           TEXT NOT NULL UNIQUE,
  install_key        TEXT NOT NULL UNIQUE,
  secret_enc         TEXT NOT NULL,          -- HMAC secret, AES-256-GCM encrypted
  magento_token_enc  TEXT,                   -- Magento integration token, AES-256-GCM encrypted
  magento_version    TEXT,
  extension_version  TEXT,
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'uninstalled')),
  registered_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at       TIMESTAMPTZ,
  uninstalled_at     TIMESTAMPTZ
);
CREATE INDEX idx_installations_merchant ON installations (merchant_id);

CREATE TABLE stores (
  id              BIGSERIAL PRIMARY KEY,
  installation_id BIGINT NOT NULL REFERENCES installations(id),
  external_id     TEXT NOT NULL,             -- Magento website id
  code            TEXT NOT NULL,
  name            TEXT NOT NULL,
  base_currency   CHAR(3) NOT NULL DEFAULT 'USD',
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (installation_id, external_id)
);

CREATE TABLE admin_users (
  id            BIGSERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'support' CHECK (role IN ('admin', 'support')),
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
