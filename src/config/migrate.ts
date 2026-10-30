import fs from 'fs';
import path from 'path';
import { pool } from './db';

export async function runMigrations(): Promise<void> {
  const sql = fs.readFileSync(path.join(__dirname, '../../sql/schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('✔ Database schema is up to date');
}

if (require.main === module) {
  runMigrations()
    .then(() => pool.end())
    .catch((e) => { console.error(e); process.exit(1); });
}
