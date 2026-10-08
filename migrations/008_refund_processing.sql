-- A gateway can accept a refund and decide later (ICICI answers R1000 = accepted, then the outcome is read with a status
-- check). Such refunds sit in 'processing' until the scheduler settles them.
ALTER TABLE refunds DROP CONSTRAINT refunds_status_check;
ALTER TABLE refunds ADD CONSTRAINT refunds_status_check CHECK (status IN ('requested', 'processing', 'succeeded', 'failed'));
