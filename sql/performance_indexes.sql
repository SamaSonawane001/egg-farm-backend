BEGIN;

CREATE INDEX IF NOT EXISTS idx_invoices_farm_created
  ON invoices(farm_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_invoices_farm_date
  ON invoices(farm_id, invoice_date DESC);

CREATE INDEX IF NOT EXISTS idx_egg_production_farm_created
  ON egg_production(farm_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_egg_production_farm_date
  ON egg_production(farm_id, collection_date DESC);

CREATE INDEX IF NOT EXISTS idx_flock_batches_farm_created
  ON flock_batches(farm_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_flock_batches_farm_date
  ON flock_batches(farm_id, arrival_date DESC);

CREATE INDEX IF NOT EXISTS idx_feed_purchases_farm_created
  ON feed_purchases(farm_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feed_purchases_farm_date
  ON feed_purchases(farm_id, delivery_date DESC);
CREATE INDEX IF NOT EXISTS idx_feed_usage_farm_created
  ON feed_usage(farm_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feed_usage_farm_date
  ON feed_usage(farm_id, usage_date DESC);

CREATE INDEX IF NOT EXISTS idx_medicines_farm_created
  ON medicines(farm_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_medicine_batches_farm_created
  ON medicine_batches(farm_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_medicine_batches_farm_date
  ON medicine_batches(farm_id, received_date DESC);
CREATE INDEX IF NOT EXISTS idx_medicine_usage_farm_created
  ON medicine_usage(farm_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_medicine_usage_farm_date
  ON medicine_usage(farm_id, usage_date DESC);

CREATE INDEX IF NOT EXISTS idx_farm_expenses_farm_created
  ON farm_expenses(farm_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_farm_expenses_farm_date
  ON farm_expenses(farm_id, expense_date DESC);

INSERT INTO schema_migrations(version) VALUES (6) ON CONFLICT DO NOTHING;

COMMIT;
