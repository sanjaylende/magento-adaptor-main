-- The adapter's own schema (config.database.schema, default "magento_adapter") inside the shared PostgreSQL database.
-- The schema itself is created by the provisioning script (scripts/db/provision.js, run once by a database administrator) or, when
-- missing, by the migration runner; this first migration sets what every later table needs, for the schema this connection is in
-- (the search_path of the connection is exactly that schema). It is safe to run any number of times.
--
-- "adapter_app" below is replaced by the migration runner with the role the service connects as (the user of DATABASE_URL).
DO $$
BEGIN
  IF current_schema() IS NULL THEN
    RAISE EXCEPTION 'the adapter schema does not exist or is not on the search_path';
  END IF;
  -- The running service may use the schema, but only through the privileges granted to it: tables and sequences created from now on
  -- by the owner role (the one that runs migrations) are readable/writable by the service role, nothing more.
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO adapter_app', current_schema());
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO adapter_app', current_schema());
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT USAGE, SELECT ON SEQUENCES TO adapter_app', current_schema());
END
$$;
