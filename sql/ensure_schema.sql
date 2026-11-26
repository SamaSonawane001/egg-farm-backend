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
DECLARE
  target_table TEXT;
  table_rel REGCLASS;
  item RECORD;
BEGIN
  FOREACH target_table IN ARRAY ARRAY['farms','farm_profiles'] LOOP
    table_rel := to_regclass(format('public.%I',target_table));
    IF table_rel IS NULL THEN
      CONTINUE;
    END IF;

    FOR item IN
      SELECT c.conname
      FROM pg_constraint c
      WHERE c.conrelid=table_rel
        AND c.contype='u'
        AND cardinality(c.conkey)=1
        AND EXISTS (
          SELECT 1 FROM pg_attribute a
          WHERE a.attrelid=c.conrelid
            AND a.attnum=c.conkey[1]
            AND a.attname IN ('owner_id','owner_user_id','user_id')
            AND NOT a.attisdropped
        )
    LOOP
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I',target_table,item.conname);
    END LOOP;

    FOR item IN
      SELECT index_class.relname AS index_name
      FROM pg_index i
      JOIN pg_class index_class ON index_class.oid=i.indexrelid
      JOIN pg_attribute a
        ON a.attrelid=i.indrelid AND a.attnum=i.indkey[0] AND NOT a.attisdropped
      WHERE i.indrelid=table_rel
        AND i.indisunique
        AND NOT i.indisprimary
        AND i.indnkeyatts=1
        AND i.indexprs IS NULL
        AND a.attname IN ('owner_id','owner_user_id','user_id')
        AND NOT EXISTS (
          SELECT 1 FROM pg_constraint c WHERE c.conindid=i.indexrelid
        )
    LOOP
      EXECUTE format('DROP INDEX public.%I',item.index_name);
    END LOOP;
  END LOOP;

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
    WHERE table_schema='public' AND table_name='farms' AND column_name='owner_id'
  ) THEN
    EXECUTE $sql$
      UPDATE farms f SET owner_user_id=u.id
      FROM users u
      WHERE f.owner_user_id IS NULL AND f.owner_id::text=u.id::text
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

DO $$
BEGIN
  BEGIN
    CREATE UNIQUE INDEX IF NOT EXISTS idx_subscription_payments_payment_id
      ON subscription_payments(razorpay_payment_id)
      WHERE razorpay_payment_id IS NOT NULL;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '%', SQLERRM;
  END;
  BEGIN
    CREATE INDEX IF NOT EXISTS idx_subscription_payments_user_created
      ON subscription_payments(user_id,created_at DESC);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '%', SQLERRM;
  END;
END $$;

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

    BEGIN
      EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I(farm_id)',
                     'idx_' || t || '_farm_id',t);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '%', SQLERRM;
    END;
  END LOOP;
END $$;

ALTER TABLE feed_products ALTER COLUMN farm_id DROP NOT NULL;

DO $$
DECLARE
  item RECORD;
  child_table TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version>=12) THEN
  FOR item IN
    SELECT c.conrelid::regclass AS table_name,c.conname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid=c.conrelid
    JOIN pg_namespace schema_namespace ON schema_namespace.oid=t.relnamespace
    WHERE schema_namespace.nspname='public'
      AND c.contype='u'
      AND (
        (t.relname IN ('feed_products','raw_materials','medicines')
          AND cardinality(c.conkey)=2
          AND ARRAY(
            SELECT a.attname::text
            FROM unnest(c.conkey) key(attnum)
            JOIN pg_attribute a
              ON a.attrelid=c.conrelid AND a.attnum=key.attnum
            ORDER BY a.attname::text
          )=ARRAY['name','owner_id']::text[])
        OR (t.relname='invoices'
          AND cardinality(c.conkey)=3
          AND ARRAY(
            SELECT a.attname::text
            FROM unnest(c.conkey) key(attnum)
            JOIN pg_attribute a
              ON a.attrelid=c.conrelid AND a.attnum=key.attnum
            ORDER BY a.attname::text
          )=ARRAY['invoice_seq','invoice_year','owner_id']::text[])
        OR (t.relname='customers'
          AND cardinality(c.conkey)=2
          AND ARRAY(
            SELECT a.attname::text
            FROM unnest(c.conkey) key(attnum)
            JOIN pg_attribute a
              ON a.attrelid=c.conrelid AND a.attnum=key.attnum
            ORDER BY a.attname::text
          )=ARRAY['owner_id','phone']::text[])
      )
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',item.table_name,item.conname);
  END LOOP;

  FOR item IN
    SELECT index_class.relname AS index_name
    FROM pg_index i
    JOIN pg_class table_class ON table_class.oid=i.indrelid
    JOIN pg_namespace schema_namespace ON schema_namespace.oid=table_class.relnamespace
    JOIN pg_class index_class ON index_class.oid=i.indexrelid
    WHERE schema_namespace.nspname='public'
      AND i.indisunique
      AND NOT i.indisprimary
      AND i.indexprs IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM pg_constraint c WHERE c.conindid=i.indexrelid
      )
      AND (
        (table_class.relname IN ('feed_products','raw_materials','medicines')
          AND i.indnkeyatts=2
          AND ARRAY(
            SELECT a.attname::text
            FROM generate_series(0,i.indnkeyatts-1) AS key_position(n)
            JOIN pg_attribute a
              ON a.attrelid=i.indrelid AND a.attnum=i.indkey[key_position.n]
            ORDER BY a.attname::text
          )=ARRAY['name','owner_id']::text[])
        OR (table_class.relname='invoices'
          AND i.indnkeyatts=3
          AND ARRAY(
            SELECT a.attname::text
            FROM generate_series(0,i.indnkeyatts-1) AS key_position(n)
            JOIN pg_attribute a
              ON a.attrelid=i.indrelid AND a.attnum=i.indkey[key_position.n]
            ORDER BY a.attname::text
          )=ARRAY['invoice_seq','invoice_year','owner_id']::text[])
        OR (table_class.relname='customers'
          AND i.indnkeyatts=2
          AND ARRAY(
            SELECT a.attname::text
            FROM generate_series(0,i.indnkeyatts-1) AS key_position(n)
            JOIN pg_attribute a
              ON a.attrelid=i.indrelid AND a.attnum=i.indkey[key_position.n]
            ORDER BY a.attname::text
          )=ARRAY['owner_id','phone']::text[])
      )
  LOOP
    EXECUTE format('DROP INDEX public.%I',item.index_name);
  END LOOP;

  BEGIN
    DROP INDEX IF EXISTS public.idx_feed_products_owner_name_ci;
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

    CREATE UNIQUE INDEX IF NOT EXISTS idx_feed_products_farm_name_ci
      ON feed_products(farm_id,lower(trim(name)));
    DROP TABLE pg_temp.feed_product_duplicate_map;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '%', SQLERRM;
  END;

  BEGIN
    DROP INDEX IF EXISTS public.idx_raw_materials_owner_name_ci;
    DROP INDEX IF EXISTS public.idx_medicines_owner_name_ci;
    DROP INDEX IF EXISTS public.idx_invoices_owner_year_seq;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_materials_local_farm_name_ci
      ON raw_materials(farm_id,lower(trim(name))) WHERE is_shared_pool=FALSE;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_materials_shared_owner_name_ci
      ON raw_materials(owner_id,lower(trim(name))) WHERE is_shared_pool=TRUE;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_medicines_local_farm_name_ci
      ON medicines(farm_id,lower(trim(name))) WHERE is_shared_pool=FALSE;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_medicines_shared_owner_name_ci
      ON medicines(owner_id,lower(trim(name))) WHERE is_shared_pool=TRUE;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_farm_year_seq
      ON invoices(farm_id,invoice_year,invoice_seq);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_farm_phone
      ON customers(owner_id,farm_id,phone);

    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='customers'
        AND column_name='normalized_phone'
    ) THEN
      CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_farm_normalized_phone
        ON customers(farm_id,normalized_phone) WHERE normalized_phone<>'';
    END IF;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_farms_owner_name
      ON farms(owner_user_id,lower(trim(name)));
    CREATE UNIQUE INDEX IF NOT EXISTS idx_farms_single_primary
      ON farms(owner_user_id) WHERE is_primary;
    CREATE INDEX IF NOT EXISTS idx_farms_owner
      ON farms(owner_user_id,created_at,id);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '%', SQLERRM;
  END;
  END IF;
END $$;

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
