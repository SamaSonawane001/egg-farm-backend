BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

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

ALTER TABLE farms ALTER COLUMN name SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_farms_owner_name
  ON farms(owner_user_id, lower(trim(name)));
CREATE UNIQUE INDEX IF NOT EXISTS idx_farms_single_primary
  ON farms(owner_user_id) WHERE is_primary;
CREATE INDEX IF NOT EXISTS idx_farms_owner
  ON farms(owner_user_id, created_at, id);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='egg_farm_runtime') THEN
    EXECUTE 'GRANT SELECT,INSERT,UPDATE,DELETE ON farms TO egg_farm_runtime';
  END IF;
END $$;

INSERT INTO schema_migrations(version) VALUES (10) ON CONFLICT DO NOTHING;

COMMIT;
