-- Photos a merchant uploads in the stills picker. Hosted by the adapter (the video engine fetches them through a signed /up/<token>
-- link); deleted after 8 days by the scheduler. Per store, with row-level security like every tenant table.
CREATE TABLE uploaded_images (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id     BIGINT NOT NULL REFERENCES stores(id),
  filename     TEXT NOT NULL,
  content_type TEXT NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/gif', 'image/webp')),
  data         BYTEA NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_uploaded_images_store_created ON uploaded_images (store_id, created_at);
CREATE INDEX idx_uploaded_images_created ON uploaded_images (created_at);

ALTER TABLE uploaded_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE uploaded_images FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON uploaded_images USING (app_bypass() OR store_id = app_store_id()) WITH CHECK (app_bypass() OR store_id = app_store_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON uploaded_images TO adapter_app;
