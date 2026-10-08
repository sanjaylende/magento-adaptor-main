-- EAV storage for video slots/versions and per-store settings. Fields are added by declaring attributes in src/models,
-- never by ALTER TABLE. store_id on eav_entity is what row-level security (006) isolates tenants by.
CREATE TABLE eav_entity_type (
  entity_type_id BIGSERIAL PRIMARY KEY,
  code           TEXT NOT NULL UNIQUE,
  label          TEXT NOT NULL
);

CREATE TABLE eav_attribute (
  attribute_id   BIGSERIAL PRIMARY KEY,
  entity_type_id BIGINT NOT NULL REFERENCES eav_entity_type(entity_type_id) ON DELETE CASCADE,
  code           TEXT NOT NULL,
  backend_type   TEXT NOT NULL CHECK (backend_type IN ('varchar', 'int', 'text', 'datetime', 'decimal')),
  frontend_type  TEXT NOT NULL DEFAULT 'string' CHECK (frontend_type IN ('string', 'int', 'bool', 'json', 'datetime', 'decimal')),
  UNIQUE (entity_type_id, code)
);

CREATE TABLE eav_entity (
  entity_id      BIGSERIAL PRIMARY KEY,
  entity_type_id BIGINT NOT NULL REFERENCES eav_entity_type(entity_type_id),
  store_id       BIGINT NOT NULL REFERENCES stores(id),
  parent_id      BIGINT REFERENCES eav_entity(entity_id) ON DELETE CASCADE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_eav_entity_store_type ON eav_entity (store_id, entity_type_id);
CREATE INDEX idx_eav_entity_parent ON eav_entity (parent_id);

CREATE TABLE eav_entity_varchar  (entity_id BIGINT NOT NULL REFERENCES eav_entity(entity_id) ON DELETE CASCADE, attribute_id BIGINT NOT NULL REFERENCES eav_attribute(attribute_id) ON DELETE CASCADE, value TEXT,             PRIMARY KEY (entity_id, attribute_id));
CREATE TABLE eav_entity_int      (entity_id BIGINT NOT NULL REFERENCES eav_entity(entity_id) ON DELETE CASCADE, attribute_id BIGINT NOT NULL REFERENCES eav_attribute(attribute_id) ON DELETE CASCADE, value BIGINT,           PRIMARY KEY (entity_id, attribute_id));
CREATE TABLE eav_entity_text     (entity_id BIGINT NOT NULL REFERENCES eav_entity(entity_id) ON DELETE CASCADE, attribute_id BIGINT NOT NULL REFERENCES eav_attribute(attribute_id) ON DELETE CASCADE, value TEXT,             PRIMARY KEY (entity_id, attribute_id));
CREATE TABLE eav_entity_datetime (entity_id BIGINT NOT NULL REFERENCES eav_entity(entity_id) ON DELETE CASCADE, attribute_id BIGINT NOT NULL REFERENCES eav_attribute(attribute_id) ON DELETE CASCADE, value TIMESTAMPTZ,      PRIMARY KEY (entity_id, attribute_id));
CREATE TABLE eav_entity_decimal  (entity_id BIGINT NOT NULL REFERENCES eav_entity(entity_id) ON DELETE CASCADE, attribute_id BIGINT NOT NULL REFERENCES eav_attribute(attribute_id) ON DELETE CASCADE, value NUMERIC(20, 6),   PRIMARY KEY (entity_id, attribute_id));
CREATE INDEX idx_eav_varchar_lookup ON eav_entity_varchar (attribute_id, value);
CREATE INDEX idx_eav_int_lookup     ON eav_entity_int (attribute_id, value);
