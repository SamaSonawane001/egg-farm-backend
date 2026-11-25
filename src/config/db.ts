import { Pool, PoolClient, QueryResultRow, types } from 'pg';
import { env } from './env';
import { getFarmContext } from './farmContext';

// DATE -> 'YYYY-MM-DD' string (avoids timezone shifts), NUMERIC -> number.
// UUID columns are returned as strings by node-postgres.
types.setTypeParser(1082, (v: string) => v);
types.setTypeParser(1700, (v: string) => parseFloat(v));
types.setTypeParser(20, (v: string) => parseInt(v, 10));

export const pool = new Pool({
  connectionString: env.databaseUrl,
  ssl: env.dbSsl ? { rejectUnauthorized: false } : undefined,
  max: 10,
});

export async function query<T extends QueryResultRow = any>(text: string, params: any[] = []): Promise<T[]> {
  const context = getFarmContext();
  if (!context) {
    const res = await pool.query<T>(text, params);
    return res.rows;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE egg_farm_runtime');
    await setFarmSettings(client, context);
    const res = await client.query<T>(text, params);
    await client.query('COMMIT');
    return res.rows;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function withTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const context = getFarmContext();
    if (context) {
      await client.query('SET LOCAL ROLE egg_farm_runtime');
      await setFarmSettings(client, context);
    }
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function setFarmSettings(
  client: PoolClient,
  context: { ownerId: string; farmId: string | null; farmIds: string[] },
): Promise<void> {
  await client.query(
    `SELECT set_config('app.owner_id',$1,true),
            set_config('app.farm_id',$2,true),
            set_config('app.farm_ids',$3,true)`,
    [context.ownerId, context.farmId ?? '', context.farmIds.join(',')],
  );
}
