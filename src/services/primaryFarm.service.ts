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
        OR to_jsonb(farms)->>'user_id'=$1::text
        OR to_jsonb(farms)->>'owner_id'=$1::text
     ORDER BY is_primary DESC,created_at ASC,id ASC
     LIMIT 2`,
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
  try {
    const created = await run.query<FarmRow>(
      `INSERT INTO farms (owner_user_id,name,is_primary)
       VALUES ($1,$2,TRUE)
       RETURNING id,name,is_primary`,
      [ownerId, name],
    );
    if (created.rows.length) return created.rows[0];
  } catch {
    // A concurrent request may have created the primary farm first.
  }

  const fallback = await run.query<FarmRow>(
    `SELECT id,name,is_primary
     FROM farms
     WHERE owner_user_id=$1::uuid
        OR to_jsonb(farms)->>'user_id'=$1::text
        OR to_jsonb(farms)->>'owner_id'=$1::text
     ORDER BY is_primary DESC,created_at ASC,id ASC
     LIMIT 1`,
    [ownerId],
  );
  return fallback.rows[0];
}
