import { PoolClient } from 'pg';
import { pool } from '../config/db';

type FarmRow = {
  id: string;
  name: string;
  is_primary: boolean;
};

export async function ensurePrimaryFarm(
  ownerId: string,
  client?: PoolClient,
): Promise<FarmRow> {
  const run = client ?? pool;
  const farms = await run.query<FarmRow>(
    `SELECT id,name,is_primary
     FROM farms
     WHERE owner_user_id=$1::uuid
     ORDER BY is_primary DESC,created_at ASC,id ASC
     LIMIT 1`,
    [ownerId],
  );
  if (farms.rows.length) {
    return farms.rows.find((farm) => farm.is_primary) ?? farms.rows[0];
  }

  const account = await run.query<{ farm_name: string | null }>(
    'SELECT farm_name FROM users WHERE id=$1::uuid',
    [ownerId],
  );
  const name = account.rows[0]?.farm_name?.trim() || 'Main Farm';
  const created = await run.query<FarmRow>(
    `INSERT INTO farms (
       owner_user_id,name,is_primary,address,low_stock_threshold,kg_per_bag,
       default_tax_percent,eggs_per_tray
     )
     VALUES ($1,$2,TRUE,NULL,10,50,0,30)
     ON CONFLICT DO NOTHING
     RETURNING id,name,is_primary`,
    [ownerId, name],
  );
  if (created.rows.length) return created.rows[0];

  const fallback = await run.query<FarmRow>(
    `SELECT id,name,is_primary
     FROM farms
     WHERE owner_user_id=$1::uuid
     ORDER BY is_primary DESC,created_at ASC,id ASC
     LIMIT 1`,
    [ownerId],
  );
  return fallback.rows[0];
}
