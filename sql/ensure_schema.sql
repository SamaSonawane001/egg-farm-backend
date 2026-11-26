BEGIN;

DROP TRIGGER IF EXISTS users_create_ready_feed ON users;
DROP FUNCTION IF EXISTS public.create_owner_ready_feed() CASCADE;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS farm_name VARCHAR(160),
  ADD COLUMN IF NOT EXISTS address TEXT,
  ADD COLUMN IF NOT EXISTS avatar_url TEXT,
  ADD COLUMN IF NOT EXISTS signature_url TEXT,
  ADD COLUMN IF NOT EXISTS payment_qr_url TEXT,
  ADD COLUMN IF NOT EXISTS consent_accepted BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS consent_version VARCHAR(32) NOT NULL DEFAULT 'v1.0-2027',
  ADD COLUMN IF NOT EXISTS consent_accepted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS failed_login_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS low_stock_threshold NUMERIC(10,2) NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS kg_per_bag NUMERIC(10,2) NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS default_tax_percent NUMERIC(5,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS eggs_per_tray INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS shared_inventory_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS subscription_status VARCHAR(24) NOT NULL DEFAULT 'TRIAL',
  ADD COLUMN IF NOT EXISTS subscription_plan VARCHAR(32) NOT NULL DEFAULT 'FREE_TRIAL',
  ADD COLUMN IF NOT EXISTS subscription_starts_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS subscription_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS subscription_cancelled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS free_invoices_limit INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS subscription_payment_id UUID;

CREATE TABLE IF NOT EXISTS farms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(160),
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  avatar_url TEXT,
  signature_url TEXT,
  payment_qr_url TEXT,
  address TEXT,
  low_stock_threshold NUMERIC(10,2) NOT NULL DEFAULT 10,
  kg_per_bag NUMERIC(10,2) NOT NULL DEFAULT 50,
  default_tax_percent NUMERIC(5,2) NOT NULL DEFAULT 0,
  eggs_per_tray INTEGER NOT NULL DEFAULT 30,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE farms
  ADD COLUMN IF NOT EXISTS id UUID NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS name VARCHAR(160),
  ADD COLUMN IF NOT EXISTS is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS avatar_url TEXT,
  ADD COLUMN IF NOT EXISTS signature_url TEXT,
  ADD COLUMN IF NOT EXISTS payment_qr_url TEXT,
  ADD COLUMN IF NOT EXISTS address TEXT,
  ADD COLUMN IF NOT EXISTS low_stock_threshold NUMERIC(10,2) NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS kg_per_bag NUMERIC(10,2) NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS default_tax_percent NUMERIC(5,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS eggs_per_tray INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='farms' AND column_name='user_id'
  ) THEN
    EXECUTE $sql$
      UPDATE farms f SET owner_user_id=u.id
      FROM users u
      WHERE f.owner_user_id IS NULL AND f.user_id::text=u.id::text
    $sql$;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='users' AND column_name='farm_id'
  ) THEN
    EXECUTE $sql$
      UPDATE farms f SET owner_user_id=u.id, is_primary=TRUE
      FROM users u
      WHERE f.owner_user_id IS NULL AND f.id::text=u.farm_id::text
    $sql$;
  END IF;
END $$;

UPDATE farms f
SET name=COALESCE(NULLIF(BTRIM(f.name),''), NULLIF(BTRIM(u.farm_name),''), 'Farm')
FROM users u
WHERE f.owner_user_id=u.id AND (f.name IS NULL OR BTRIM(f.name)='');

INSERT INTO farms (
  owner_user_id,name,is_primary,avatar_url,signature_url,payment_qr_url,address,
  low_stock_threshold,kg_per_bag,default_tax_percent,eggs_per_tray
)
SELECT u.id,COALESCE(NULLIF(BTRIM(u.farm_name),''),'Farm'),TRUE,u.avatar_url,
       u.signature_url,u.payment_qr_url,u.address,u.low_stock_threshold,
       u.kg_per_bag,u.default_tax_percent,u.eggs_per_tray
FROM users u
WHERE NOT EXISTS (SELECT 1 FROM farms f WHERE f.owner_user_id=u.id);

UPDATE farms SET name='Farm' WHERE name IS NULL OR BTRIM(name)='';

WITH ranked_farms AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY owner_user_id
           ORDER BY is_primary DESC,created_at,id
         ) AS position
  FROM farms
  WHERE owner_user_id IS NOT NULL
)
UPDATE farms f SET is_primary=(r.position=1)
FROM ranked_farms r
WHERE f.id=r.id AND f.is_primary IS DISTINCT FROM (r.position=1);

ALTER TABLE raw_materials
  ADD COLUMN IF NOT EXISTS is_shared_pool BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE raw_material_logs
  ADD COLUMN IF NOT EXISTS is_shared_pool BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE medicines
  ADD COLUMN IF NOT EXISTS is_shared_pool BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE medicine_batches
  ADD COLUMN IF NOT EXISTS is_shared_pool BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE medicine_usage
  ADD COLUMN IF NOT EXISTS is_shared_pool BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS total_cost NUMERIC(18,2) NOT NULL DEFAULT 0;
ALTER TABLE medicine_usage_allocations
  ADD COLUMN IF NOT EXISTS is_shared_pool BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE medicine_logs
  ADD COLUMN IF NOT EXISTS is_shared_pool BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS subscription_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  razorpay_order_id VARCHAR(64) NOT NULL UNIQUE,
  razorpay_payment_id VARCHAR(64),
  razorpay_signature VARCHAR(256),
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  currency VARCHAR(3) NOT NULL DEFAULT 'INR',
  status VARCHAR(24) NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','CAPTURED','FAILED','REFUNDED','DISPUTED')),
  raw_event JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE subscription_payments
  ADD COLUMN IF NOT EXISTS id UUID NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS razorpay_order_id VARCHAR(64),
  ADD COLUMN IF NOT EXISTS razorpay_payment_id VARCHAR(64),
  ADD COLUMN IF NOT EXISTS razorpay_signature VARCHAR(256),
  ADD COLUMN IF NOT EXISTS amount_paise INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS currency VARCHAR(3) NOT NULL DEFAULT 'INR',
  ADD COLUMN IF NOT EXISTS status VARCHAR(24) NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS raw_event JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE UNIQUE INDEX IF NOT EXISTS idx_subscription_payments_payment_id
  ON subscription_payments(razorpay_payment_id)
  WHERE razorpay_payment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_subscription_payments_user_created
  ON subscription_payments(user_id,created_at DESC);

DO $$
DECLARE
  t TEXT;
  rls_enabled BOOLEAN;
  rls_forced BOOLEAN;
  trigger_mode CHAR(1);
  farm_tables TEXT[] := ARRAY[
    'flock_batches','mortality_logs','feed_products','feed_purchases','feed_usage',
    'feed_preparations','feed_preparation_items','egg_production','invoices',
    'invoice_items','farm_expenses','customers','customer_payments','raw_materials',
    'raw_material_processing','raw_material_logs','medicines','medicine_batches',
    'medicine_usage','medicine_usage_allocations','medicine_logs'
  ];
BEGIN
  FOREACH t IN ARRAY farm_tables LOOP
    SELECT relrowsecurity,relforcerowsecurity
    INTO rls_enabled,rls_forced
    FROM pg_class
    WHERE oid=to_regclass(format('public.%I',t));
    IF rls_enabled THEN
      EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY',t);
    END IF;

    SELECT tgenabled INTO trigger_mode
    FROM pg_trigger
    WHERE tgrelid=to_regclass(format('public.%I',t))
      AND tgname='business_row_farm' AND NOT tgisinternal;
    IF trigger_mode IS NOT NULL AND trigger_mode <> 'D' THEN
      EXECUTE format('ALTER TABLE %I DISABLE TRIGGER business_row_farm',t);
    END IF;

    EXECUTE format(
      'ALTER TABLE %I ADD COLUMN IF NOT EXISTS farm_id UUID',
      t
    );
    EXECUTE format(
      'UPDATE %I b SET farm_id=f.id
       FROM farms f
       WHERE b.owner_id=f.owner_user_id AND f.is_primary AND b.farm_id IS NULL',
      t
    );

    IF trigger_mode='O' THEN
      EXECUTE format('ALTER TABLE %I ENABLE TRIGGER business_row_farm',t);
    ELSIF trigger_mode='R' THEN
      EXECUTE format('ALTER TABLE %I ENABLE REPLICA TRIGGER business_row_farm',t);
    ELSIF trigger_mode='A' THEN
      EXECUTE format('ALTER TABLE %I ENABLE ALWAYS TRIGGER business_row_farm',t);
    END IF;

    IF rls_enabled THEN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
      IF rls_forced THEN
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
      ELSE
        EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY',t);
      END IF;
    END IF;

    EXECUTE format('ALTER TABLE %I ALTER COLUMN farm_id SET NOT NULL', t);

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid=to_regclass(format('public.%I',t))
        AND conname=format('%s_farm_id_fkey',t)
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I
         FOREIGN KEY (farm_id) REFERENCES farms(id) ON DELETE CASCADE',
        t, t || '_farm_id_fkey'
      );
    END IF;

    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I(farm_id)',
                   'idx_' || t || '_farm_id',t);
  END LOOP;
END $$;

ALTER TABLE feed_products ALTER COLUMN farm_id DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='users_subscription_status_check'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT users_subscription_status_check
      CHECK (subscription_status IN ('TRIAL','PENDING','ACTIVE','CANCELLED','EXPIRED','REFUNDED'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='users_free_invoices_limit_check'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT users_free_invoices_limit_check
      CHECK (free_invoices_limit >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='users_subscription_payment_fk'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT users_subscription_payment_fk
      FOREIGN KEY (subscription_payment_id)
      REFERENCES subscription_payments(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='subscription_payments_status_check'
  ) THEN
    ALTER TABLE subscription_payments ADD CONSTRAINT subscription_payments_status_check
      CHECK (status IN ('PENDING','CAPTURED','FAILED','REFUNDED','DISPUTED')) NOT VALID;
  END IF;
END $$;

COMMIT;
