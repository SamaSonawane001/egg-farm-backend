import { PoolClient } from 'pg';
import { getFarmContext } from '../config/farmContext';
import { HttpError } from '../utils/httpError';
import { ensurePrimaryFarm } from './primaryFarm.service';

export async function resolveFarmId(
  client: PoolClient,
  ownerId: string,
): Promise<string> {
  const context = getFarmContext();
  if (context && context.ownerId !== ownerId) {
    throw new HttpError(403, 'Farm context does not match this account');
  }
  const activeFarmId =
    context?.farmId && context.farmId !== 'all' ? context.farmId : null;
  await ensurePrimaryFarm(ownerId, client);
  const result = await client.query<{ id: string }>(
    `SELECT f.id FROM farms f
     WHERE (f.owner_user_id=$1::uuid
        OR to_jsonb(f)->>'user_id'=$1::text
        OR to_jsonb(f)->>'owner_id'=$1::text)
       AND (($2::uuid IS NOT NULL AND f.id=$2::uuid)
         OR ($2::uuid IS NULL AND f.is_primary=TRUE))
     ORDER BY f.is_primary DESC,f.created_at,f.id
     LIMIT 1`,
    [ownerId, activeFarmId],
  );
  if (!result.rows.length) {
    const primary = await client.query<{ id: string }>(
      `SELECT f.id FROM farms f
       WHERE f.owner_user_id=$1::uuid AND f.is_primary=TRUE
       ORDER BY f.created_at,f.id LIMIT 1`,
      [ownerId],
    );
    if (!primary.rows.length) {
      throw new HttpError(404, 'Farm not found for this account');
    }
    return primary.rows[0].id;
  }
  return result.rows[0].id;
}
