-- Refund and cancel support for the ICICI gateway. Only adds columns and an index; nothing existing changes. Idempotent (safe to run again).
--
-- refunds.idempotency_key: a retried or double-submitted refund request carries the same key and gets back the refund it already
--   made instead of paying the customer twice (unique per order, only where a key was given).
-- refunds.gateway_txn_id / gateway_response: the bank's own transaction id for the refund, and the bank's answer with secrets removed.
-- payment_orders.canceled_by / canceled_at: who canceled an unpaid order and when. A payment that still arrives for an order that
--   somebody canceled on purpose is refunded, not activated; an order the scheduler closed after 24 hours has no canceled_by.
ALTER TABLE refunds
  ADD COLUMN IF NOT EXISTS idempotency_key  TEXT,
  ADD COLUMN IF NOT EXISTS gateway_txn_id   TEXT,
  ADD COLUMN IF NOT EXISTS gateway_response JSONB;
CREATE UNIQUE INDEX IF NOT EXISTS idx_refunds_idempotency ON refunds (order_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

ALTER TABLE payment_orders
  ADD COLUMN IF NOT EXISTS canceled_by TEXT,
  ADD COLUMN IF NOT EXISTS canceled_at TIMESTAMPTZ;
