-- The migration history (schema_migrations) is written only by the migration (owner) role. Migration 007 grants the service role DML on
-- ALL tables of the schema, which at that moment included the history table (the runner creates it first). The service role never needs
-- it, and being able to edit the record of applied migrations is not something it should have. Idempotent: revoking what is not granted
-- changes nothing. ("adapter_app" is replaced by the runner with the role of DATABASE_URL.)
REVOKE ALL ON TABLE schema_migrations FROM adapter_app;
