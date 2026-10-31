import { PoolClient } from 'pg';
import { query, withTx } from '../config/db';
import { HttpError } from '../utils/httpError';

const lockOwner = (client: PoolClient, ownerId: number) =>
  client.query('SELECT pg_advisory_xact_lock($1::bigint)', [ownerId]);

export async function listMedicines(ownerId: number) {
  return query(
    `WITH batch_stock AS (
       SELECT b.id,b.owner_id,b.medicine_id,b.expiry_date,b.received_quantity,
              b.received_quantity-COALESCE(SUM(a.quantity),0) AS remaining
       FROM medicine_batches b
       LEFT JOIN medicine_usage_allocations a ON a.batch_id=b.id AND a.owner_id=b.owner_id
       WHERE b.owner_id=$1
       GROUP BY b.id,b.owner_id,b.medicine_id,b.expiry_date,b.received_quantity
     )
     SELECT m.id,m.name,m.category,m.unit,m.min_alert_level,
            COALESCE(SUM(s.remaining),0) AS current_stock,
            COALESCE(SUM(s.remaining) FILTER (WHERE s.expiry_date >= CURRENT_DATE),0) AS available_stock,
            MIN(s.expiry_date) FILTER (WHERE s.remaining > 0) AS nearest_expiry,
            MIN(s.expiry_date) FILTER (WHERE s.remaining > 0) AS expiry,
            (SELECT string_agg(DISTINCT b.batch_number, ' ')
             FROM medicine_batches b
             WHERE b.owner_id=m.owner_id AND b.medicine_id=m.id) AS batch_numbers
     FROM medicines m
     LEFT JOIN batch_stock s ON s.medicine_id=m.id AND s.owner_id=m.owner_id
     WHERE m.owner_id=$1
     GROUP BY m.id,m.name,m.category,m.unit,m.min_alert_level
     ORDER BY lower(m.name),m.id`,
    [ownerId]
  );
}

export async function createMedicine(ownerId: number, d: any) {
  const rows = await query(
    `INSERT INTO medicines(owner_id,name,category,unit,min_alert_level)
     VALUES($1,$2,$3,$4,$5) RETURNING id,name,category,unit,min_alert_level`,
    [ownerId, d.name, d.category, d.unit, d.min_alert_level]
  );
  return { ...rows[0], current_stock: 0, available_stock: 0, nearest_expiry: null, expiry: null };
}

export async function updateMedicine(ownerId: number, id: number, d: any) {
  return withTx(async (client) => {
    await lockOwner(client, ownerId);
    const existing = await client.query('SELECT unit FROM medicines WHERE id=$1 AND owner_id=$2 FOR UPDATE', [id, ownerId]);
    if (!existing.rows.length) throw new HttpError(404, 'Medicine not found');
    if (existing.rows[0].unit !== d.unit) {
      const history = await client.query('SELECT id FROM medicine_batches WHERE medicine_id=$1 AND owner_id=$2 LIMIT 1', [id, ownerId]);
      if (history.rows.length) throw new HttpError(400, 'Cannot change the unit after stock has been received');
    }
    const result = await client.query(
      `UPDATE medicines SET name=$3,category=$4,unit=$5,min_alert_level=$6
       WHERE id=$1 AND owner_id=$2 RETURNING id,name,category,unit,min_alert_level`,
      [id, ownerId, d.name, d.category, d.unit, d.min_alert_level]
    );
    return result.rows[0];
  });
}

export async function deleteMedicine(ownerId: number, id: number) {
  const rows = await query('DELETE FROM medicines WHERE id=$1 AND owner_id=$2 RETURNING id', [id, ownerId]);
  if (!rows.length) throw new HttpError(404, 'Medicine not found');
}

export async function receiveMedicine(ownerId: number, d: any) {
  return withTx(async (client) => {
    await lockOwner(client, ownerId);
    let medicine = d.medicine_id
      ? await client.query(
          'SELECT id,name,category,unit FROM medicines WHERE id=$1 AND owner_id=$2 FOR UPDATE',
          [d.medicine_id, ownerId]
        )
      : await client.query(
          'SELECT id,name,category,unit FROM medicines WHERE owner_id=$1 AND lower(trim(name))=lower(trim($2)) FOR UPDATE',
          [ownerId, d.medicine_name]
        );
    if (!d.medicine_id && !medicine.rows.length) {
      const created = await client.query(
        `INSERT INTO medicines(owner_id,name,category,unit)
         VALUES($1,$2,$3,$4) RETURNING id,name,category,unit`,
        [ownerId, d.medicine_name.trim(), d.category, d.unit]
      );
      medicine = created;
    }
    if (!medicine.rows.length) throw new HttpError(404, 'Medicine not found');
    if (medicine.rows[0].unit !== d.unit) throw new HttpError(400, 'Unit must match the medicine unit');
    if (d.category && medicine.rows[0].category !== d.category) {
      throw new HttpError(400, 'Category must match the selected medicine');
    }
    const result = await client.query(
      `INSERT INTO medicine_batches
       (owner_id,medicine_id,batch_number,expiry_date,received_quantity,unit,total_cost,received_date,remarks)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [ownerId, medicine.rows[0].id, d.batch_number, d.expiry_date, d.quantity, d.unit, d.total_cost, d.date, d.remarks]
    );
    await client.query(
      `INSERT INTO medicine_logs
       (owner_id,medicine_id,event_type,quantity,unit,log_date,remarks,batch_id,bill_image_url,bill_number,vendor_name)
       VALUES($1,$2,'INWARD',$3,$4,$5,$6,$7,$8,$9,$10)`,
      [ownerId, medicine.rows[0].id, d.quantity, d.unit, d.date, d.remarks, result.rows[0].id,
        d.bill_image_url, d.bill_number, d.vendor_name]
    );
    return result.rows[0];
  });
}

export async function createUsage(ownerId: number, d: any) {
  return withTx(async (client) => {
    await lockOwner(client, ownerId);
    const medicine = await client.query('SELECT id,unit FROM medicines WHERE id=$1 AND owner_id=$2 FOR UPDATE', [d.medicine_id, ownerId]);
    if (!medicine.rows.length) throw new HttpError(404, 'Medicine not found');
    if (medicine.rows[0].unit !== d.unit) throw new HttpError(400, 'Unit must match the medicine unit');
    const flock = await client.query('SELECT id FROM flock_batches WHERE id=$1 AND owner_id=$2', [d.flock_id, ownerId]);
    if (!flock.rows.length) throw new HttpError(404, 'Flock batch not found');
    const batches = await client.query(
      `SELECT b.id,b.expiry_date,b.batch_number,
              b.received_quantity-COALESCE((SELECT SUM(a.quantity) FROM medicine_usage_allocations a
                 WHERE a.batch_id=b.id AND a.owner_id=$1),0) AS remaining
       FROM medicine_batches b
       WHERE b.owner_id=$1 AND b.medicine_id=$2 AND b.expiry_date >= CURRENT_DATE
       ORDER BY b.expiry_date,b.id FOR UPDATE`,
      [ownerId, d.medicine_id]
    );
    const usable = batches.rows.filter((b: any) => Number(b.remaining) > 0);
    const available = usable.reduce((sum: number, b: any) => sum + Number(b.remaining), 0);
    if (available + 0.0005 < d.quantity) {
      throw new HttpError(400, `Insufficient non-expired stock (${available} ${d.unit} available)`);
    }
    const usage = await client.query(
      `INSERT INTO medicine_usage(owner_id,medicine_id,usage_date,quantity,unit,flock_id,admin_route,remarks)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [ownerId, d.medicine_id, d.date, d.quantity, d.unit, d.flock_id, d.admin_route, d.remarks]
    );
    let remainingToAllocate = d.quantity;
    const allocations = [];
    for (const batch of usable) {
      if (remainingToAllocate <= 0.0005) break;
      const allocated = Math.min(remainingToAllocate, Number(batch.remaining));
      await client.query(
        'INSERT INTO medicine_usage_allocations(owner_id,usage_id,batch_id,quantity) VALUES($1,$2,$3,$4)',
        [ownerId, usage.rows[0].id, batch.id, allocated]
      );
      allocations.push({ batch_id: batch.id, batch_number: batch.batch_number, expiry_date: batch.expiry_date, quantity: allocated });
      remainingToAllocate = Math.round((remainingToAllocate - allocated) * 1000) / 1000;
    }
    await client.query(
      `INSERT INTO medicine_logs
       (owner_id,medicine_id,event_type,quantity,unit,flock_id,admin_route,log_date,remarks,usage_id)
       VALUES($1,$2,'USED',$3,$4,$5,$6,$7,$8,$9)`,
      [ownerId, d.medicine_id, d.quantity, d.unit, d.flock_id, d.admin_route, d.date, d.remarks, usage.rows[0].id]
    );
    return { ...usage.rows[0], allocations };
  });
}

export async function listUsage(ownerId: number, from?: string, to?: string) {
  const rows = await query(
    `SELECT u.*,m.name AS medicine_name,f.batch_name AS flock_name
     FROM medicine_usage u
     JOIN medicines m ON m.id=u.medicine_id AND m.owner_id=u.owner_id
     JOIN flock_batches f ON f.id=u.flock_id AND f.owner_id=u.owner_id
     WHERE u.owner_id=$1 AND ($2::date IS NULL OR u.usage_date >= $2::date)
       AND ($3::date IS NULL OR u.usage_date <= $3::date)
     ORDER BY u.usage_date DESC,u.id DESC`,
    [ownerId, from ?? null, to ?? null]
  );
  if (!rows.length) return [];
  const allocations = await query(
    `SELECT a.usage_id,a.batch_id,b.batch_number,b.expiry_date,a.quantity
     FROM medicine_usage_allocations a
     JOIN medicine_batches b ON b.id=a.batch_id AND b.owner_id=a.owner_id
     WHERE a.owner_id=$1 AND a.usage_id=ANY($2::bigint[]) ORDER BY a.id`,
    [ownerId, rows.map((row: any) => row.id)]
  );
  return rows.map((row: any) => ({
    ...row,
    allocations: allocations.filter((a: any) => a.usage_id === row.id)
      .map((a: any) => ({ batch_id: a.batch_id, batch_number: a.batch_number, expiry_date: a.expiry_date, quantity: a.quantity })),
  }));
}

export async function listLogs(ownerId: number, from?: string, to?: string) {
  return query(
    `SELECT l.*,l.event_type AS transaction_type,l.log_date AS transaction_date,
            m.name AS medicine_name,m.category AS medicine_category,
            b.batch_number,b.expiry_date,b.total_cost,
            f.batch_name AS flock_name,
            CASE WHEN l.usage_id IS NULL THEN NULL
                 ELSE (SELECT json_agg(json_build_object(
                   'batch_id',a.batch_id,'batch_number',ab.batch_number,
                   'expiry_date',ab.expiry_date,'quantity',a.quantity
                 ) ORDER BY a.id)
                 FROM medicine_usage_allocations a
                 JOIN medicine_batches ab ON ab.id=a.batch_id AND ab.owner_id=a.owner_id
                 WHERE a.owner_id=l.owner_id AND a.usage_id=l.usage_id)
            END AS allocations
     FROM medicine_logs l
     JOIN medicines m ON m.id=l.medicine_id AND m.owner_id=l.owner_id
     LEFT JOIN medicine_batches b ON b.id=l.batch_id AND b.owner_id=l.owner_id
     LEFT JOIN flock_batches f ON f.id=l.flock_id AND f.owner_id=l.owner_id
     WHERE l.owner_id=$1 AND ($2::date IS NULL OR l.log_date >= $2::date)
       AND ($3::date IS NULL OR l.log_date <= $3::date)
     ORDER BY l.log_date DESC,l.id DESC`,
    [ownerId, from ?? null, to ?? null]
  );
}
