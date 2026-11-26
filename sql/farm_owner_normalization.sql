BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='farms' AND column_name='user_id'
  ) THEN
    EXECUTE $sql$
      UPDATE farms f
      SET name=left(coalesce(nullif(trim(f.name),''),'Farm'),115)
        || ' (unit ' || f.id::text || ')'
      WHERE f.user_id IS NOT NULL
        AND f.owner_user_id::text IS DISTINCT FROM f.user_id::text
        AND EXISTS (SELECT 1 FROM users u WHERE u.id::text=f.user_id::text)
        AND EXISTS (
          SELECT 1 FROM farms other
          WHERE other.id<>f.id
            AND lower(trim(other.name))=lower(trim(f.name))
            AND (
              other.owner_user_id::text=f.user_id::text
              OR (
                other.user_id::text=f.user_id::text
                AND other.id<f.id
              )
            )
        )
    $sql$;
    EXECUTE $sql$
      UPDATE farms f SET is_primary=FALSE
      WHERE f.user_id IS NOT NULL
        AND f.owner_user_id::text IS DISTINCT FROM f.user_id::text
        AND EXISTS (SELECT 1 FROM users u WHERE u.id::text=f.user_id::text)
    $sql$;
    EXECUTE $sql$
      UPDATE farms f SET owner_user_id=u.id
      FROM users u
      WHERE f.user_id::text=u.id::text
        AND f.owner_user_id IS DISTINCT FROM u.id
    $sql$;
  END IF;
END $$;

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

INSERT INTO schema_migrations(version) VALUES (12) ON CONFLICT DO NOTHING;

COMMIT;
