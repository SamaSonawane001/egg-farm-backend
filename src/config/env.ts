import dotenv from 'dotenv';
dotenv.config();

function required(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required env variable ${key} (see .env.example)`);
  return v;
}

const port = Number(process.env.PORT || 4000);
const supabaseServiceRoleKey = [
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  process.env.SUPABASE_SECRET_KEY,
].map((value) => value?.trim()).find(Boolean) || '';
const supabaseStorageBucket = process.env.SUPABASE_STORAGE_BUCKET?.trim() || 'farm-receipts';

export const env = {
  port,
  databaseUrl: required('DATABASE_URL'),
  dbSsl: process.env.DB_SSL === 'true',
  jwtSecret: required('JWT_SECRET'),
  jwtExpires: process.env.JWT_EXPIRES || '7d',
  publicUrl: (process.env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, ''),
  corsOrigin: process.env.CORS_ORIGIN || '*',
  autoMigrate: process.env.AUTO_MIGRATE !== 'false',
  supabaseUrl: (process.env.SUPABASE_URL || '').trim(),
  supabaseServiceRoleKey,
  supabaseStorageBucket,
};
