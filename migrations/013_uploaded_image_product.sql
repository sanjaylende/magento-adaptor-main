-- A photo uploaded in the stills picker used to belong to the store only, so the next time the merchant regenerated a video for the same product the
-- picker could not offer it again. It now remembers the product (uniqueTag) it was uploaded for; the picker lists a product's recent uploads
-- (the scheduler still deletes uploads after 8 days). Photos uploaded before this change have no product and are not listed. Only adds a
-- nullable column and an index. Idempotent (safe to run again).
ALTER TABLE uploaded_images ADD COLUMN IF NOT EXISTS unique_tag TEXT;
CREATE INDEX IF NOT EXISTS idx_uploaded_images_store_tag ON uploaded_images (store_id, unique_tag, created_at DESC);
