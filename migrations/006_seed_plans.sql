-- Plan catalogue, ported from the Shopify adapter's PLAN_TABLE. Prices are data: change them in the staff console.
-- USD figures match Shopify. INR prices are PLACEHOLDERS (about 83 INR per USD, rounded to x99); confirm before launch.
INSERT INTO plans (code, label, sort_order, free_videos) VALUES
  ('trial',   'Free',    0, 5),
  ('starter', 'Starter', 1, 0),
  ('pro',     'Pro',     2, 0);

-- Annual: the fee is 10x monthly ("2 months free") but the budget is a full 12x monthly, as in the Shopify adapter.
INSERT INTO plan_prices (plan_code, billing_interval, currency, amount_minor, budget_usd_cents) VALUES
  ('starter', 'monthly', 'USD',   2750,   2750),
  ('starter', 'annual',  'USD',  27500,  33000),
  ('pro',     'monthly', 'USD',   8000,   8000),
  ('pro',     'annual',  'USD',  80000,  96000),
  ('starter', 'monthly', 'INR', 229900,   2750),
  ('starter', 'annual',  'INR', 2299900, 33000),
  ('pro',     'monthly', 'INR', 699900,   8000),
  ('pro',     'annual',  'INR', 6999900, 96000);

INSERT INTO plan_video_rates (plan_code, video_type, usd_cents) VALUES
  ('starter', 'image_transition', 250),
  ('starter', 'hero_product',     550),
  ('starter', 'lifestyle',        550),
  ('pro',     'image_transition', 200),
  ('pro',     'hero_product',     500),
  ('pro',     'lifestyle',        500),
  -- Trial and credit-only stores are charged at Starter rates when drawing credit.
  ('trial',   'image_transition', 250),
  ('trial',   'hero_product',     550),
  ('trial',   'lifestyle',        550);
