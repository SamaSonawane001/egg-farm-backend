-- Farm settings are stored on users in this single-farm-per-account schema.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS signature_url TEXT NULL,
  ADD COLUMN IF NOT EXISTS payment_qr_url TEXT NULL;
