-- Application role: no superuser, no BYPASSRLS, so row-level security policies apply to every adapter query.
-- adapter_owner (migrations only) owns the tables; adapter_app is what the running service connects as.
CREATE ROLE adapter_app LOGIN PASSWORD 'adapter_app_local' NOSUPERUSER NOBYPASSRLS;
GRANT CONNECT ON DATABASE magento_adapter TO adapter_app;
GRANT USAGE ON SCHEMA public TO adapter_app;
ALTER DEFAULT PRIVILEGES FOR ROLE adapter_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO adapter_app;
ALTER DEFAULT PRIVILEGES FOR ROLE adapter_owner IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO adapter_app;
