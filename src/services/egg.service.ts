import { PoolClient } from 'pg';
import { query, withTx } from '../config/db';
import { HttpError } from '../utils/httpError';
import { ensureBatch } from './flock.service';

function validate(d: { trays_count: number; loose_eggs: number; damaged_eggs: number }, eggsPerTray: number) {
  const totalEggs = d.trays_count * eggsPerTray + d.loose_eggs;
  if (!Number.isSafeInteger(totalEggs) || totalEggs > 2147483647) throw new HttpError(400, 'Total egg count is too large');
  if (d.damaged_eggs > totalEggs) throw new HttpError(400, 'Damaged eggs cannot exceed collected eggs');
  return totalEggs;
}

async function stock(client: PoolClient | null, ownerId: number) {
  const run = (text: string, params: any[]) => client ? client.query(text, params).then((r) => r.rows) : query(text, params);
  const rows = await run(
    `SELECT COALESCE((SELECT SUM(net_eggs) FROM egg_production WHERE owner_id=$1),0) AS produced,
            COALESCE((SELECT SUM(COALESCE(it.egg_quantity, it.quantity))
                      FROM invoices i JOIN invoice_items it ON it.invoice_id=i.id AND it.owner_id=i.owner_id
                      WHERE i.owner_id=$1 AND i.invoice_type='egg_sale'),0) AS sold`,
    [ownerId]
  );
  const produced = Number(rows[0].produced);
  const sold = Number(rows[0].sold);
  const rawAvailable = produced - sold;
  return {
    produced,
    sold,
    available_eggs: Math.max(0, rawAvailable),
    over_billed_eggs: Math.max(0, -rawAvailable),
  };
}

export const availableStock = (ownerId: number) => stock(null, ownerId);

export const list = (ownerId: number, filter: { date?: string; month?: string } = {}) =>
  query(
    `SELECT e.*, b.batch_name FROM egg_production e LEFT JOIN flock_batches b ON b.id=e.batch_id
     WHERE e.owner_id=$1
       AND ($2::date IS NULL OR e.collection_date=$2::date)
       AND ($3::date IS NULL OR (
         e.collection_date >= $3::date
         AND e.collection_date < ($3::date + interval '1 month')
       ))
     ORDER BY e.collection_date DESC, e.id DESC`,
    [ownerId, filter.date ?? null, filter.month ? `${filter.month}-01` : null]
  );

export async function summary(ownerId: number, today: string) {
  const r = await query(
    `SELECT
       COALESCE(SUM(net_eggs) FILTER (WHERE collection_date=$2::date),0) AS today_net,
       COALESCE(SUM(net_eggs) FILTER (WHERE collection_date > $2::date - 30),0) AS last30_net,
       COALESCE(SUM(damaged_eggs) FILTER (WHERE collection_date > $2::date - 30),0) AS last30_damaged,
       COALESCE(SUM(trays_count),0) AS all_time_trays,
       COALESCE(SUM(total_eggs),0) AS all_time_eggs,
       COALESCE(SUM(damaged_eggs),0) AS all_time_damaged,
       COALESCE(SUM(net_eggs),0) AS all_time_net
     FROM egg_production WHERE owner_id=$1`,
    [ownerId, today]
  );
  const inventory = await stock(null, ownerId);
  return { ...r[0], ...inventory };
}

export async function monthlySummary(ownerId: number, month: string) {
  const start = `${month}-01`;
  const rows = await query(
    `SELECT COALESCE(SUM(trays_count),0) AS trays_count,
            COALESCE(SUM(total_eggs),0) AS total_eggs,
            COALESCE(SUM(damaged_eggs),0) AS damaged_eggs,
            COALESCE(SUM(net_eggs),0) AS net_eggs
     FROM egg_production
     WHERE owner_id=$1 AND collection_date >= $2::date
       AND collection_date < ($2::date + interval '1 month')`,
    [ownerId, start]
  );
  return { month, ...rows[0] };
}

export async function monthlySummaries(ownerId: number) {
  return query(
    `SELECT to_char(date_trunc('month', collection_date), 'YYYY-MM') AS month,
            COALESCE(SUM(trays_count),0) AS trays_count,
            COALESCE(SUM(total_eggs),0) AS total_eggs,
            COALESCE(SUM(damaged_eggs),0) AS damaged_eggs,
            COALESCE(SUM(net_eggs),0) AS net_eggs
     FROM egg_production
     WHERE owner_id=$1
     GROUP BY date_trunc('month', collection_date)
     ORDER BY date_trunc('month', collection_date) DESC`,
    [ownerId]
  );
}

export async function create(ownerId: number, d: { collection_date: string; batch_id: number | null; trays_count: number; loose_eggs: number; damaged_eggs: number }) {
  await ensureBatch(ownerId, d.batch_id);
  return withTx(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [ownerId]);
    const settings = await client.query('SELECT eggs_per_tray FROM users WHERE id=$1', [ownerId]);
    if (!settings.rows.length) throw new HttpError(404, 'Farm profile not found');
    const eggsPerTray = Number(settings.rows[0].eggs_per_tray);
    const totalEggs = validate(d, eggsPerTray);
    const r = await client.query(
      `INSERT INTO egg_production
         (owner_id,batch_id,collection_date,trays_count,loose_eggs,eggs_per_tray_used,total_eggs,damaged_eggs)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [ownerId, d.batch_id, d.collection_date, d.trays_count, d.loose_eggs, eggsPerTray, totalEggs, d.damaged_eggs]
    );
    return r.rows[0];
  });
}

export async function update(ownerId: number, id: number, d: { collection_date: string; batch_id: number | null; trays_count: number; loose_eggs: number; damaged_eggs: number }) {
  await ensureBatch(ownerId, d.batch_id);
  return withTx(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [ownerId]);
    const existing = await client.query('SELECT net_eggs, eggs_per_tray_used FROM egg_production WHERE id=$1 AND owner_id=$2 FOR UPDATE', [id, ownerId]);
    if (!existing.rows.length) throw new HttpError(404, 'Egg production record not found');
    const eggsPerTray = Number(existing.rows[0].eggs_per_tray_used);
    const totalEggs = validate(d, eggsPerTray);
    const currentStock = await stock(client, ownerId);
    const availableWithoutRecord = currentStock.available_eggs - Number(existing.rows[0].net_eggs);
    const newNet = totalEggs - d.damaged_eggs;
    if (availableWithoutRecord + newNet < 0) throw new HttpError(400, 'Cannot reduce production below already billed egg quantities');
    const r = await client.query(
      `UPDATE egg_production
       SET batch_id=$3, collection_date=$4, trays_count=$5, loose_eggs=$6, total_eggs=$7, damaged_eggs=$8
       WHERE id=$1 AND owner_id=$2 RETURNING *`,
      [id, ownerId, d.batch_id, d.collection_date, d.trays_count, d.loose_eggs, totalEggs, d.damaged_eggs]
    );
    return r.rows[0];
  });
}

export async function remove(ownerId: number, id: number) {
  await withTx(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [ownerId]);
    const existing = await client.query('SELECT net_eggs FROM egg_production WHERE id=$1 AND owner_id=$2 FOR UPDATE', [id, ownerId]);
    if (!existing.rows.length) throw new HttpError(404, 'Egg production record not found');
    const currentStock = await stock(client, ownerId);
    if (currentStock.available_eggs - Number(existing.rows[0].net_eggs) < 0) {
      throw new HttpError(400, 'Cannot delete this collection because some of its eggs have already been billed');
    }
    await client.query('DELETE FROM egg_production WHERE id=$1 AND owner_id=$2', [id, ownerId]);
  });
}
