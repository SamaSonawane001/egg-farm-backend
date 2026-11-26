import { PoolClient } from 'pg';
import { query, withTx } from '../config/db';
import { getFarmContext } from '../config/farmContext';
import { HttpError } from '../utils/httpError';

const lockOwner = (client: PoolClient, ownerId: string) =>
  client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))', [ownerId]);
const stockCost = (quantity: number, d: any) =>
  Math.round((d.rate_per_unit == null ? Number(d.total_cost) : quantity * Number(d.rate_per_unit)) * 100) / 100;

async function inventoryContext(client: PoolClient, ownerId: string) {
  const activeFarmId = getFarmContext()?.farmId;
  if (!activeFarmId) {
    throw new HttpError(409, 'Select an individual farm to manage inventory');
  }
  const result = await client.query<{
    shared_inventory_enabled: boolean;
    primary_farm_id: string;
  }>(
    `SELECT u.shared_inventory_enabled,p.id AS primary_farm_id
     FROM users u
     JOIN farms active_farm
       ON active_farm.id=$2::uuid AND active_farm.owner_user_id=u.id
     LEFT JOIN LATERAL (
       SELECT f.id FROM farms f WHERE f.owner_user_id=u.id
       ORDER BY f.is_primary DESC,f.created_at,f.id LIMIT 1
     ) p ON TRUE
     WHERE u.id=$1::uuid`,
    [ownerId, activeFarmId],
  );
  if (!result.rows.length) throw new HttpError(404, 'Farm profile not found');
  return {
    enabled: result.rows[0].shared_inventory_enabled === true,
    primaryFarmId: result.rows[0].primary_farm_id,
    activeFarmId,
  };
}

function quantityInMedicineUnit(quantity: number, fromUnit: string, medicineUnit: string) {
  const sameDimension =
    (fromUnit === 'L' || fromUnit === 'ml') ===
    (medicineUnit === 'L' || medicineUnit === 'ml');
  if (!sameDimension) throw new HttpError(400, 'Inward unit must match the medicine dimension');
  const factor =
    fromUnit === medicineUnit
      ? 1
      : fromUnit === 'L' || fromUnit === 'kg'
        ? 1000
        : 0.001;
  return Math.round(quantity * factor * 1000) / 1000;
}

export async function listMedicines(ownerId: string) {
  const activeFarmId = getFarmContext()?.farmId ?? null;
  return query(
    `WITH batch_stock AS (
       SELECT b.id,b.owner_id,b.medicine_id,b.expiry_date,b.received_quantity,
              b.received_quantity-COALESCE(SUM(a.quantity),0) AS remaining
       FROM medicine_batches b
       LEFT JOIN medicine_usage_allocations a ON a.batch_id=b.id AND a.owner_id=b.owner_id
       WHERE b.owner_id=$1
       GROUP BY b.id,b.owner_id,b.medicine_id,b.expiry_date,b.received_quantity
     )
     SELECT m.id,m.name,m.category,m.unit,m.min_alert_level,m.is_shared_pool,
            COALESCE(SUM(s.received_quantity),0) AS total_purchased,
            COALESCE((SELECT SUM(u.quantity) FROM medicine_usage u
                      WHERE u.owner_id=m.owner_id AND u.medicine_id=m.id),0) AS total_consumed,
            COALESCE(SUM(s.remaining),0) AS current_stock,
            COALESCE(SUM(s.remaining) FILTER (WHERE s.expiry_date >= CURRENT_DATE),0) AS available_stock,
            MIN(s.expiry_date) FILTER (WHERE s.remaining > 0) AS nearest_expiry,
            MIN(s.expiry_date) FILTER (WHERE s.remaining > 0) AS expiry,
            (SELECT string_agg(DISTINCT b.batch_number, ' ')
             FROM medicine_batches b
             WHERE b.owner_id=m.owner_id AND b.medicine_id=m.id) AS batch_numbers
     FROM medicines m
     JOIN farms owner_farm
       ON owner_farm.id=m.farm_id AND owner_farm.owner_user_id=m.owner_id
     LEFT JOIN batch_stock s ON s.medicine_id=m.id AND s.owner_id=m.owner_id
     WHERE m.owner_id=$1
       AND ($2::uuid IS NULL OR owner_farm.id=$2
         OR (m.is_shared_pool=TRUE AND EXISTS (
           SELECT 1 FROM users u
           WHERE u.id=m.owner_id AND u.shared_inventory_enabled=TRUE
         )))
     GROUP BY m.id,m.name,m.category,m.unit,m.min_alert_level,m.is_shared_pool
     ORDER BY lower(m.name),m.id`,
    [ownerId, activeFarmId]
  );
}

export async function getMedicineDetails(
  ownerId: string,
  id: string,
  monthStart: string,
) {
  const activeFarmId = getFarmContext()?.farmId ?? null;
  const [medicineRows, purchases, usage] = await Promise.all([
    query(
      `WITH batch_stock AS (
         SELECT b.id,b.owner_id,b.medicine_id,b.expiry_date,b.received_quantity,
                b.received_quantity-COALESCE(SUM(a.quantity),0) AS remaining
         FROM medicine_batches b
         LEFT JOIN medicine_usage_allocations a
           ON a.batch_id=b.id AND a.owner_id=b.owner_id
         WHERE b.owner_id=$1 AND b.medicine_id=$2
         GROUP BY b.id,b.owner_id,b.medicine_id,b.expiry_date,b.received_quantity
       )
       SELECT m.id,m.name,m.category,m.unit,m.min_alert_level,m.is_shared_pool,
              COALESCE((SELECT SUM(b.received_quantity)
                        FROM medicine_batches b
                        WHERE b.owner_id=m.owner_id AND b.medicine_id=m.id),0) AS total_purchased,
              COALESCE((SELECT SUM(u.quantity)
                        FROM medicine_usage u
                        WHERE u.owner_id=m.owner_id AND u.medicine_id=m.id),0) AS total_consumed,
              COALESCE((SELECT SUM(s.remaining) FROM batch_stock s),0) AS current_stock,
              COALESCE((SELECT SUM(s.remaining) FROM batch_stock s
                        WHERE s.expiry_date >= CURRENT_DATE),0) AS available_stock,
              COALESCE((SELECT SUM(b.total_cost)
                        FROM medicine_batches b
                        WHERE b.owner_id=m.owner_id AND b.medicine_id=m.id),0) AS total_spent,
              COALESCE((SELECT SUM(u.quantity)
                        FROM medicine_usage u
                        WHERE u.owner_id=m.owner_id AND u.medicine_id=m.id
                          AND u.usage_date >= $3::date
                          AND u.usage_date < ($3::date + INTERVAL '1 month')),0) AS monthly_used,
              MIN(s.expiry_date) FILTER (WHERE s.remaining > 0) AS nearest_expiry
       FROM medicines m
       JOIN farms owner_farm
         ON owner_farm.id=m.farm_id AND owner_farm.owner_user_id=m.owner_id
       LEFT JOIN batch_stock s ON s.medicine_id=m.id AND s.owner_id=m.owner_id
       WHERE m.owner_id=$1 AND m.id=$2
         AND ($4::uuid IS NULL OR owner_farm.id=$4
           OR (m.is_shared_pool=TRUE AND EXISTS (
             SELECT 1 FROM users u
             WHERE u.id=m.owner_id AND u.shared_inventory_enabled=TRUE
           )))
       GROUP BY m.id`,
      [ownerId, id, monthStart, activeFarmId],
    ),
    query(
      `SELECT b.id,b.batch_number,b.expiry_date,b.received_quantity AS quantity,
              b.unit,b.total_cost,b.received_date AS date,b.remarks,
              COALESCE(b.entered_quantity,b.received_quantity) AS entered_quantity,
              COALESCE(b.entered_unit,b.unit) AS entered_unit,
              COALESCE(b.rate_per_unit,ROUND(b.total_cost/NULLIF(b.received_quantity,0),3)) AS rate_per_unit,
              l.bill_number,l.vendor_name
       FROM medicine_batches b
       LEFT JOIN medicine_logs l
         ON l.batch_id=b.id AND l.owner_id=b.owner_id
       WHERE b.owner_id=$1 AND b.medicine_id=$2
       ORDER BY b.received_date DESC,b.id DESC`,
      [ownerId, id],
    ),
    query(
      `SELECT u.id,u.usage_date AS date,u.quantity,u.unit,u.total_cost,u.flock_id,
              f.batch_name AS flock_name,u.admin_route,u.remarks,
              COALESCE((
                SELECT json_agg(json_build_object(
                  'batch_number',b.batch_number,
                  'expiry_date',b.expiry_date,
                  'quantity',a.quantity
                ) ORDER BY a.id)
                FROM medicine_usage_allocations a
                JOIN medicine_batches b
                  ON b.id=a.batch_id AND b.owner_id=a.owner_id
                WHERE a.owner_id=u.owner_id AND a.usage_id=u.id
              ), '[]'::json) AS allocations
       FROM medicine_usage u
       JOIN flock_batches f ON f.id=u.flock_id AND f.owner_id=u.owner_id
       WHERE u.owner_id=$1 AND u.medicine_id=$2
         AND ($3::uuid IS NULL OR u.farm_id=$3::uuid)
       ORDER BY u.usage_date DESC,u.id DESC`,
      [ownerId, id, activeFarmId],
    ),
  ]);
  if (!medicineRows.length) throw new HttpError(404, 'Medicine not found');
  return { medicine: medicineRows[0], purchases, usage };
}

export async function createMedicine(ownerId: string, d: any) {
  return withTx(async (client) => {
    await lockOwner(client, ownerId);
    const inventory = await inventoryContext(client, ownerId);
    const existing = await client.query(
      `SELECT id,category,unit FROM medicines
       WHERE owner_id=$1 AND lower(trim(name))=lower(trim($2))
         AND is_shared_pool=$3
         AND ($3::boolean OR farm_id=$4) FOR UPDATE`,
      [ownerId, d.name, inventory.enabled, inventory.activeFarmId]
    );
    const duplicate = existing.rows.length > 0;
    if (duplicate && (existing.rows[0].category !== d.category || existing.rows[0].unit !== d.unit)) {
      throw new HttpError(400, 'A medicine with this name already exists with a different category or unit');
    }
    if (!duplicate) {
      const inserted = await client.query(
        `INSERT INTO medicines(owner_id,farm_id,name,category,unit,min_alert_level,is_shared_pool)
         VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [ownerId, inventory.enabled ? inventory.primaryFarmId : inventory.activeFarmId,
          d.name, d.category, d.unit, d.min_alert_level, inventory.enabled]
      );
      existing.rows.push(inserted.rows[0]);
    }
    const result = await client.query(
      `WITH batch_stock AS (
         SELECT b.id,b.owner_id,b.medicine_id,b.expiry_date,b.received_quantity,
                b.received_quantity-COALESCE(SUM(a.quantity),0) AS remaining,
                b.batch_number
         FROM medicine_batches b
         LEFT JOIN medicine_usage_allocations a ON a.batch_id=b.id AND a.owner_id=b.owner_id
         WHERE b.owner_id=$1
         GROUP BY b.id,b.owner_id,b.medicine_id,b.expiry_date,b.received_quantity,b.batch_number
       )
       SELECT m.id,m.name,m.category,m.unit,m.min_alert_level,
              COALESCE(SUM(s.received_quantity),0) AS total_purchased,
              COALESCE((SELECT SUM(u.quantity) FROM medicine_usage u
                        WHERE u.owner_id=m.owner_id AND u.medicine_id=m.id),0) AS total_consumed,
              COALESCE(SUM(s.remaining),0) AS current_stock,
              COALESCE(SUM(s.remaining) FILTER (WHERE s.expiry_date >= CURRENT_DATE),0) AS available_stock,
              MIN(s.expiry_date) FILTER (WHERE s.remaining > 0) AS nearest_expiry,
              MIN(s.expiry_date) FILTER (WHERE s.remaining > 0) AS expiry,
              (SELECT string_agg(DISTINCT b.batch_number, ' ')
               FROM medicine_batches b
               WHERE b.owner_id=m.owner_id AND b.medicine_id=m.id) AS batch_numbers
       FROM medicines m
       LEFT JOIN batch_stock s ON s.medicine_id=m.id AND s.owner_id=m.owner_id
       WHERE m.owner_id=$1 AND m.id=$2
       GROUP BY m.id,m.name,m.category,m.unit,m.min_alert_level`,
      [ownerId, existing.rows[0].id]
    );
    return { ...result.rows[0], duplicate };
  });
}

export async function updateMedicine(ownerId: string, id: string, d: any) {
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

export async function deleteMedicine(ownerId: string, id: string) {
  const rows = await query('DELETE FROM medicines WHERE id=$1 AND owner_id=$2 RETURNING id', [id, ownerId]);
  if (!rows.length) throw new HttpError(404, 'Medicine not found');
}

export async function receiveMedicine(ownerId: string, d: any) {
  return withTx(async (client) => {
    await lockOwner(client, ownerId);
    const inventory = await inventoryContext(client, ownerId);
    let medicine = d.medicine_id
      ? await client.query(
          `SELECT id,name,category,unit,is_shared_pool FROM medicines
           WHERE id=$1 AND owner_id=$2 AND is_shared_pool=$3
             AND ($3::boolean OR farm_id=$4) FOR UPDATE`,
          [d.medicine_id, ownerId, inventory.enabled, inventory.activeFarmId]
        )
      : await client.query(
          `SELECT id,name,category,unit,is_shared_pool FROM medicines
           WHERE owner_id=$1 AND lower(trim(name))=lower(trim($2))
               AND is_shared_pool=$3
               AND ($3::boolean OR farm_id=$4) FOR UPDATE`,
          [ownerId, d.medicine_name, inventory.enabled, inventory.activeFarmId]
        );
    if (!d.medicine_id && !medicine.rows.length) {
      const created = await client.query(
        `INSERT INTO medicines(owner_id,farm_id,name,category,unit,is_shared_pool)
         VALUES($1,$2,$3,$4,$5,$6) RETURNING id,name,category,unit,is_shared_pool`,
        [ownerId, inventory.enabled ? inventory.primaryFarmId : inventory.activeFarmId,
          d.medicine_name.trim(), d.category, d.unit, inventory.enabled]
      );
      medicine = created;
    }
    if (!medicine.rows.length) throw new HttpError(404, 'Medicine not found');
    if (d.category && medicine.rows[0].category !== d.category) {
      throw new HttpError(400, 'Category must match the selected medicine');
    }
    const medicineUnit = medicine.rows[0].unit;
    const stockQuantity = quantityInMedicineUnit(d.quantity, d.unit, medicineUnit);
    const totalCost = stockCost(d.quantity, d);
    const result = await client.query(
      `INSERT INTO medicine_batches
       (owner_id,farm_id,is_shared_pool,medicine_id,batch_number,expiry_date,received_quantity,unit,total_cost,received_date,remarks,
        entered_quantity,entered_unit,rate_per_unit)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [ownerId, inventory.enabled ? inventory.primaryFarmId : inventory.activeFarmId,
        inventory.enabled, medicine.rows[0].id, d.batch_number, d.expiry_date, stockQuantity,
        medicineUnit, totalCost, d.date, d.remarks, d.quantity, d.unit,
        d.rate_per_unit ?? totalCost / d.quantity]
    );
    await client.query(
      `INSERT INTO medicine_logs
       (owner_id,farm_id,is_shared_pool,medicine_id,event_type,quantity,unit,log_date,remarks,batch_id,bill_number,vendor_name)
       VALUES($1,$2,$3,$4,'INWARD',$5,$6,$7,$8,$9,$10,$11)`,
      [ownerId, inventory.enabled ? inventory.primaryFarmId : inventory.activeFarmId,
        inventory.enabled, medicine.rows[0].id, stockQuantity, medicineUnit, d.date,
        d.remarks, result.rows[0].id,
        d.bill_number, d.vendor_name]
    );
    return result.rows[0];
  });
}

export async function updateMedicineBatch(
  ownerId: string,
  medicineId: string,
  batchId: string,
  d: any,
) {
  return withTx(async (client) => {
    await lockOwner(client, ownerId);
    const batch = await client.query(
      `SELECT b.id,b.received_quantity,b.unit,m.unit AS medicine_unit,
              COALESCE((
                SELECT SUM(a.quantity)
                FROM medicine_usage_allocations a
                WHERE a.batch_id=b.id AND a.owner_id=b.owner_id
              ),0) AS consumed
       FROM medicine_batches b
       JOIN medicines m ON m.id=b.medicine_id AND m.owner_id=b.owner_id
       WHERE b.owner_id=$1 AND b.medicine_id=$2 AND b.id=$3
       FOR UPDATE OF b`,
      [ownerId, medicineId, batchId],
    );
    if (!batch.rows.length) throw new HttpError(404, 'Medicine batch not found');
    const medicineUnit = batch.rows[0].medicine_unit;
    const stockQuantity = quantityInMedicineUnit(d.quantity, d.unit, medicineUnit);
    if (stockQuantity + 0.0005 < Number(batch.rows[0].consumed)) {
      throw new HttpError(400, 'Received quantity cannot be below the quantity already used from this batch');
    }
    const totalCost = stockCost(d.quantity, d);
    const updated = await client.query(
      `UPDATE medicine_batches
       SET batch_number=$4,expiry_date=$5,received_quantity=$6,total_cost=$7,
           received_date=$8,remarks=$9,unit=$10,entered_quantity=$11,
           entered_unit=$12,rate_per_unit=$13
       WHERE owner_id=$1 AND medicine_id=$2 AND id=$3
       RETURNING *`,
      [
        ownerId,
        medicineId,
        batchId,
        d.batch_number,
        d.expiry_date,
        stockQuantity,
        totalCost,
        d.date,
        d.remarks,
        medicineUnit,
        d.quantity,
        d.unit,
        d.rate_per_unit ?? totalCost / d.quantity,
      ],
    );
    await client.query(
      `UPDATE medicine_logs
       SET quantity=$4,unit=$5,log_date=$6,remarks=$7,
           bill_number=$8,vendor_name=$9
       WHERE owner_id=$1 AND medicine_id=$2 AND batch_id=$3`,
      [
        ownerId,
        medicineId,
        batchId,
        stockQuantity,
        medicineUnit,
        d.date,
        d.remarks,
        d.bill_number,
        d.vendor_name,
      ],
    );
    return updated.rows[0];
  });
}

export async function deleteMedicineBatch(
  ownerId: string,
  medicineId: string,
  batchId: string,
) {
  return withTx(async (client) => {
    await lockOwner(client, ownerId);
    const batch = await client.query(
      `SELECT b.id,
              EXISTS (
                SELECT 1 FROM medicine_usage_allocations a
                WHERE a.owner_id=b.owner_id AND a.batch_id=b.id
              ) AS has_usage
       FROM medicine_batches b
       WHERE b.owner_id=$1 AND b.medicine_id=$2 AND b.id=$3
       FOR UPDATE`,
      [ownerId, medicineId, batchId],
    );
    if (!batch.rows.length) throw new HttpError(404, 'Medicine batch not found');
    if (batch.rows[0].has_usage) {
      throw new HttpError(400, 'Cannot delete a batch that has already been used');
    }
    await client.query(
      'DELETE FROM medicine_logs WHERE owner_id=$1 AND medicine_id=$2 AND batch_id=$3',
      [ownerId, medicineId, batchId],
    );
    await client.query(
      'DELETE FROM medicine_batches WHERE owner_id=$1 AND medicine_id=$2 AND id=$3',
      [ownerId, medicineId, batchId],
    );
  });
}

export async function createUsage(ownerId: string, d: any) {
  return withTx(async (client) => {
    await lockOwner(client, ownerId);
    const inventory = await inventoryContext(client, ownerId);
    const medicine = await client.query(
      `SELECT m.id,m.unit,m.is_shared_pool
       FROM medicines m
       JOIN farms f ON f.id=m.farm_id AND f.owner_user_id=m.owner_id
       WHERE m.id=$1 AND m.owner_id=$2
         AND (m.farm_id=$3 OR (m.is_shared_pool=TRUE AND $4::boolean))
       FOR UPDATE OF m`,
      [d.medicine_id, ownerId, inventory.activeFarmId, inventory.enabled],
    );
    if (!medicine.rows.length) throw new HttpError(404, 'Medicine not found');
    if (medicine.rows[0].is_shared_pool && !inventory.enabled) {
      throw new HttpError(409, 'Enable Central Godown to consume shared stock');
    }
    if (medicine.rows[0].unit !== d.unit) throw new HttpError(400, 'Unit must match the medicine unit');
    const flock = await client.query(
      'SELECT id FROM flock_batches WHERE id=$1 AND owner_id=$2 AND farm_id=$3',
      [d.flock_id, ownerId, inventory.activeFarmId],
    );
    if (!flock.rows.length) throw new HttpError(404, 'Flock batch not found');
    const batches = await client.query(
      `SELECT b.id,b.expiry_date,b.batch_number,b.received_quantity,b.total_cost,
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
      `INSERT INTO medicine_usage
       (owner_id,farm_id,is_shared_pool,medicine_id,usage_date,quantity,unit,flock_id,admin_route,remarks,total_cost)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0) RETURNING *`,
      [ownerId, inventory.activeFarmId, Boolean(medicine.rows[0].is_shared_pool),
        d.medicine_id, d.date, d.quantity, d.unit, d.flock_id, d.admin_route, d.remarks]
    );
    let remainingToAllocate = d.quantity;
    let totalCost = 0;
    const allocations = [];
    for (const batch of usable) {
      if (remainingToAllocate <= 0.0005) break;
      const allocated = Math.min(remainingToAllocate, Number(batch.remaining));
      await client.query(
        `INSERT INTO medicine_usage_allocations
         (owner_id,farm_id,is_shared_pool,usage_id,batch_id,quantity)
         VALUES($1,$2,$3,$4,$5,$6)`,
        [ownerId, inventory.activeFarmId, Boolean(medicine.rows[0].is_shared_pool),
          usage.rows[0].id, batch.id, allocated]
      );
      totalCost += allocated * Number(batch.total_cost) /
        Number(batch.received_quantity);
      allocations.push({ batch_id: batch.id, batch_number: batch.batch_number, expiry_date: batch.expiry_date, quantity: allocated });
      remainingToAllocate = Math.round((remainingToAllocate - allocated) * 1000) / 1000;
    }
    totalCost = Math.round(totalCost * 100) / 100;
    await client.query(
      'UPDATE medicine_usage SET total_cost=$3 WHERE id=$1 AND owner_id=$2',
      [usage.rows[0].id, ownerId, totalCost],
    );
    await client.query(
      `INSERT INTO medicine_logs
       (owner_id,farm_id,is_shared_pool,medicine_id,event_type,quantity,unit,flock_id,admin_route,log_date,remarks,usage_id)
       VALUES($1,$2,$3,$4,'USED',$5,$6,$7,$8,$9,$10,$11)`,
      [ownerId, inventory.activeFarmId, Boolean(medicine.rows[0].is_shared_pool),
        d.medicine_id, d.quantity, d.unit, d.flock_id, d.admin_route, d.date,
        d.remarks, usage.rows[0].id]
    );
    return { ...usage.rows[0], total_cost: totalCost, allocations };
  });
}

export async function listUsage(ownerId: string, from?: string, to?: string) {
  const activeFarmId = getFarmContext()?.farmId ?? null;
  const rows = await query(
    `SELECT u.*,m.name AS medicine_name,f.batch_name AS flock_name
     FROM medicine_usage u
     JOIN medicines m ON m.id=u.medicine_id AND m.owner_id=u.owner_id
     JOIN flock_batches f ON f.id=u.flock_id AND f.owner_id=u.owner_id
     WHERE u.owner_id=$1 AND ($2::date IS NULL OR u.usage_date >= $2::date)
       AND ($3::date IS NULL OR u.usage_date <= $3::date)
       AND ($4::uuid IS NULL OR u.farm_id=$4::uuid)
     ORDER BY u.usage_date DESC,u.id DESC`,
    [ownerId, from ?? null, to ?? null, activeFarmId]
  );
  if (!rows.length) return [];
  const allocations = await query(
    `SELECT a.usage_id,a.batch_id,b.batch_number,b.expiry_date,a.quantity
     FROM medicine_usage_allocations a
     JOIN medicine_batches b ON b.id=a.batch_id AND b.owner_id=a.owner_id
     WHERE a.owner_id=$1 AND a.usage_id=ANY($2::uuid[]) ORDER BY a.id`,
    [ownerId, rows.map((row: any) => row.id)]
  );
  return rows.map((row: any) => ({
    ...row,
    allocations: allocations.filter((a: any) => a.usage_id === row.id)
      .map((a: any) => ({ batch_id: a.batch_id, batch_number: a.batch_number, expiry_date: a.expiry_date, quantity: a.quantity })),
  }));
}

export async function listLogs(ownerId: string, from?: string, to?: string) {
  const activeFarmId = getFarmContext()?.farmId ?? null;
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
       AND ($4::uuid IS NULL OR l.event_type='INWARD' OR l.farm_id=$4::uuid)
     ORDER BY l.log_date DESC,l.id DESC`,
    [ownerId, from ?? null, to ?? null, activeFarmId]
  );
}
