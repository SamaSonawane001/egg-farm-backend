import fs from 'fs';
import path from 'path';
import { pool } from './db';

const INITIAL_SCHEMA_VERSION = 1;
const CUSTOMER_KHATA_SCHEMA_VERSION = 2;
const CONSENT_SCHEMA_VERSION = 3;
const LOGIN_SECURITY_SCHEMA_VERSION = 4;
const SHARED_INVENTORY_SCHEMA_VERSION = 8;
const PERFORMANCE_INDEX_SCHEMA_VERSION = 6;
const POULTRY_MANURE_SCHEMA_VERSION = 7;
const SUBSCRIPTION_SCHEMA_VERSION = 9;
const FARM_PROFILE_SCHEMA_VERSION = 10;
const FARM_OWNERSHIP_SCHEMA_VERSION = 11;
const FARM_OWNER_NORMALIZATION_SCHEMA_VERSION = 12;

export async function runMigrations(): Promise<void> {
  const existingIdType = await pool.query<{ id_type: string }>(
    `SELECT format_type(a.atttypid, a.atttypmod) AS id_type
     FROM pg_attribute a
     WHERE a.attrelid = to_regclass('public.users')
       AND a.attname = 'id'
       AND NOT a.attisdropped`
  );
  if (existingIdType.rows[0] && existingIdType.rows[0].id_type !== 'uuid') {
    throw new Error(
      'The existing database uses non-UUID IDs. Run backend/sql/uuid-reset.sql in Supabase SQL Editor only if existing data may be discarded.'
    );
  }
  let markerTable = await pool.query<{ table_name: string | null }>(
    `SELECT to_regclass('public.schema_migrations')::text AS table_name`,
  );
  let appliedVersion = 0;
  if (markerTable.rows[0]?.table_name) {
    const applied = await pool.query<{ version: number }>(
      'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1',
    );
    appliedVersion = applied.rows[0]?.version ?? 0;
  }

  if (!markerTable.rows[0]?.table_name || appliedVersion < INITIAL_SCHEMA_VERSION) {
    const initialSchema = fs.readFileSync(
      path.join(__dirname, '../../sql/schema.sql'),
      'utf8',
    );
    await pool.query(initialSchema);
    markerTable = await pool.query<{ table_name: string | null }>(
      `SELECT to_regclass('public.schema_migrations')::text AS table_name`,
    );
    if (markerTable.rows[0]?.table_name) {
      const applied = await pool.query<{ version: number }>(
        'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1',
      );
      appliedVersion = applied.rows[0]?.version ?? 0;
    }
  }

  if (appliedVersion < CUSTOMER_KHATA_SCHEMA_VERSION) {
    const customerMigration = fs.readFileSync(
      path.join(__dirname, '../../sql/customer_khata_dedup.sql'),
      'utf8',
    );
    await pool.query(customerMigration);
  }
  if (appliedVersion < CONSENT_SCHEMA_VERSION) {
    const consentMigration = fs.readFileSync(
      path.join(__dirname, '../../sql/consent_audit.sql'),
      'utf8',
    );
    await pool.query(consentMigration);
  }
  if (appliedVersion < LOGIN_SECURITY_SCHEMA_VERSION) {
    const loginSecurityMigration = fs.readFileSync(
      path.join(__dirname, '../../sql/login_security.sql'),
      'utf8',
    );
    await pool.query(loginSecurityMigration);
  }
  if (appliedVersion < SHARED_INVENTORY_SCHEMA_VERSION) {
    const sharedInventoryMigration = fs.readFileSync(
      path.join(__dirname, '../../sql/shared_inventory.sql'),
      'utf8',
    );
    await pool.query(sharedInventoryMigration);
  }
  if (appliedVersion < PERFORMANCE_INDEX_SCHEMA_VERSION) {
    const performanceIndexesMigration = fs.readFileSync(
      path.join(__dirname, '../../sql/performance_indexes.sql'),
      'utf8',
    );
    await pool.query(performanceIndexesMigration);
  }
  if (appliedVersion < POULTRY_MANURE_SCHEMA_VERSION) {
    const poultryManureMigration = fs.readFileSync(
      path.join(__dirname, '../../sql/poultry_manure_sales.sql'),
      'utf8',
    );
    await pool.query(poultryManureMigration);
  }
  if (appliedVersion < SUBSCRIPTION_SCHEMA_VERSION) {
    const subscriptionMigration = fs.readFileSync(
      path.join(__dirname, '../../sql/subscriptions.sql'),
      'utf8',
    );
    await pool.query(subscriptionMigration);
  }
  if (appliedVersion < FARM_PROFILE_SCHEMA_VERSION) {
    const farmProfileMigration = fs.readFileSync(
      path.join(__dirname, '../../sql/farm_profiles_integrity.sql'),
      'utf8',
    );
    await pool.query(farmProfileMigration);
  }
  if (appliedVersion < FARM_OWNERSHIP_SCHEMA_VERSION) {
    const farmOwnershipMigration = fs.readFileSync(
      path.join(__dirname, '../../sql/farm_ownership_repair.sql'),
      'utf8',
    );
    await pool.query(farmOwnershipMigration);
  }
  if (appliedVersion < FARM_OWNER_NORMALIZATION_SCHEMA_VERSION) {
    const farmOwnerNormalizationMigration = fs.readFileSync(
      path.join(__dirname, '../../sql/farm_owner_normalization.sql'),
      'utf8',
    );
    await pool.query(farmOwnerNormalizationMigration);
  }
  console.log('✔ Database schema is up to date');
}

if (require.main === module) {
  runMigrations()
    .then(() => pool.end())
    .catch((e) => { console.error(e); process.exit(1); });
}
