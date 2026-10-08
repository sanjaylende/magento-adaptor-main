-- Row-level security: a second guard behind the repository's own store_id filters. The adapter connects as adapter_app,
-- which has no BYPASSRLS. A query only sees rows of the store set in app.store_id, unless app.bypass = 'on' (staff
-- console, gateway callbacks, scheduled jobs). With neither set, tenant tables return nothing.
CREATE FUNCTION app_store_id() RETURNS BIGINT LANGUAGE sql STABLE AS
  $$ SELECT NULLIF(current_setting('app.store_id', true), '')::BIGINT $$;
CREATE FUNCTION app_bypass() RETURNS BOOLEAN LANGUAGE sql STABLE AS
  $$ SELECT COALESCE(current_setting('app.bypass', true), '') = 'on' $$;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['eav_entity', 'store_subscriptions', 'credit_ledger', 'usage_events', 'payment_orders', 'refunds', 'invoices', 'notifications']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (app_bypass() OR store_id = app_store_id()) WITH CHECK (app_bypass() OR store_id = app_store_id())', t);
  END LOOP;
  -- Value tables follow their entity: visible only when the parent entity is visible.
  FOREACH t IN ARRAY ARRAY['eav_entity_varchar', 'eav_entity_int', 'eav_entity_text', 'eav_entity_datetime', 'eav_entity_decimal']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY via_entity ON %I USING (EXISTS (SELECT 1 FROM eav_entity e WHERE e.entity_id = %I.entity_id)) WITH CHECK (EXISTS (SELECT 1 FROM eav_entity e WHERE e.entity_id = %I.entity_id))', t, t, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO adapter_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO adapter_app;
