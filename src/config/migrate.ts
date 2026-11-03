import fs from 'fs';
import path from 'path';
import { pool } from './db';

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
  const sql = fs.readFileSync(path.join(__dirname, '../../sql/schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('✔ Database schema is up to date');
}

if (require.main === module) {
  runMigrations()
    .then(() => pool.end())
    .catch((e) => { console.error(e); process.exit(1); });
}
