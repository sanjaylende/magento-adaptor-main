-- Staff console hardening: account lock-out after repeated failed sign-ins, and TOTP two-factor.
ALTER TABLE admin_users
  ADD COLUMN failed_attempts INT         NOT NULL DEFAULT 0,
  ADD COLUMN locked_until    TIMESTAMPTZ,
  ADD COLUMN totp_secret     TEXT,                       -- AES-256-GCM encrypted, never the plain secret
  ADD COLUMN totp_enabled    BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN totp_last_step  BIGINT      NOT NULL DEFAULT 0;  -- last accepted 30-second step: a code can be used only once
