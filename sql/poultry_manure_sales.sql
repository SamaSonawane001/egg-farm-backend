ALTER TABLE invoices
  DROP CONSTRAINT IF EXISTS invoices_invoice_type_check;

ALTER TABLE invoices
  ADD CONSTRAINT invoices_invoice_type_check
  CHECK (invoice_type IN (
    'egg_sale',
    'spent_hen_sale',
    'poultry_manure_sale',
    'feed_trade'
  ));

ALTER TABLE invoice_items
  ADD COLUMN IF NOT EXISTS sale_unit VARCHAR(24);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='invoice_items_sale_unit_check'
  ) THEN
    ALTER TABLE invoice_items
      ADD CONSTRAINT invoice_items_sale_unit_check
      CHECK (sale_unit IS NULL OR sale_unit IN ('bag','tractor_trolley','ton'));
  END IF;
END $$;

INSERT INTO schema_migrations(version) VALUES (7) ON CONFLICT DO NOTHING;
