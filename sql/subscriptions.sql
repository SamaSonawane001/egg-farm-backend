BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS subscription_status VARCHAR(24) NOT NULL DEFAULT 'TRIAL',
  ADD COLUMN IF NOT EXISTS subscription_plan VARCHAR(32) NOT NULL DEFAULT 'FREE_TRIAL',
  ADD COLUMN IF NOT EXISTS subscription_starts_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS subscription_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS subscription_cancelled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS free_invoices_limit INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS subscription_payment_id UUID;

DO $$ BEGIN
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
END $$;

CREATE TABLE IF NOT EXISTS subscription_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  razorpay_order_id VARCHAR(64) NOT NULL UNIQUE,
  razorpay_payment_id VARCHAR(64),
  razorpay_signature VARCHAR(256),
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  currency VARCHAR(3) NOT NULL DEFAULT 'INR',
  status VARCHAR(24) NOT NULL CHECK (
    status IN ('PENDING','CAPTURED','FAILED','REFUNDED','DISPUTED')
  ),
  raw_event JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_subscription_payments_payment_id
  ON subscription_payments(razorpay_payment_id)
  WHERE razorpay_payment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_subscription_payments_user_created
  ON subscription_payments(user_id,created_at DESC);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='users_subscription_payment_fk'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT users_subscription_payment_fk
      FOREIGN KEY (subscription_payment_id)
      REFERENCES subscription_payments(id) ON DELETE SET NULL;
  END IF;
END $$;

INSERT INTO schema_migrations(version) VALUES (9) ON CONFLICT DO NOTHING;

COMMIT;
