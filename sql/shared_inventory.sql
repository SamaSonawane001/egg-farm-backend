BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS shared_inventory_enabled BOOLEAN NOT NULL DEFAULT FALSE;

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

UPDATE medicine_usage u
SET total_cost = COALESCE((
  SELECT ROUND(SUM(a.quantity * b.total_cost / NULLIF(b.received_quantity,0)),2)
  FROM medicine_usage_allocations a
  JOIN medicine_batches b ON b.id=a.batch_id AND b.owner_id=a.owner_id
  WHERE a.owner_id=u.owner_id AND a.usage_id=u.id
),0)
WHERE u.total_cost=0;

DROP INDEX IF EXISTS idx_raw_materials_farm_name_ci;
CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_materials_local_farm_name_ci
  ON raw_materials(farm_id,lower(trim(name))) WHERE is_shared_pool=FALSE;
CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_materials_shared_owner_name_ci
  ON raw_materials(owner_id,lower(trim(name))) WHERE is_shared_pool=TRUE;

DROP INDEX IF EXISTS idx_medicines_farm_name_ci;
CREATE UNIQUE INDEX IF NOT EXISTS idx_medicines_local_farm_name_ci
  ON medicines(farm_id,lower(trim(name))) WHERE is_shared_pool=FALSE;
CREATE UNIQUE INDEX IF NOT EXISTS idx_medicines_shared_owner_name_ci
  ON medicines(owner_id,lower(trim(name))) WHERE is_shared_pool=TRUE;

CREATE OR REPLACE FUNCTION set_business_row_farm() RETURNS TRIGGER AS $$
DECLARE
  context_owner UUID := NULLIF(current_setting('app.owner_id', true), '')::UUID;
  context_farm UUID := NULLIF(current_setting('app.farm_id', true), '')::UUID;
  primary_farm UUID;
  shared_mode BOOLEAN := FALSE;
  shared_row BOOLEAN := FALSE;
BEGIN
  IF context_owner IS NULL OR context_farm IS NULL THEN
    RAISE EXCEPTION 'A specific farm context is required for business writes'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.owner_id <> context_owner THEN
    RAISE EXCEPTION 'Business row owner does not match request owner'
      USING ERRCODE = '42501';
  END IF;

  IF TG_TABLE_NAME IN (
    'raw_materials','raw_material_logs','medicines','medicine_batches',
    'medicine_usage','medicine_usage_allocations','medicine_logs'
  ) THEN
    shared_row := NEW.is_shared_pool;
  END IF;

  IF shared_row THEN
    SELECT u.shared_inventory_enabled,f.id
      INTO shared_mode,primary_farm
    FROM users u
    JOIN farms f ON f.owner_user_id=u.id AND f.is_primary
    WHERE u.id=context_owner
    ORDER BY f.created_at,f.id LIMIT 1;

    IF TG_OP='UPDATE' AND shared_mode
       AND NEW.farm_id IS NOT DISTINCT FROM OLD.farm_id THEN
      RETURN NEW;
    END IF;
    IF NOT COALESCE(shared_mode,FALSE) THEN
      RAISE EXCEPTION 'Central inventory is not enabled for this account'
        USING ERRCODE = '42501';
    END IF;

    IF TG_TABLE_NAME IN ('raw_materials','medicines') THEN
      IF NEW.farm_id IS DISTINCT FROM primary_farm THEN
        RAISE EXCEPTION 'Shared inventory items must belong to the primary farm'
          USING ERRCODE = '42501';
      END IF;
      RETURN NEW;
    END IF;
    IF TG_TABLE_NAME='raw_material_logs'
       AND (to_jsonb(NEW)->>'transaction_type')='INWARD' THEN
      IF NEW.farm_id IS DISTINCT FROM primary_farm THEN
        RAISE EXCEPTION 'Central stock purchases must belong to the primary farm'
          USING ERRCODE = '42501';
      END IF;
      RETURN NEW;
    END IF;
    IF TG_TABLE_NAME='medicine_batches' THEN
      IF NEW.farm_id IS DISTINCT FROM primary_farm THEN
        RAISE EXCEPTION 'Central stock purchases must belong to the primary farm'
          USING ERRCODE = '42501';
      END IF;
      RETURN NEW;
    END IF;
    IF TG_TABLE_NAME='medicine_logs'
       AND (to_jsonb(NEW)->>'event_type')='INWARD' THEN
      IF NEW.farm_id IS DISTINCT FROM primary_farm THEN
        RAISE EXCEPTION 'Central stock purchases must belong to the primary farm'
          USING ERRCODE = '42501';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW.farm_id IS NOT NULL AND NEW.farm_id<>context_farm THEN
      RAISE EXCEPTION 'Shared inventory usage must be attributed to the active farm'
        USING ERRCODE = '42501';
    END IF;
    NEW.farm_id := context_farm;
    RETURN NEW;
  END IF;

  IF TG_OP='UPDATE' AND NEW.farm_id IS NOT DISTINCT FROM OLD.farm_id THEN
    RETURN NEW;
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
    'raw_materials','raw_material_logs','medicines','medicine_batches',
    'medicine_usage','medicine_usage_allocations','medicine_logs'
  ]
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (
         owner_id = NULLIF(current_setting(''app.owner_id'', true), '''')::UUID
         AND (
           farm_id = ANY(string_to_array(
             NULLIF(current_setting(''app.farm_ids'', true), ''''), '',''
           )::UUID[])
           OR (
             is_shared_pool=TRUE
             AND EXISTS (
               SELECT 1 FROM users u
               JOIN farms primary_farm
                 ON primary_farm.owner_user_id=u.id AND primary_farm.is_primary
               WHERE u.id=owner_id
                 AND (
                   u.shared_inventory_enabled=TRUE
                   OR primary_farm.id=NULLIF(current_setting(''app.farm_id'', true), '''')::UUID
                 )
             )
           )
         )
       ) WITH CHECK (
         owner_id = NULLIF(current_setting(''app.owner_id'', true), '''')::UUID
         AND (
           farm_id = ANY(string_to_array(
             NULLIF(current_setting(''app.farm_ids'', true), ''''), '',''
           )::UUID[])
           OR (is_shared_pool=TRUE AND EXISTS (
             SELECT 1 FROM users u
             WHERE u.id=owner_id AND u.shared_inventory_enabled=TRUE
           ))
         )
       )', t
    );
  END LOOP;
END $$;

INSERT INTO schema_migrations(version) VALUES (8) ON CONFLICT DO NOTHING;

COMMIT;
