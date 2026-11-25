BEGIN;

CREATE OR REPLACE FUNCTION normalize_customer_phone(value TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  digits TEXT := regexp_replace(COALESCE(value, ''), '[^0-9]', '', 'g');
BEGIN
  IF length(digits) > 10 AND left(digits, 2) = '91' THEN
    digits := substring(digits FROM 3);
  END IF;
  IF length(digits) = 11 AND left(digits, 1) = '0' THEN
    digits := substring(digits FROM 2);
  END IF;
  IF length(digits) = 10 THEN
    RETURN digits;
  END IF;
  RETURN '';
END;
$$;

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS normalized_phone TEXT NOT NULL DEFAULT '';
ALTER TABLE customers
  ALTER COLUMN normalized_phone SET DEFAULT '',
  ALTER COLUMN normalized_phone SET NOT NULL;

ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_owner_id_phone_key;
DROP INDEX IF EXISTS idx_customers_farm_phone;

ALTER TABLE customers DISABLE TRIGGER business_row_farm;
ALTER TABLE invoices DISABLE TRIGGER business_row_farm;
ALTER TABLE customer_payments DISABLE TRIGGER business_row_farm;

UPDATE customers
SET normalized_phone = normalize_customer_phone(phone),
    phone = CASE
      WHEN normalize_customer_phone(phone) <> ''
        THEN normalize_customer_phone(phone)
      ELSE regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g')
    END;

UPDATE invoices
SET customer_mobile = NULLIF(normalize_customer_phone(customer_mobile), '')
WHERE customer_mobile IS DISTINCT FROM
      NULLIF(normalize_customer_phone(customer_mobile), '');

CREATE TEMP TABLE customer_phone_merge ON COMMIT DROP AS
SELECT id,
       first_value(id) OVER (
         PARTITION BY farm_id, normalized_phone
         ORDER BY created_at, id
       ) AS primary_id
FROM customers
WHERE normalized_phone <> '';

UPDATE customers AS primary_customer
SET name = COALESCE(
  NULLIF(btrim(primary_customer.name), ''),
  (
    SELECT NULLIF(btrim(duplicate.name), '')
    FROM customer_phone_merge AS merged
    JOIN customers AS duplicate ON duplicate.id = merged.id
    WHERE merged.primary_id = primary_customer.id
      AND merged.id <> merged.primary_id
      AND btrim(duplicate.name) <> ''
    ORDER BY duplicate.created_at, duplicate.id
    LIMIT 1
  ),
  primary_customer.name
)
WHERE EXISTS (
  SELECT 1 FROM customer_phone_merge merged
  WHERE merged.id <> merged.primary_id
    AND merged.primary_id = primary_customer.id
);

UPDATE invoices AS invoice
SET customer_id = merged.primary_id
FROM customer_phone_merge AS merged
WHERE invoice.customer_id = merged.id
  AND merged.id <> merged.primary_id;

UPDATE customer_payments AS payment
SET customer_id = merged.primary_id
FROM customer_phone_merge AS merged
WHERE payment.customer_id = merged.id
  AND merged.id <> merged.primary_id;

DELETE FROM customers AS customer
USING customer_phone_merge AS merged
WHERE customer.id = merged.id
  AND merged.id <> merged.primary_id;

INSERT INTO customers(owner_id,farm_id,name,phone,normalized_phone)
SELECT DISTINCT ON (invoice.farm_id, normalized.phone)
       invoice.owner_id,
       invoice.farm_id,
       COALESCE(NULLIF(btrim(invoice.customer_name), ''), 'Customer'),
       normalized.phone,
       normalized.phone
FROM invoices AS invoice
CROSS JOIN LATERAL (
  SELECT normalize_customer_phone(invoice.customer_mobile) AS phone
) AS normalized
WHERE normalized.phone <> ''
  AND NOT EXISTS (
    SELECT 1 FROM customers AS customer
    WHERE customer.farm_id = invoice.farm_id
      AND customer.normalized_phone = normalized.phone
  )
ORDER BY invoice.farm_id, normalized.phone, invoice.created_at, invoice.id;

UPDATE invoices AS invoice
SET customer_id = customer.id
FROM customers AS customer
WHERE customer.farm_id = invoice.farm_id
  AND customer.normalized_phone <> ''
  AND customer.normalized_phone = normalize_customer_phone(invoice.customer_mobile)
  AND invoice.customer_id IS DISTINCT FROM customer.id;

UPDATE customer_payments AS payment
SET customer_id = invoice.customer_id
FROM invoices AS invoice
WHERE payment.invoice_id = invoice.id
  AND payment.owner_id = invoice.owner_id
  AND invoice.customer_id IS NOT NULL
  AND payment.customer_id IS DISTINCT FROM invoice.customer_id;

CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_farm_normalized_phone
  ON customers(farm_id, normalized_phone)
  WHERE normalized_phone <> '';

CREATE INDEX IF NOT EXISTS idx_customers_farm_name_ci
  ON customers(farm_id, lower(trim(name)));

ALTER TABLE customers ENABLE TRIGGER business_row_farm;
ALTER TABLE invoices ENABLE TRIGGER business_row_farm;
ALTER TABLE customer_payments ENABLE TRIGGER business_row_farm;

INSERT INTO schema_migrations(version) VALUES (2) ON CONFLICT DO NOTHING;

COMMIT;
