import { query } from '../config/db';
import { HttpError } from '../utils/httpError';

export async function ensureBatch(ownerId: number, batchId: number | null | undefined) {
  if (batchId == null) return;
  const r = await query('SELECT id FROM flock_batches WHERE id=$1 AND owner_id=$2', [batchId, ownerId]);
  if (!r.length) throw new HttpError(404, 'Flock batch not found');
}

async function liveBirds(ownerId: number, batchId: number, excludeLogId = 0): Promise<number> {
  const r = await query(
    `SELECT b.quantity - COALESCE((SELECT SUM(dead_count) FROM mortality_logs
        WHERE batch_id=b.id AND owner_id=$2 AND id<>$3),0) AS live
     FROM flock_batches b WHERE b.id=$1 AND b.owner_id=$2`,
    [batchId, ownerId, excludeLogId]
  );
  if (!r.length) throw new HttpError(404, 'Flock batch not found');
  return r[0].live;
}

export const listBatches = (ownerId: number) =>
  query(
    `SELECT b.*, COALESCE(m.dead,0) AS total_mortality, b.quantity - COALESCE(m.dead,0) AS active_birds
     FROM flock_batches b
     LEFT JOIN (SELECT batch_id, SUM(dead_count) AS dead FROM mortality_logs WHERE owner_id=$1 GROUP BY batch_id) m
       ON m.batch_id=b.id
     WHERE b.owner_id=$1 ORDER BY b.arrival_date DESC, b.id DESC`,
    [ownerId]
  );

export async function createBatch(ownerId: number, d: any) {
  const r = await query(
    `INSERT INTO flock_batches (owner_id,batch_name,arrival_date,quantity,unit_price,notes)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [ownerId, d.batch_name, d.arrival_date, d.quantity, d.unit_price, d.notes]
  );
  return r[0];
}

export async function updateBatch(ownerId: number, id: number, d: any) {
  const dead = await query('SELECT COALESCE(SUM(dead_count),0) AS dead FROM mortality_logs WHERE batch_id=$1 AND owner_id=$2', [id, ownerId]);
  if (d.quantity < dead[0].dead) throw new HttpError(400, `Quantity cannot be less than recorded mortality (${dead[0].dead})`);
  const r = await query(
    `UPDATE flock_batches SET batch_name=$3, arrival_date=$4, quantity=$5, unit_price=$6, notes=$7
     WHERE id=$1 AND owner_id=$2 RETURNING *`,
    [id, ownerId, d.batch_name, d.arrival_date, d.quantity, d.unit_price, d.notes]
  );
  if (!r.length) throw new HttpError(404, 'Flock batch not found');
  return r[0];
}

export async function deleteBatch(ownerId: number, id: number) {
  const r = await query('DELETE FROM flock_batches WHERE id=$1 AND owner_id=$2 RETURNING id', [id, ownerId]);
  if (!r.length) throw new HttpError(404, 'Flock batch not found');
}

export const listMortality = (ownerId: number, batchId?: number) =>
  query(
    `SELECT m.*, b.batch_name FROM mortality_logs m JOIN flock_batches b ON b.id=m.batch_id
     WHERE m.owner_id=$1 AND ($2::bigint IS NULL OR m.batch_id=$2)
     ORDER BY m.log_date DESC, m.id DESC`,
    [ownerId, batchId ?? null]
  );

export async function createMortality(ownerId: number, d: any) {
  const live = await liveBirds(ownerId, d.batch_id);
  if (d.dead_count > live) throw new HttpError(400, `Dead count exceeds live birds in this batch (${live})`);
  const r = await query(
    `INSERT INTO mortality_logs (owner_id,batch_id,log_date,dead_count,cause) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [ownerId, d.batch_id, d.log_date, d.dead_count, d.cause]
  );
  return r[0];
}

export async function updateMortality(ownerId: number, id: number, d: any) {
  const live = await liveBirds(ownerId, d.batch_id, id);
  if (d.dead_count > live) throw new HttpError(400, `Dead count exceeds live birds in this batch (${live})`);
  const r = await query(
    `UPDATE mortality_logs SET batch_id=$3, log_date=$4, dead_count=$5, cause=$6 WHERE id=$1 AND owner_id=$2 RETURNING *`,
    [id, ownerId, d.batch_id, d.log_date, d.dead_count, d.cause]
  );
  if (!r.length) throw new HttpError(404, 'Mortality log not found');
  return r[0];
}

export async function deleteMortality(ownerId: number, id: number) {
  const r = await query('DELETE FROM mortality_logs WHERE id=$1 AND owner_id=$2 RETURNING id', [id, ownerId]);
  if (!r.length) throw new HttpError(404, 'Mortality log not found');
}
