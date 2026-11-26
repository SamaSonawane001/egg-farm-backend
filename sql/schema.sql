-- Initial schema migration. Applied and versioned by backend/src/config/migrate.ts.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mobile VARCHAR(15) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  owner_name VARCHAR(120) NOT NULL,
  farm_name VARCHAR(160) NOT NULL,
  avatar_url TEXT,
  signature_url TEXT,
  payment_qr_url TEXT,
  address TEXT,
  consent_accepted BOOLEAN NOT NULL DEFAULT FALSE,
  consent_version VARCHAR(32) NOT NULL DEFAULT 'v1.0-2027',
  consent_accepted_at TIMESTAMPTZ NULL,
  failed_login_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ NULL,
  low_stock_threshold NUMERIC(10,2) NOT NULL DEFAULT 10,
  kg_per_bag NUMERIC(10,2) NOT NULL DEFAULT 50,
  default_tax_percent NUMERIC(5,2) NOT NULL DEFAULT 0,
  eggs_per_tray INT NOT NULL DEFAULT 30 CHECK (eggs_per_tray > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS signature_url TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS payment_qr_url TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS eggs_per_tray INT NOT NULL DEFAULT 30;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_eggs_per_tray_check') THEN
    ALTER TABLE users ADD CONSTRAINT users_eggs_per_tray_check CHECK (eggs_per_tray > 0);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS flock_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  batch_name VARCHAR(120) NOT NULL,
  arrival_date DATE NOT NULL,
  quantity INT NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC(12,2) NOT NULL CHECK (unit_price >= 0),
  total_cost NUMERIC(14,2) GENERATED ALWAYS AS (quantity * unit_price) STORED,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mortality_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  batch_id UUID NOT NULL REFERENCES flock_batches(id) ON DELETE CASCADE,
  log_date DATE NOT NULL,
  dead_count INT NOT NULL CHECK (dead_count > 0),
  cause TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS feed_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner_id, name)
);

DO $$
BEGIN
  BEGIN
    CREATE UNIQUE INDEX IF NOT EXISTS idx_feed_products_owner_name_ci
      ON feed_products(owner_id, lower(trim(name)));
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '%', SQLERRM;
  END;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='feed_products' AND column_name='farm_id'
  ) THEN
    ALTER TABLE feed_products ALTER COLUMN farm_id DROP NOT NULL;
  END IF;
END $$;

INSERT INTO feed_products(owner_id, name)
SELECT id, 'Ready Feed' FROM users
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS feed_purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delivery_date DATE NOT NULL,
  feed_type VARCHAR(120) NOT NULL,
  bags NUMERIC(12,5) NOT NULL CHECK (bags > 0),
  cost_per_bag NUMERIC(12,2) NOT NULL CHECK (cost_per_bag >= 0),
  total_cost NUMERIC(14,2) NOT NULL DEFAULT 0,
  source VARCHAR(20) NOT NULL DEFAULT 'PURCHASE' CHECK (source IN ('PURCHASE','PROCESSING')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE feed_purchases ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'PURCHASE';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feed_purchases_source_check') THEN
    ALTER TABLE feed_purchases ADD CONSTRAINT feed_purchases_source_check CHECK (source IN ('PURCHASE','PROCESSING'));
  END IF;
END $$;

ALTER TABLE feed_purchases ALTER COLUMN total_cost DROP EXPRESSION IF EXISTS;
ALTER TABLE feed_purchases ADD COLUMN IF NOT EXISTS entered_quantity NUMERIC(12,3);
ALTER TABLE feed_purchases ADD COLUMN IF NOT EXISTS entered_unit VARCHAR(10);
ALTER TABLE feed_purchases ADD COLUMN IF NOT EXISTS rate_per_unit NUMERIC(14,3);
ALTER TABLE feed_purchases ADD COLUMN IF NOT EXISTS kg_per_bag NUMERIC(8,3);
UPDATE feed_purchases p
SET entered_quantity=COALESCE(p.entered_quantity,p.bags),
    entered_unit=COALESCE(p.entered_unit,'bags'),
    rate_per_unit=COALESCE(p.rate_per_unit,p.cost_per_bag),
    kg_per_bag=COALESCE(p.kg_per_bag,u.kg_per_bag,50),
    total_cost=CASE WHEN p.total_cost=0 THEN ROUND(p.bags*p.cost_per_bag,2) ELSE p.total_cost END
FROM users u
WHERE p.owner_id=u.id
  AND (p.entered_quantity IS NULL OR p.entered_unit IS NULL OR p.rate_per_unit IS NULL OR p.kg_per_bag IS NULL);

CREATE TABLE IF NOT EXISTS raw_materials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  unit VARCHAR(30) NOT NULL,
  min_alert_threshold NUMERIC(12,3) NOT NULL DEFAULT 0 CHECK (min_alert_threshold >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner_id, id)
);

DO $$ BEGIN
  IF to_regclass('public.raw_material_transactions') IS NOT NULL
     AND to_regclass('public.raw_material_logs') IS NULL THEN
    ALTER TABLE raw_material_transactions RENAME TO raw_material_logs;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS raw_material_processing (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  processing_date DATE NOT NULL,
  feed_product_id UUID NOT NULL REFERENCES feed_products(id) ON DELETE RESTRICT,
  quantity_bags NUMERIC(12,5) NOT NULL CHECK (quantity_bags > 0),
  remarks TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE raw_material_processing ADD COLUMN IF NOT EXISTS produced_quantity NUMERIC(12,3);
ALTER TABLE raw_material_processing ADD COLUMN IF NOT EXISTS produced_unit VARCHAR(5);
UPDATE raw_material_processing
SET produced_quantity = quantity_bags, produced_unit = 'bags'
WHERE produced_quantity IS NULL OR produced_unit IS NULL;
ALTER TABLE feed_purchases ADD COLUMN IF NOT EXISTS processing_id UUID REFERENCES raw_material_processing(id) ON DELETE CASCADE;

CREATE TABLE IF NOT EXISTS raw_material_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  material_id UUID NOT NULL REFERENCES raw_materials(id) ON DELETE RESTRICT,
  transaction_type VARCHAR(30) NOT NULL CHECK (transaction_type IN ('INWARD','OUTWARD_PROCESSING')),
  quantity NUMERIC(12,3) NOT NULL CHECK (quantity > 0),
  unit VARCHAR(30) NOT NULL,
  transaction_date DATE NOT NULL,
  supplier VARCHAR(160),
  rate_per_unit NUMERIC(14,3) CHECK (rate_per_unit IS NULL OR rate_per_unit >= 0),
  total_amount NUMERIC(18,2) CHECK (total_amount IS NULL OR total_amount >= 0),
  remarks TEXT,
  processing_id UUID REFERENCES raw_material_processing(id) ON DELETE CASCADE,
  bill_image_url TEXT,
  bill_number VARCHAR(100),
  vendor_name VARCHAR(150),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE raw_material_logs ADD COLUMN IF NOT EXISTS bill_image_url TEXT;
ALTER TABLE raw_material_logs ADD COLUMN IF NOT EXISTS bill_number VARCHAR(100);
ALTER TABLE raw_material_logs ADD COLUMN IF NOT EXISTS vendor_name VARCHAR(150);
ALTER TABLE raw_material_logs ADD COLUMN IF NOT EXISTS entered_quantity NUMERIC(12,3);
ALTER TABLE raw_material_logs ADD COLUMN IF NOT EXISTS entered_unit VARCHAR(30);
ALTER TABLE raw_material_logs ADD COLUMN IF NOT EXISTS entered_kg_per_unit NUMERIC(12,3);

UPDATE raw_material_logs
SET entered_quantity = quantity, entered_unit = unit
WHERE entered_quantity IS NULL OR entered_unit IS NULL;
UPDATE raw_material_logs l
SET entered_kg_per_unit=COALESCE(u.kg_per_bag,50)
FROM raw_materials m JOIN users u ON u.id=m.owner_id
WHERE l.owner_id=m.owner_id AND l.material_id=m.id
  AND l.entered_unit='bags' AND l.entered_kg_per_unit IS NULL;

UPDATE raw_material_logs l
SET quantity = ROUND(
      l.quantity * CASE l.unit
        WHEN 'quintal' THEN 100
        WHEN 'bags' THEN COALESCE(NULLIF(u.kg_per_bag, 0), 50)
        ELSE 1
      END,
      3
    ),
    unit = 'kg'
FROM raw_materials m
JOIN users u ON u.id = m.owner_id
WHERE l.material_id = m.id AND l.owner_id = m.owner_id AND l.unit <> 'kg';

UPDATE raw_materials m
SET min_alert_threshold = ROUND(
      m.min_alert_threshold * CASE m.unit
        WHEN 'quintal' THEN 100
        WHEN 'bags' THEN COALESCE(NULLIF(u.kg_per_bag, 0), 50)
        ELSE 1
      END,
      3
    ),
    unit = 'kg'
FROM users u
WHERE u.id = m.owner_id AND m.unit <> 'kg';

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM raw_materials
    GROUP BY owner_id, lower(trim(name))
    HAVING COUNT(*) > 1 AND COUNT(DISTINCT unit) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot merge duplicate raw materials with different units; resolve those records before migrating';
  END IF;
  WITH ranked AS (
    SELECT id, (MIN(id::text) OVER (PARTITION BY owner_id, lower(trim(name))))::uuid AS keep_id
    FROM raw_materials
  )
  UPDATE raw_material_logs l
  SET material_id = ranked.keep_id
  FROM ranked
  WHERE l.material_id = ranked.id AND ranked.id <> ranked.keep_id;
  WITH ranked AS (
    SELECT id, (MIN(id::text) OVER (PARTITION BY owner_id, lower(trim(name))))::uuid AS keep_id
    FROM raw_materials
  )
  DELETE FROM raw_materials m
  USING ranked
  WHERE m.id = ranked.id AND ranked.id <> ranked.keep_id;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_materials_owner_name_ci
  ON raw_materials(owner_id, lower(trim(name)));

CREATE TABLE IF NOT EXISTS medicines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  category VARCHAR(20) NOT NULL CHECK (category IN ('Antibiotic','Vitamin','Vaccine','Sanitizer')),
  unit VARCHAR(5) NOT NULL CHECK (unit IN ('L','ml','kg','g')),
  min_alert_level NUMERIC(12,3) NOT NULL DEFAULT 0 CHECK (min_alert_level >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner_id, id)
);

CREATE TABLE IF NOT EXISTS medicine_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  medicine_id UUID NOT NULL REFERENCES medicines(id) ON DELETE RESTRICT,
  batch_number VARCHAR(120) NOT NULL,
  expiry_date DATE NOT NULL,
  received_quantity NUMERIC(12,3) NOT NULL CHECK (received_quantity > 0),
  unit VARCHAR(5) NOT NULL CHECK (unit IN ('L','ml','kg','g')),
  total_cost NUMERIC(14,2) NOT NULL CHECK (total_cost >= 0),
  received_date DATE NOT NULL,
  remarks TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE medicine_batches ADD COLUMN IF NOT EXISTS entered_quantity NUMERIC(12,3);
ALTER TABLE medicine_batches ADD COLUMN IF NOT EXISTS entered_unit VARCHAR(5);
ALTER TABLE medicine_batches ADD COLUMN IF NOT EXISTS rate_per_unit NUMERIC(14,3);
UPDATE medicine_batches
SET entered_quantity=COALESCE(entered_quantity,received_quantity),
    entered_unit=COALESCE(entered_unit,unit),
    rate_per_unit=COALESCE(rate_per_unit,ROUND(total_cost/NULLIF(received_quantity,0),3))
WHERE entered_quantity IS NULL OR entered_unit IS NULL OR rate_per_unit IS NULL;

CREATE TABLE IF NOT EXISTS medicine_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  medicine_id UUID NOT NULL REFERENCES medicines(id) ON DELETE RESTRICT,
  usage_date DATE NOT NULL,
  quantity NUMERIC(12,3) NOT NULL CHECK (quantity > 0),
  unit VARCHAR(5) NOT NULL CHECK (unit IN ('L','ml','kg','g')),
  flock_id UUID NOT NULL REFERENCES flock_batches(id) ON DELETE RESTRICT,
  admin_route VARCHAR(20) NOT NULL CHECK (admin_route IN ('Water','Feed','Spray','Injection')),
  remarks TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS medicine_usage_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  usage_id UUID NOT NULL REFERENCES medicine_usage(id) ON DELETE CASCADE,
  batch_id UUID NOT NULL REFERENCES medicine_batches(id) ON DELETE RESTRICT,
  quantity NUMERIC(12,3) NOT NULL CHECK (quantity > 0)
);

CREATE TABLE IF NOT EXISTS medicine_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  medicine_id UUID NOT NULL REFERENCES medicines(id) ON DELETE RESTRICT,
  event_type VARCHAR(10) NOT NULL CHECK (event_type IN ('INWARD','USED')),
  quantity NUMERIC(12,3) NOT NULL CHECK (quantity > 0),
  unit VARCHAR(5) NOT NULL CHECK (unit IN ('L','ml','kg','g')),
  flock_id UUID REFERENCES flock_batches(id) ON DELETE RESTRICT,
  admin_route VARCHAR(20) CHECK (admin_route IS NULL OR admin_route IN ('Water','Feed','Spray','Injection')),
  log_date DATE NOT NULL,
  remarks TEXT,
  batch_id UUID REFERENCES medicine_batches(id) ON DELETE RESTRICT,
  usage_id UUID REFERENCES medicine_usage(id) ON DELETE CASCADE,
  bill_image_url TEXT,
  bill_number VARCHAR(100),
  vendor_name VARCHAR(150),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (event_type='INWARD' AND batch_id IS NOT NULL AND usage_id IS NULL AND flock_id IS NULL AND admin_route IS NULL)
    OR
    (event_type='USED' AND usage_id IS NOT NULL AND batch_id IS NULL AND flock_id IS NOT NULL AND admin_route IS NOT NULL)
  )
);

ALTER TABLE medicine_logs ADD COLUMN IF NOT EXISTS bill_image_url TEXT;
ALTER TABLE medicine_logs ADD COLUMN IF NOT EXISTS bill_number VARCHAR(100);
ALTER TABLE medicine_logs ADD COLUMN IF NOT EXISTS vendor_name VARCHAR(150);

CREATE UNIQUE INDEX IF NOT EXISTS idx_medicine_logs_batch
  ON medicine_logs(owner_id,batch_id) WHERE batch_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_medicine_logs_usage
  ON medicine_logs(owner_id,usage_id) WHERE usage_id IS NOT NULL;

INSERT INTO medicine_logs
  (owner_id,medicine_id,event_type,quantity,unit,log_date,remarks,batch_id,created_at)
SELECT b.owner_id,b.medicine_id,'INWARD',b.received_quantity,b.unit,b.received_date,b.remarks,b.id,b.created_at
FROM medicine_batches b
ON CONFLICT DO NOTHING;

INSERT INTO medicine_logs
  (owner_id,medicine_id,event_type,quantity,unit,flock_id,admin_route,log_date,remarks,usage_id,created_at)
SELECT u.owner_id,u.medicine_id,'USED',u.quantity,u.unit,u.flock_id,u.admin_route,u.usage_date,u.remarks,u.id,u.created_at
FROM medicine_usage u
ON CONFLICT DO NOTHING;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM medicines
    GROUP BY owner_id, lower(trim(name))
    HAVING COUNT(*) > 1 AND (COUNT(DISTINCT unit) > 1 OR COUNT(DISTINCT category) > 1)
  ) THEN
    RAISE EXCEPTION 'Cannot merge duplicate medicines with different categories or units; resolve those records before migrating';
  END IF;
  WITH ranked AS (
    SELECT id, (MIN(id::text) OVER (PARTITION BY owner_id, lower(trim(name))))::uuid AS keep_id
    FROM medicines
  )
  UPDATE medicine_batches b
  SET medicine_id = ranked.keep_id
  FROM ranked
  WHERE b.medicine_id = ranked.id AND ranked.id <> ranked.keep_id;
  WITH ranked AS (
    SELECT id, (MIN(id::text) OVER (PARTITION BY owner_id, lower(trim(name))))::uuid AS keep_id
    FROM medicines
  )
  UPDATE medicine_usage u
  SET medicine_id = ranked.keep_id
  FROM ranked
  WHERE u.medicine_id = ranked.id AND ranked.id <> ranked.keep_id;
  WITH ranked AS (
    SELECT id, (MIN(id::text) OVER (PARTITION BY owner_id, lower(trim(name))))::uuid AS keep_id
    FROM medicines
  )
  UPDATE medicine_logs l
  SET medicine_id = ranked.keep_id
  FROM ranked
  WHERE l.medicine_id = ranked.id AND ranked.id <> ranked.keep_id;
  WITH ranked AS (
    SELECT id, (MIN(id::text) OVER (PARTITION BY owner_id, lower(trim(name))))::uuid AS keep_id
    FROM medicines
  )
  DELETE FROM medicines m
  USING ranked
  WHERE m.id = ranked.id AND ranked.id <> ranked.keep_id;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_medicines_owner_name_ci
  ON medicines(owner_id, lower(trim(name)));

CREATE TABLE IF NOT EXISTS feed_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  batch_id UUID REFERENCES flock_batches(id) ON DELETE SET NULL,
  usage_date DATE NOT NULL,
  quantity NUMERIC(12,2) NOT NULL CHECK (quantity > 0),
  unit VARCHAR(5) NOT NULL CHECK (unit IN ('bags','kg')),
  bags_equivalent NUMERIC(12,3) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS feed_preparations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  feed_product_id UUID NOT NULL REFERENCES feed_products(id) ON DELETE RESTRICT,
  preparation_date DATE NOT NULL,
  total_quantity_kg NUMERIC(12,3) NOT NULL CHECK (total_quantity_kg > 0),
  remarks TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS feed_preparation_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  preparation_id UUID NOT NULL REFERENCES feed_preparations(id) ON DELETE CASCADE,
  feed_product_id UUID REFERENCES feed_products(id) ON DELETE RESTRICT,
  raw_material_id UUID REFERENCES raw_materials(id) ON DELETE RESTRICT,
  source_type VARCHAR(20) NOT NULL DEFAULT 'feed',
  quantity_kg NUMERIC(12,3) NOT NULL CHECK (quantity_kg > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE feed_preparation_items ALTER COLUMN feed_product_id DROP NOT NULL;
ALTER TABLE feed_preparation_items ADD COLUMN IF NOT EXISTS raw_material_id UUID REFERENCES raw_materials(id) ON DELETE RESTRICT;
ALTER TABLE feed_preparation_items ADD COLUMN IF NOT EXISTS source_type VARCHAR(20) NOT NULL DEFAULT 'feed';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='feed_preparation_items_source_check') THEN
    ALTER TABLE feed_preparation_items ADD CONSTRAINT feed_preparation_items_source_check
      CHECK (
        (source_type='feed' AND feed_product_id IS NOT NULL AND raw_material_id IS NULL)
        OR (source_type='raw_material' AND raw_material_id IS NOT NULL AND feed_product_id IS NULL)
      );
  END IF;
END $$;

ALTER TABLE feed_usage ADD COLUMN IF NOT EXISTS feed_type VARCHAR(120);
ALTER TABLE feed_usage ALTER COLUMN quantity TYPE NUMERIC(12,3);
ALTER TABLE feed_usage ALTER COLUMN bags_equivalent TYPE NUMERIC(12,5);
ALTER TABLE feed_purchases ADD COLUMN IF NOT EXISTS feed_product_id UUID REFERENCES feed_products(id) ON DELETE CASCADE;
ALTER TABLE feed_usage ADD COLUMN IF NOT EXISTS feed_product_id UUID REFERENCES feed_products(id) ON DELETE CASCADE;
ALTER TABLE feed_usage ADD COLUMN IF NOT EXISTS remarks TEXT;
ALTER TABLE feed_usage ADD COLUMN IF NOT EXISTS preparation_id UUID REFERENCES feed_preparations(id) ON DELETE CASCADE;
ALTER TABLE feed_purchases ADD COLUMN IF NOT EXISTS preparation_id UUID REFERENCES feed_preparations(id) ON DELETE CASCADE;
ALTER TABLE raw_material_logs ADD COLUMN IF NOT EXISTS preparation_id UUID REFERENCES feed_preparations(id) ON DELETE CASCADE;

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
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  batch_id UUID REFERENCES flock_batches(id) ON DELETE SET NULL,
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
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invoice_year INT NOT NULL DEFAULT EXTRACT(YEAR FROM CURRENT_DATE)::int,
  invoice_seq INT NOT NULL,
  invoice_no VARCHAR(30) NOT NULL,
  invoice_type VARCHAR(20) NOT NULL CHECK (invoice_type IN ('egg_sale','spent_hen_sale','poultry_manure_sale','feed_trade')),
  customer_name VARCHAR(160) NOT NULL,
  customer_mobile VARCHAR(20),
  invoice_date DATE NOT NULL,
  subtotal NUMERIC(18,2) NOT NULL,
  tax_percent NUMERIC(5,2) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  grand_total NUMERIC(18,2) NOT NULL,
  payment_status TEXT NOT NULL DEFAULT 'unpaid',
  paid_at TIMESTAMPTZ,
  notes TEXT,
  share_token UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner_id, invoice_year, invoice_seq)
);

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'unpaid';
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS customer_id UUID;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS paid_amount NUMERIC(18,2) NOT NULL DEFAULT 0;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='invoices_payment_status_check') THEN
    ALTER TABLE invoices ADD CONSTRAINT invoices_payment_status_check
      CHECK (payment_status IN ('paid','unpaid'));
  END IF;
END $$;

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS invoice_year INT;
UPDATE invoices
SET invoice_year = COALESCE(NULLIF(substring(invoice_no from '^INV-([0-9]{4})-'), '')::int, EXTRACT(YEAR FROM created_at)::int)
WHERE invoice_year IS NULL;
ALTER TABLE invoices ALTER COLUMN invoice_year SET NOT NULL;
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_owner_id_invoice_seq_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_owner_year_seq ON invoices(owner_id, invoice_year, invoice_seq);

CREATE TABLE IF NOT EXISTS invoice_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  description VARCHAR(255) NOT NULL,
  quantity NUMERIC(12,2) NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC(12,2) NOT NULL CHECK (unit_price >= 0),
  amount NUMERIC(18,2) NOT NULL,
  egg_quantity INT CHECK (egg_quantity IS NULL OR egg_quantity > 0),
  sale_unit VARCHAR(24) CHECK (sale_unit IS NULL OR sale_unit IN ('bag','tractor_trolley','ton'))
);

CREATE TABLE IF NOT EXISTS customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(owner_id, phone),
  UNIQUE(owner_id, id)
);

ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_customer_id_fkey;
ALTER TABLE invoices ADD CONSTRAINT invoices_customer_id_fkey
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS customer_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  invoice_id UUID REFERENCES invoices(id) ON DELETE SET NULL,
  amount_paid NUMERIC(18,2) NOT NULL CHECK (amount_paid > 0),
  payment_mode TEXT NOT NULL DEFAULT 'Cash'
    CHECK (payment_mode IN ('Cash','UPI / Online','Bank Transfer')),
  note TEXT,
  payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customers_owner_name ON customers(owner_id, lower(name));
CREATE INDEX IF NOT EXISTS idx_customer_payments_owner_customer_date
  ON customer_payments(owner_id, customer_id, payment_date DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_customer_payments_invoice ON customer_payments(owner_id, invoice_id);

INSERT INTO customers(owner_id,name,phone)
SELECT DISTINCT ON (i.owner_id, regexp_replace(i.customer_mobile,'\D','','g'))
       i.owner_id, i.customer_name, regexp_replace(i.customer_mobile,'\D','','g')
FROM invoices i
WHERE i.customer_mobile IS NOT NULL
  AND length(regexp_replace(i.customer_mobile,'\D','','g'))=10
ORDER BY i.owner_id, regexp_replace(i.customer_mobile,'\D','','g'), i.created_at DESC
ON CONFLICT(owner_id,phone) DO UPDATE SET name=EXCLUDED.name;

UPDATE invoices i SET customer_id=c.id
FROM customers c
WHERE i.owner_id=c.owner_id
  AND regexp_replace(COALESCE(i.customer_mobile,''),'\D','','g')=c.phone
  AND i.customer_id IS NULL;

UPDATE invoices
SET paid_amount=CASE WHEN payment_status='paid' THEN grand_total ELSE 0 END
WHERE paid_amount=0 AND payment_status='paid';

INSERT INTO customer_payments(owner_id,customer_id,invoice_id,amount_paid,payment_mode,note,payment_date)
SELECT i.owner_id,i.customer_id,i.id,i.grand_total,'Cash','Opening balance: previously marked paid',COALESCE(i.paid_at::date,i.invoice_date)
FROM invoices i
WHERE i.customer_id IS NOT NULL AND i.payment_status='paid'
  AND i.grand_total > 0
  AND NOT EXISTS (
    SELECT 1 FROM customer_payments p
    WHERE p.owner_id=i.owner_id AND p.invoice_id=i.id
  );

DO $$
DECLARE
  payment_row RECORD;
  invoice_row RECORD;
  remaining_amount NUMERIC(18,2);
  applied_amount NUMERIC(18,2);
  first_allocation BOOLEAN;
  updated_paid NUMERIC(18,2);
BEGIN
  FOR payment_row IN
    SELECT * FROM customer_payments
    WHERE invoice_id IS NULL
    ORDER BY owner_id,customer_id,created_at,id
    FOR UPDATE
  LOOP
    remaining_amount := payment_row.amount_paid;
    first_allocation := TRUE;

    LOOP
      SELECT id,grand_total,paid_amount
      INTO invoice_row
      FROM invoices
      WHERE owner_id=payment_row.owner_id
        AND customer_id=payment_row.customer_id
        AND paid_amount < grand_total
      ORDER BY invoice_date,created_at,id
      LIMIT 1
      FOR UPDATE;

      EXIT WHEN NOT FOUND OR remaining_amount <= 0;
      applied_amount := LEAST(remaining_amount,invoice_row.grand_total-invoice_row.paid_amount);
      updated_paid := invoice_row.paid_amount + applied_amount;

      UPDATE invoices SET
        paid_amount=updated_paid,
        payment_status=CASE WHEN updated_paid >= grand_total THEN 'paid' ELSE 'unpaid' END,
        paid_at=CASE WHEN updated_paid >= grand_total THEN COALESCE(paid_at,NOW()) ELSE NULL END
      WHERE id=invoice_row.id;

      IF first_allocation THEN
        UPDATE customer_payments SET
          invoice_id=invoice_row.id,
          amount_paid=applied_amount
        WHERE id=payment_row.id;
        first_allocation := FALSE;
      ELSE
        INSERT INTO customer_payments
          (owner_id,customer_id,invoice_id,amount_paid,payment_mode,note,payment_date,created_at)
        VALUES
          (payment_row.owner_id,payment_row.customer_id,invoice_row.id,applied_amount,
           payment_row.payment_mode,payment_row.note,payment_row.payment_date,payment_row.created_at);
      END IF;

      remaining_amount := remaining_amount - applied_amount;
    END LOOP;

    IF NOT first_allocation AND remaining_amount > 0 THEN
      INSERT INTO customer_payments
        (owner_id,customer_id,invoice_id,amount_paid,payment_mode,note,payment_date,created_at)
      VALUES
        (payment_row.owner_id,payment_row.customer_id,NULL,remaining_amount,
         payment_row.payment_mode,payment_row.note,payment_row.payment_date,payment_row.created_at);
    END IF;
  END LOOP;
END $$;

WITH latest_invoice AS (
  SELECT DISTINCT ON (i.owner_id, regexp_replace(i.customer_mobile,'\D','','g'))
         i.owner_id,
         regexp_replace(i.customer_mobile,'\D','','g') AS phone,
         trim(i.customer_name) AS name
  FROM invoices i
  WHERE i.customer_mobile IS NOT NULL
    AND length(regexp_replace(i.customer_mobile,'\D','','g'))=10
    AND trim(COALESCE(i.customer_name,''))<>''
  ORDER BY i.owner_id, regexp_replace(i.customer_mobile,'\D','','g'),
           i.created_at DESC, i.id DESC
)
UPDATE customers c SET name=li.name
FROM latest_invoice li
WHERE c.owner_id=li.owner_id AND c.phone=li.phone
  AND c.name IS DISTINCT FROM li.name;

DELETE FROM customers c
WHERE NOT EXISTS (
  SELECT 1 FROM invoices i
  WHERE i.owner_id=c.owner_id AND i.customer_id=c.id
)
AND NOT EXISTS (
  SELECT 1 FROM customer_payments p
  WHERE p.owner_id=c.owner_id AND p.customer_id=c.id
);

ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS egg_quantity INT;
ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS egg_unit VARCHAR(10);
ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS sale_unit VARCHAR(24);
UPDATE invoice_items it
SET egg_quantity = CASE
  WHEN lower(it.description) ~ '(crate|tray)' THEN round(it.quantity * 30)::int
  ELSE round(it.quantity)::int
END
FROM invoices i
WHERE i.id = it.invoice_id AND i.owner_id = it.owner_id AND i.invoice_type = 'egg_sale'
  AND it.egg_quantity IS NULL;

UPDATE invoice_items it
SET egg_unit = CASE
  WHEN it.egg_quantity = round(it.quantity * 30)::int AND lower(it.description) ~ 'tray' THEN 'tray'
  WHEN it.egg_quantity = round(it.quantity * 30)::int THEN 'crate'
  WHEN it.egg_quantity = round(it.quantity)::int THEN 'eggs'
  ELSE NULL
END
FROM invoices i
WHERE i.id = it.invoice_id AND i.owner_id = it.owner_id AND i.invoice_type = 'egg_sale'
  AND it.egg_unit IS NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoice_items_egg_unit_check') THEN
    ALTER TABLE invoice_items ADD CONSTRAINT invoice_items_egg_unit_check
      CHECK (egg_unit IS NULL OR egg_unit IN ('eggs','crate','tray'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoice_items_sale_unit_check') THEN
    ALTER TABLE invoice_items ADD CONSTRAINT invoice_items_sale_unit_check
      CHECK (sale_unit IS NULL OR sale_unit IN ('bag','tractor_trolley','ton'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS farm_expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN (
    'farm_labour_salary',
    'feed_truck_unloading_hamali',
    'feed_mill_expense',
    'electricity_water',
    'transport_diesel',
    'other_farm_expense'
  )),
  person_or_vendor TEXT,
  description TEXT NOT NULL,
  workers_count INT CHECK (workers_count IS NULL OR workers_count > 0),
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  payment_mode TEXT NOT NULL DEFAULT 'Cash'
    CHECK (payment_mode IN ('Cash','UPI / Online','Bank Transfer')),
  expense_date DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE raw_material_logs
  ALTER COLUMN total_amount TYPE NUMERIC(18,2) USING total_amount::numeric(18,2);
ALTER TABLE invoices
  ALTER COLUMN subtotal TYPE NUMERIC(18,2) USING subtotal::numeric(18,2),
  ALTER COLUMN tax_amount TYPE NUMERIC(18,2) USING tax_amount::numeric(18,2),
  ALTER COLUMN grand_total TYPE NUMERIC(18,2) USING grand_total::numeric(18,2),
  ALTER COLUMN paid_amount TYPE NUMERIC(18,2) USING paid_amount::numeric(18,2);
ALTER TABLE invoice_items
  ALTER COLUMN amount TYPE NUMERIC(18,2) USING amount::numeric(18,2);
ALTER TABLE customer_payments
  ALTER COLUMN amount_paid TYPE NUMERIC(18,2) USING amount_paid::numeric(18,2);
ALTER TABLE farm_expenses
  ALTER COLUMN amount TYPE NUMERIC(18,2) USING amount::numeric(18,2);

CREATE INDEX IF NOT EXISTS idx_flock_owner ON flock_batches(owner_id, arrival_date DESC);
CREATE INDEX IF NOT EXISTS idx_mort_owner ON mortality_logs(owner_id, log_date DESC);
CREATE INDEX IF NOT EXISTS idx_mort_batch ON mortality_logs(batch_id);
CREATE INDEX IF NOT EXISTS idx_feedp_owner ON feed_purchases(owner_id, delivery_date DESC);
CREATE INDEX IF NOT EXISTS idx_feedp_product ON feed_purchases(owner_id, feed_product_id, delivery_date DESC);
CREATE INDEX IF NOT EXISTS idx_raw_processing_feed_product ON raw_material_processing(feed_product_id);
DROP INDEX IF EXISTS idx_raw_material_tx_owner_date;
DROP INDEX IF EXISTS idx_raw_material_tx_material;
CREATE INDEX IF NOT EXISTS idx_raw_material_logs_owner_date ON raw_material_logs(owner_id, transaction_date DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_raw_material_logs_material ON raw_material_logs(owner_id, material_id, transaction_date DESC);
CREATE INDEX IF NOT EXISTS idx_raw_material_logs_processing ON raw_material_logs(processing_id);
CREATE INDEX IF NOT EXISTS idx_raw_material_processing_owner_date ON raw_material_processing(owner_id, processing_date DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_medicine_batches_owner_item_expiry ON medicine_batches(owner_id, medicine_id, expiry_date);
CREATE INDEX IF NOT EXISTS idx_medicine_usage_owner_date ON medicine_usage(owner_id, usage_date DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_medicine_usage_flock ON medicine_usage(flock_id);
CREATE INDEX IF NOT EXISTS idx_medicine_usage_alloc_batch ON medicine_usage_allocations(owner_id, batch_id);
CREATE INDEX IF NOT EXISTS idx_medicine_usage_alloc_usage ON medicine_usage_allocations(usage_id);
CREATE INDEX IF NOT EXISTS idx_medicine_logs_owner_date ON medicine_logs(owner_id, log_date DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_medicine_logs_item ON medicine_logs(owner_id, medicine_id, log_date DESC);
CREATE INDEX IF NOT EXISTS idx_medicine_logs_flock ON medicine_logs(flock_id);
CREATE INDEX IF NOT EXISTS idx_feedu_owner ON feed_usage(owner_id, usage_date DESC);
CREATE INDEX IF NOT EXISTS idx_feedu_owner_type ON feed_usage(owner_id, lower(trim(feed_type)));
CREATE INDEX IF NOT EXISTS idx_feedu_product ON feed_usage(owner_id, feed_product_id, usage_date DESC);
CREATE INDEX IF NOT EXISTS idx_feedu_batch ON feed_usage(batch_id);
CREATE INDEX IF NOT EXISTS idx_feed_preparations_owner_date ON feed_preparations(owner_id, preparation_date DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_feed_preparation_items_batch ON feed_preparation_items(owner_id, preparation_id);
CREATE INDEX IF NOT EXISTS idx_raw_material_logs_preparation ON raw_material_logs(owner_id, preparation_id);
CREATE INDEX IF NOT EXISTS idx_egg_owner ON egg_production(owner_id, collection_date DESC);
CREATE INDEX IF NOT EXISTS idx_egg_batch ON egg_production(batch_id);
CREATE INDEX IF NOT EXISTS idx_inv_owner ON invoices(owner_id, invoice_date DESC);
CREATE INDEX IF NOT EXISTS idx_inv_created_owner ON invoices(owner_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_invitems_inv ON invoice_items(invoice_id);
CREATE INDEX IF NOT EXISTS idx_invitems_owner_invoice ON invoice_items(owner_id, invoice_id);
CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices(owner_id, customer_id, invoice_date DESC);
CREATE INDEX IF NOT EXISTS idx_farm_expenses_owner_date ON farm_expenses(owner_id, expense_date DESC, created_at DESC);

-- Row-Level-Security ready: policies key off the session setting app.owner_id.
-- The API connects as the table owner (bypasses RLS) and filters by owner_id in every query.
-- To enforce RLS in the DB too, connect as a non-owner role and run
--   SELECT set_config('app.owner_id', '<id>', true);  at the start of each transaction.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['flock_batches','mortality_logs','feed_products','feed_purchases','feed_usage','feed_preparations','feed_preparation_items','egg_production','invoices','invoice_items','farm_expenses','customers','customer_payments','raw_materials','raw_material_processing','raw_material_logs','medicines','medicine_batches','medicine_usage','medicine_usage_allocations','medicine_logs']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (owner_id = NULLIF(current_setting(''app.owner_id'', true), '''')::UUID)', t);
  END LOOP;
END $$;

-- A user account may own multiple independent farm units. Existing profile
-- fields are copied to the primary farm so current accounts remain unchanged.
CREATE TABLE IF NOT EXISTS farms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(160) NOT NULL,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  avatar_url TEXT,
  signature_url TEXT,
  payment_qr_url TEXT,
  address TEXT,
  low_stock_threshold NUMERIC(10,2) NOT NULL DEFAULT 10,
  kg_per_bag NUMERIC(10,2) NOT NULL DEFAULT 50,
  default_tax_percent NUMERIC(5,2) NOT NULL DEFAULT 0,
  eggs_per_tray INT NOT NULL DEFAULT 30 CHECK (eggs_per_tray > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE farms ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE farms ADD COLUMN IF NOT EXISTS name VARCHAR(160);
ALTER TABLE farms ADD COLUMN IF NOT EXISTS is_primary BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE farms ADD COLUMN IF NOT EXISTS avatar_url TEXT;
ALTER TABLE farms ADD COLUMN IF NOT EXISTS signature_url TEXT;
ALTER TABLE farms ADD COLUMN IF NOT EXISTS payment_qr_url TEXT;
ALTER TABLE farms ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE farms ADD COLUMN IF NOT EXISTS low_stock_threshold NUMERIC(10,2) NOT NULL DEFAULT 10;
ALTER TABLE farms ADD COLUMN IF NOT EXISTS kg_per_bag NUMERIC(10,2) NOT NULL DEFAULT 50;
ALTER TABLE farms ADD COLUMN IF NOT EXISTS default_tax_percent NUMERIC(5,2) NOT NULL DEFAULT 0;
ALTER TABLE farms ADD COLUMN IF NOT EXISTS eggs_per_tray INT NOT NULL DEFAULT 30;
ALTER TABLE farms ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Compatibility with installations that already have a legacy farms table.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='users' AND column_name='farm_id'
  ) THEN
    EXECUTE 'UPDATE farms f SET owner_user_id=u.id, is_primary=TRUE
             FROM users u WHERE u.farm_id=f.id AND f.owner_user_id IS NULL';
  END IF;
END $$;

INSERT INTO farms (
  owner_user_id,name,is_primary,avatar_url,signature_url,payment_qr_url,address,
  low_stock_threshold,kg_per_bag,default_tax_percent,eggs_per_tray
)
SELECT u.id,u.farm_name,TRUE,u.avatar_url,u.signature_url,u.payment_qr_url,u.address,
       u.low_stock_threshold,u.kg_per_bag,u.default_tax_percent,u.eggs_per_tray
FROM users u
WHERE NOT EXISTS (SELECT 1 FROM farms f WHERE f.owner_user_id=u.id);

UPDATE farms SET name='Farm' WHERE name IS NULL OR trim(name)='';
WITH ranked_farms AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY owner_user_id
           ORDER BY is_primary DESC, created_at, id
         ) AS position
  FROM farms
)
UPDATE farms f SET is_primary=(r.position=1)
FROM ranked_farms r
WHERE f.id=r.id AND f.is_primary IS DISTINCT FROM (r.position=1);
ALTER TABLE farms ALTER COLUMN owner_user_id SET NOT NULL;
ALTER TABLE farms ALTER COLUMN name SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_farms_owner_name ON farms(owner_user_id, lower(trim(name)));
CREATE UNIQUE INDEX IF NOT EXISTS idx_farms_single_primary ON farms(owner_user_id) WHERE is_primary;
CREATE INDEX IF NOT EXISTS idx_farms_owner ON farms(owner_user_id, created_at, id);

-- Add and backfill the farm key on every owner-scoped business table.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'flock_batches','mortality_logs','feed_products','feed_purchases','feed_usage',
    'feed_preparations','feed_preparation_items','egg_production','invoices',
    'invoice_items','farm_expenses','customers','customer_payments','raw_materials',
    'raw_material_processing','raw_material_logs','medicines','medicine_batches',
    'medicine_usage','medicine_usage_allocations','medicine_logs'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS farm_id UUID REFERENCES farms(id) ON DELETE CASCADE', t);
    EXECUTE format(
      'UPDATE %I b SET farm_id=f.id FROM farms f
       WHERE b.owner_id=f.owner_user_id AND f.is_primary AND b.farm_id IS NULL', t
    );
    EXECUTE format('ALTER TABLE %I ALTER COLUMN farm_id SET NOT NULL', t);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I(farm_id)', 'idx_' || t || '_farm_id', t);
  END LOOP;
END $$;

ALTER TABLE feed_products ALTER COLUMN farm_id DROP NOT NULL;

-- Uniqueness is farm-local, not account-wide.
ALTER TABLE feed_products DROP CONSTRAINT IF EXISTS feed_products_owner_id_name_key;
DROP INDEX IF EXISTS idx_feed_products_owner_name_ci;
DO $$
DECLARE
  child_table TEXT;
BEGIN
  BEGIN
    LOCK TABLE feed_products IN SHARE ROW EXCLUSIVE MODE;
    DROP TABLE IF EXISTS pg_temp.feed_product_duplicate_map;
    CREATE TEMP TABLE feed_product_duplicate_map AS
    SELECT product.id AS duplicate_id, canonical.id AS canonical_id
    FROM feed_products product
    JOIN LATERAL (
      SELECT candidate.id
      FROM feed_products candidate
      WHERE candidate.farm_id IS NOT NULL
        AND candidate.farm_id IS NOT DISTINCT FROM product.farm_id
        AND lower(trim(candidate.name))=lower(trim(product.name))
      ORDER BY candidate.ctid DESC
      LIMIT 1
    ) canonical ON TRUE
    WHERE product.farm_id IS NOT NULL
      AND product.id<>canonical.id;

    FOREACH child_table IN ARRAY ARRAY[
      'feed_purchases','feed_usage','feed_preparations',
      'feed_preparation_items','raw_material_processing'
    ] LOOP
      IF to_regclass(format('public.%I',child_table)) IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name=child_table
            AND column_name='feed_product_id'
        ) THEN
        EXECUTE format(
          'UPDATE public.%I child
           SET feed_product_id=duplicates.canonical_id
           FROM pg_temp.feed_product_duplicate_map duplicates
           WHERE child.feed_product_id=duplicates.duplicate_id',
          child_table
        );
      END IF;
    END LOOP;

    DELETE FROM feed_products a
    USING feed_products b
    WHERE a.ctid < b.ctid
      AND a.farm_id IS NOT NULL
      AND a.farm_id IS NOT DISTINCT FROM b.farm_id
      AND lower(trim(a.name))=lower(trim(b.name));

    BEGIN
      CREATE UNIQUE INDEX IF NOT EXISTS idx_feed_products_farm_name_ci
        ON feed_products(farm_id, lower(trim(name)));
    EXCEPTION WHEN unique_violation THEN
      RAISE WARNING 'Could not create idx_feed_products_farm_name_ci: %', SQLERRM;
    END;
    DROP TABLE pg_temp.feed_product_duplicate_map;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '%', SQLERRM;
  END;
END $$;

DROP INDEX IF EXISTS idx_raw_materials_owner_name_ci;
DROP INDEX IF EXISTS idx_medicines_owner_name_ci;
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_owner_id_invoice_year_invoice_seq_key;
DROP INDEX IF EXISTS idx_invoices_owner_year_seq;
ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_owner_id_phone_key;
DO $$
BEGIN
  BEGIN
    CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_materials_farm_name_ci
      ON raw_materials(farm_id, lower(trim(name)));
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '%', SQLERRM;
  END;
  BEGIN
    CREATE UNIQUE INDEX IF NOT EXISTS idx_medicines_farm_name_ci
      ON medicines(farm_id, lower(trim(name)));
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '%', SQLERRM;
  END;
  BEGIN
    CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_farm_year_seq
      ON invoices(farm_id, invoice_year, invoice_seq);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '%', SQLERRM;
  END;
  BEGIN
    CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_farm_phone
      ON customers(owner_id, farm_id, phone);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '%', SQLERRM;
  END;
END $$;

CREATE OR REPLACE FUNCTION set_business_row_farm() RETURNS TRIGGER AS $$
DECLARE
  context_owner UUID := NULLIF(current_setting('app.owner_id', true), '')::UUID;
  context_farm UUID := NULLIF(current_setting('app.farm_id', true), '')::UUID;
BEGIN
  IF context_owner IS NULL OR context_farm IS NULL THEN
    RAISE EXCEPTION 'A specific farm context is required for business writes'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.owner_id <> context_owner THEN
    RAISE EXCEPTION 'Business row owner does not match request owner'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.farm_id IS NOT NULL AND NEW.farm_id <> context_farm THEN
    RAISE EXCEPTION 'Business row farm does not match selected farm'
      USING ERRCODE = '42501';
  END IF;
  NEW.farm_id := context_farm;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'flock_batches','mortality_logs','feed_products','feed_purchases','feed_usage',
    'feed_preparations','feed_preparation_items','egg_production','invoices',
    'invoice_items','farm_expenses','customers','customer_payments','raw_materials',
    'raw_material_processing','raw_material_logs','medicines','medicine_batches',
    'medicine_usage','medicine_usage_allocations','medicine_logs'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS business_row_farm ON %I', t);
    EXECUTE format(
      'CREATE TRIGGER business_row_farm BEFORE INSERT OR UPDATE ON %I
       FOR EACH ROW EXECUTE FUNCTION set_business_row_farm()', t
    );
  END LOOP;
END $$;

-- Keep the existing owner RLS boundary and add the selected farm set. FORCE
-- ensures a table-owning connection is also subject to tenant policies.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'flock_batches','mortality_logs','feed_products','feed_purchases','feed_usage',
    'feed_preparations','feed_preparation_items','egg_production','invoices',
    'invoice_items','farm_expenses','customers','customer_payments','raw_materials',
    'raw_material_processing','raw_material_logs','medicines','medicine_batches',
    'medicine_usage','medicine_usage_allocations','medicine_logs'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (
         owner_id = NULLIF(current_setting(''app.owner_id'', true), '''')::UUID
         AND farm_id = ANY(string_to_array(
           NULLIF(current_setting(''app.farm_ids'', true), ''''), '',''
         )::UUID[])
       ) WITH CHECK (
         owner_id = NULLIF(current_setting(''app.owner_id'', true), '''')::UUID
         AND farm_id = ANY(string_to_array(
           NULLIF(current_setting(''app.farm_ids'', true), ''''), '',''
         )::UUID[])
       )', t
    );
  END LOOP;
END $$;

-- The legacy user trigger seeded account-wide products before farms existed.
-- New farms seed their own default product in the application transaction.
DROP TRIGGER IF EXISTS users_create_ready_feed ON users;
DROP FUNCTION IF EXISTS public.create_owner_ready_feed() CASCADE;
DROP FUNCTION IF EXISTS public_invoice_scope(UUID);
DROP POLICY IF EXISTS public_invoice_link ON invoices;
CREATE POLICY public_invoice_link ON invoices FOR SELECT USING (
  id::text = NULLIF(current_setting('app.public_invoice_id', true), '')
  OR share_token::text = NULLIF(current_setting('app.public_invoice_id', true), '')
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='egg_farm_runtime') THEN
    EXECUTE 'CREATE ROLE egg_farm_runtime NOLOGIN NOBYPASSRLS';
  END IF;
  EXECUTE 'ALTER ROLE egg_farm_runtime NOBYPASSRLS';
  IF current_user <> 'egg_farm_runtime' THEN
    EXECUTE format('GRANT egg_farm_runtime TO %I', current_user);
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO egg_farm_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO egg_farm_runtime;
GRANT USAGE,SELECT,UPDATE ON ALL SEQUENCES IN SCHEMA public TO egg_farm_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO egg_farm_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE,SELECT,UPDATE ON SEQUENCES TO egg_farm_runtime;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO schema_migrations(version) VALUES (1) ON CONFLICT DO NOTHING;
