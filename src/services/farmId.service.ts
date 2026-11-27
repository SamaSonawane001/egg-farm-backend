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
  if (context) {
    if (!context.farmId) {
      throw new HttpError(409, 'Select an individual farm to make changes');
    }
    const selected = await client.query<{ id: string }>(
      `SELECT id FROM farms
       WHERE id=$1::uuid AND owner_user_id=$2::uuid`,
      [context.farmId, ownerId],
    );
    if (!selected.rows.length) {
      throw new HttpError(404, 'Farm not found for this account');
    }
    return selected.rows[0].id;
  }

  const primary = await ensurePrimaryFarm(ownerId, client);
  return primary.id;
}

export function getActiveFarmId(ownerId: string): string {
  const context = getFarmContext();
  if (context && context.ownerId !== ownerId) {
    throw new HttpError(403, 'Farm context does not match this account');
  }
  if (!context?.farmId) {
    throw new HttpError(409, 'Select an individual farm to continue');
  }
  return context.farmId;
}
