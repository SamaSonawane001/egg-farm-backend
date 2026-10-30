-- Egg Farm Manager schema (idempotent). Every business table carries owner_id -> users(id).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  mobile VARCHAR(15) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  owner_name VARCHAR(120) NOT NULL,
  farm_name VARCHAR(160) NOT NULL,
  avatar_url TEXT,
  address TEXT,
  low_stock_threshold NUMERIC(10,2) NOT NULL DEFAULT 10,
  kg_per_bag NUMERIC(10,2) NOT NULL DEFAULT 50,
  default_tax_percent NUMERIC(5,2) NOT NULL DEFAULT 0,
  eggs_per_tray INT NOT NULL DEFAULT 30 CHECK (eggs_per_tray > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS eggs_per_tray INT NOT NULL DEFAULT 30;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_eggs_per_tray_check') THEN
    ALTER TABLE users ADD CONSTRAINT users_eggs_per_tray_check CHECK (eggs_per_tray > 0);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS flock_batches (
  id BIGSERIAL PRIMARY KEY,
  owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  batch_name VARCHAR(120) NOT NULL,
  arrival_date DATE NOT NULL,
  quantity INT NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC(12,2) NOT NULL CHECK (unit_price >= 0),
  total_cost NUMERIC(14,2) GENERATED ALWAYS AS (quantity * unit_price) STORED,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mortality_logs (
  id BIGSERIAL PRIMARY KEY,
  owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  batch_id BIGINT NOT NULL REFERENCES flock_batches(id) ON DELETE CASCADE,
  log_date DATE NOT NULL,
  dead_count INT NOT NULL CHECK (dead_count > 0),
  cause TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS feed_products (
  id BIGSERIAL PRIMARY KEY,
  owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner_id, name)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_feed_products_owner_name_ci ON feed_products(owner_id, lower(trim(name)));

CREATE TABLE IF NOT EXISTS feed_purchases (
  id BIGSERIAL PRIMARY KEY,
  owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delivery_date DATE NOT NULL,
  feed_type VARCHAR(120) NOT NULL,
  bags NUMERIC(12,2) NOT NULL CHECK (bags > 0),
  cost_per_bag NUMERIC(12,2) NOT NULL CHECK (cost_per_bag >= 0),
  total_cost NUMERIC(14,2) GENERATED ALWAYS AS (bags * cost_per_bag) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS feed_usage (
  id BIGSERIAL PRIMARY KEY,
  owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  batch_id BIGINT REFERENCES flock_batches(id) ON DELETE SET NULL,
  usage_date DATE NOT NULL,
  quantity NUMERIC(12,2) NOT NULL CHECK (quantity > 0),
  unit VARCHAR(5) NOT NULL CHECK (unit IN ('bags','kg')),
  bags_equivalent NUMERIC(12,3) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE feed_usage ADD COLUMN IF NOT EXISTS feed_type VARCHAR(120);
ALTER TABLE feed_purchases ADD COLUMN IF NOT EXISTS feed_product_id BIGINT REFERENCES feed_products(id) ON DELETE CASCADE;
ALTER TABLE feed_usage ADD COLUMN IF NOT EXISTS feed_product_id BIGINT REFERENCES feed_products(id) ON DELETE CASCADE;

-- Existing usage logs cannot be attributed across multiple feed types reliably.
-- Backfill only where the owner's purchase history contains exactly one type.
UPDATE feed_usage u
SET feed_type = only_feed.feed_type
FROM (
  SELECT owner_id, MIN(feed_type) AS feed_type
  FROM feed_purchases
  GROUP BY owner_id
  HAVING COUNT(DISTINCT lower(trim(feed_type))) = 1
) only_feed
WHERE u.owner_id = only_feed.owner_id AND u.feed_type IS NULL;

INSERT INTO feed_products (owner_id, name)
SELECT names.owner_id, MIN(names.name)
FROM (
  SELECT owner_id, trim(feed_type) AS name FROM feed_purchases WHERE trim(feed_type) <> ''
  UNION ALL
  SELECT owner_id, trim(feed_type) AS name FROM feed_usage WHERE feed_type IS NOT NULL AND trim(feed_type) <> ''
) names
GROUP BY names.owner_id, lower(names.name)
ON CONFLICT DO NOTHING;

UPDATE feed_purchases p SET feed_product_id = fp.id
FROM feed_products fp
WHERE p.owner_id = fp.owner_id AND lower(trim(p.feed_type)) = lower(trim(fp.name)) AND p.feed_product_id IS NULL;

UPDATE feed_usage u SET feed_product_id = fp.id
FROM feed_products fp
WHERE u.owner_id = fp.owner_id AND u.feed_type IS NOT NULL
  AND lower(trim(u.feed_type)) = lower(trim(fp.name)) AND u.feed_product_id IS NULL;

CREATE TABLE IF NOT EXISTS egg_production (
  id BIGSERIAL PRIMARY KEY,
  owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  batch_id BIGINT REFERENCES flock_batches(id) ON DELETE SET NULL,
  collection_date DATE NOT NULL,
  trays_count INT NOT NULL DEFAULT 0 CHECK (trays_count >= 0),
  loose_eggs INT NOT NULL DEFAULT 0 CHECK (loose_eggs >= 0),
  eggs_per_tray_used INT NOT NULL DEFAULT 30 CHECK (eggs_per_tray_used > 0),
  total_eggs INT NOT NULL CHECK (total_eggs >= 0),
  damaged_eggs INT NOT NULL DEFAULT 0 CHECK (damaged_eggs >= 0),
  net_eggs INT GENERATED ALWAYS AS (total_eggs - damaged_eggs) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (damaged_eggs <= total_eggs)
);

ALTER TABLE egg_production ADD COLUMN IF NOT EXISTS trays_count INT;
ALTER TABLE egg_production ADD COLUMN IF NOT EXISTS loose_eggs INT;
ALTER TABLE egg_production ADD COLUMN IF NOT EXISTS eggs_per_tray_used INT;
UPDATE egg_production
SET trays_count = COALESCE(trays_count, 0),
    loose_eggs = COALESCE(loose_eggs, total_eggs),
    eggs_per_tray_used = COALESCE(eggs_per_tray_used, (
      SELECT u.eggs_per_tray FROM users u WHERE u.id = egg_production.owner_id
    ), 30);
ALTER TABLE egg_production ALTER COLUMN trays_count SET DEFAULT 0;
ALTER TABLE egg_production ALTER COLUMN trays_count SET NOT NULL;
ALTER TABLE egg_production ALTER COLUMN loose_eggs SET DEFAULT 0;
ALTER TABLE egg_production ALTER COLUMN loose_eggs SET NOT NULL;
ALTER TABLE egg_production ALTER COLUMN eggs_per_tray_used SET DEFAULT 30;
ALTER TABLE egg_production ALTER COLUMN eggs_per_tray_used SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'egg_production_trays_count_check') THEN
    ALTER TABLE egg_production ADD CONSTRAINT egg_production_trays_count_check CHECK (trays_count >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'egg_production_loose_eggs_check') THEN
    ALTER TABLE egg_production ADD CONSTRAINT egg_production_loose_eggs_check CHECK (loose_eggs >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'egg_production_eggs_per_tray_used_check') THEN
    ALTER TABLE egg_production ADD CONSTRAINT egg_production_eggs_per_tray_used_check CHECK (eggs_per_tray_used > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'egg_production_total_matches_trays_check') THEN
    ALTER TABLE egg_production ADD CONSTRAINT egg_production_total_matches_trays_check
      CHECK (total_eggs = trays_count * eggs_per_tray_used + loose_eggs);
  END IF;
END $$;

ALTER TABLE egg_production DROP COLUMN IF EXISTS price_mode;
ALTER TABLE egg_production DROP COLUMN IF EXISTS price_input;
ALTER TABLE egg_production DROP COLUMN IF EXISTS price_per_egg;
ALTER TABLE egg_production DROP COLUMN IF EXISTS total_value;

CREATE TABLE IF NOT EXISTS invoices (
  id BIGSERIAL PRIMARY KEY,
  owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invoice_year INT NOT NULL DEFAULT EXTRACT(YEAR FROM CURRENT_DATE)::int,
  invoice_seq INT NOT NULL,
  invoice_no VARCHAR(30) NOT NULL,
  invoice_type VARCHAR(20) NOT NULL CHECK (invoice_type IN ('egg_sale','spent_hen_sale','feed_trade')),
  customer_name VARCHAR(160) NOT NULL,
  customer_mobile VARCHAR(20),
  invoice_date DATE NOT NULL,
  subtotal NUMERIC(14,2) NOT NULL,
  tax_percent NUMERIC(5,2) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  grand_total NUMERIC(14,2) NOT NULL,
  notes TEXT,
  share_token UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner_id, invoice_year, invoice_seq)
);

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS invoice_year INT;
UPDATE invoices
SET invoice_year = COALESCE(NULLIF(substring(invoice_no from '^INV-([0-9]{4})-'), '')::int, EXTRACT(YEAR FROM created_at)::int)
WHERE invoice_year IS NULL;
ALTER TABLE invoices ALTER COLUMN invoice_year SET NOT NULL;
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_owner_id_invoice_seq_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_owner_year_seq ON invoices(owner_id, invoice_year, invoice_seq);

CREATE TABLE IF NOT EXISTS invoice_items (
  id BIGSERIAL PRIMARY KEY,
  owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invoice_id BIGINT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  description VARCHAR(255) NOT NULL,
  quantity NUMERIC(12,2) NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC(12,2) NOT NULL CHECK (unit_price >= 0),
  amount NUMERIC(14,2) NOT NULL,
  egg_quantity INT CHECK (egg_quantity IS NULL OR egg_quantity > 0)
);

ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS egg_quantity INT;
UPDATE invoice_items it
SET egg_quantity = CASE
  WHEN lower(it.description) ~ '(crate|tray)' THEN round(it.quantity * 30)::int
  ELSE round(it.quantity)::int
END
FROM invoices i
WHERE i.id = it.invoice_id AND i.owner_id = it.owner_id AND i.invoice_type = 'egg_sale'
  AND it.egg_quantity IS NULL;

CREATE INDEX IF NOT EXISTS idx_flock_owner ON flock_batches(owner_id, arrival_date DESC);
CREATE INDEX IF NOT EXISTS idx_mort_owner ON mortality_logs(owner_id, log_date DESC);
CREATE INDEX IF NOT EXISTS idx_mort_batch ON mortality_logs(batch_id);
CREATE INDEX IF NOT EXISTS idx_feedp_owner ON feed_purchases(owner_id, delivery_date DESC);
CREATE INDEX IF NOT EXISTS idx_feedp_product ON feed_purchases(owner_id, feed_product_id, delivery_date DESC);
CREATE INDEX IF NOT EXISTS idx_feedu_owner ON feed_usage(owner_id, usage_date DESC);
CREATE INDEX IF NOT EXISTS idx_feedu_owner_type ON feed_usage(owner_id, lower(trim(feed_type)));
CREATE INDEX IF NOT EXISTS idx_feedu_product ON feed_usage(owner_id, feed_product_id, usage_date DESC);
CREATE INDEX IF NOT EXISTS idx_egg_owner ON egg_production(owner_id, collection_date DESC);
CREATE INDEX IF NOT EXISTS idx_inv_owner ON invoices(owner_id, invoice_date DESC);
CREATE INDEX IF NOT EXISTS idx_inv_created_owner ON invoices(owner_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_invitems_inv ON invoice_items(invoice_id);

-- Row-Level-Security ready: policies key off the session setting app.owner_id.
-- The API connects as the table owner (bypasses RLS) and filters by owner_id in every query.
-- To enforce RLS in the DB too, connect as a non-owner role and run
--   SELECT set_config('app.owner_id', '<id>', true);  at the start of each transaction.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['flock_batches','mortality_logs','feed_products','feed_purchases','feed_usage','egg_production','invoices','invoice_items']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (owner_id = NULLIF(current_setting(''app.owner_id'', true), '''')::bigint)', t);
  END LOOP;
END $$;
