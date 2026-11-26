BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='farms' AND column_name='farm_name'
  ) THEN
    EXECUTE $sql$
      UPDATE farms
      SET name=farm_name
      WHERE (name IS NULL OR trim(name)='' OR name='Farm')
        AND farm_name IS NOT NULL AND trim(farm_name)<>''
    $sql$;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='farms' AND column_name='user_id'
  ) THEN
    EXECUTE $sql$
      UPDATE farms legacy
      SET name=left(coalesce(nullif(trim(legacy.name),''),'Farm'),115)
        || ' (unit ' || legacy.id::text || ')'
      WHERE legacy.owner_user_id IS NULL
        AND legacy.user_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM farms existing
          WHERE existing.id<>legacy.id
            AND lower(trim(existing.name))=lower(trim(legacy.name))
            AND (
              existing.owner_user_id::text=legacy.user_id::text
              OR (
                existing.owner_user_id IS NULL
                AND existing.user_id::text=legacy.user_id::text
                AND existing.id<legacy.id
              )
            )
        )
    $sql$;
    EXECUTE $sql$
      UPDATE farms
      SET is_primary=FALSE
      WHERE owner_user_id IS NULL AND user_id IS NOT NULL
    $sql$;
    EXECUTE $sql$
      UPDATE farms f SET owner_user_id=u.id
      FROM users u
      WHERE f.owner_user_id IS NULL
        AND f.user_id::text=u.id::text
    $sql$;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='users' AND column_name='farm_id'
  ) THEN
    EXECUTE $sql$
      UPDATE farms f SET is_primary=FALSE
      FROM users u
      WHERE f.owner_user_id IS NULL
        AND f.id::text=u.farm_id::text
    $sql$;
    EXECUTE $sql$
      UPDATE farms f SET owner_user_id=u.id
      FROM users u
      WHERE f.owner_user_id IS NULL
        AND f.id::text=u.farm_id::text
    $sql$;
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
           ORDER BY is_primary DESC,created_at,id
         ) AS position
  FROM farms
  WHERE owner_user_id IS NOT NULL
)
UPDATE farms f SET is_primary=(r.position=1)
FROM ranked_farms r
WHERE f.id=r.id AND f.is_primary IS DISTINCT FROM (r.position=1);

CREATE UNIQUE INDEX IF NOT EXISTS idx_farms_owner_name
  ON farms(owner_user_id,lower(trim(name)));
CREATE UNIQUE INDEX IF NOT EXISTS idx_farms_single_primary
  ON farms(owner_user_id) WHERE is_primary;
CREATE INDEX IF NOT EXISTS idx_farms_owner
  ON farms(owner_user_id,created_at,id);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='egg_farm_runtime') THEN
    EXECUTE 'GRANT SELECT,INSERT,UPDATE,DELETE ON farms TO egg_farm_runtime';
  END IF;
END $$;

INSERT INTO schema_migrations(version) VALUES (11) ON CONFLICT DO NOTHING;

COMMIT;
