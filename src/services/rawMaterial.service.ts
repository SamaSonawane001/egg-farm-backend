import { PoolClient } from 'pg';
import { query, withTx } from '../config/db';
import { HttpError } from '../utils/httpError';

const lockOwner = (client: PoolClient, ownerId: string) =>
  client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))', [ownerId]);

export async function listMaterials(ownerId: string) {
  return query(
    `SELECT m.id, m.name, m.unit, m.min_alert_threshold,
            COALESCE(SUM(t.quantity) FILTER (WHERE t.transaction_type='INWARD'),0) AS total_purchased,
            COALESCE(SUM(t.quantity) FILTER (WHERE t.transaction_type='OUTWARD_PROCESSING'),0) AS total_consumed,
            COALESCE(SUM(CASE WHEN t.transaction_type='INWARD' THEN t.quantity ELSE -t.quantity END),0) AS current_stock,
            COALESCE(SUM(t.total_amount) FILTER (WHERE t.transaction_type='INWARD'),0) AS total_spent,
            CASE WHEN COALESCE(SUM(t.quantity) FILTER (WHERE t.transaction_type='INWARD'),0)>0
                 THEN COALESCE(SUM(t.total_amount) FILTER (WHERE t.transaction_type='INWARD'),0)
                      / SUM(t.quantity) FILTER (WHERE t.transaction_type='INWARD')
                 ELSE 0 END AS average_unit_cost
     FROM raw_materials m
     LEFT JOIN raw_material_logs t ON t.material_id=m.id AND t.owner_id=m.owner_id
     WHERE m.owner_id=$1
     GROUP BY m.id, m.name, m.unit, m.min_alert_threshold
     ORDER BY lower(m.name), m.id`,
    [ownerId]
  );
}

export async function getMaterialDetails(ownerId: string, id: string, month: string) {
  const [materialRows, transactions] = await Promise.all([
    query(
      `SELECT m.id, m.name, m.unit, m.min_alert_threshold,
              COALESCE(SUM(t.quantity) FILTER (WHERE t.transaction_type='INWARD'),0) AS total_purchased,
              COALESCE(SUM(t.quantity) FILTER (WHERE t.transaction_type='OUTWARD_PROCESSING'),0) AS total_consumed,
              COALESCE(SUM(CASE WHEN t.transaction_type='INWARD' THEN t.quantity ELSE -t.quantity END),0) AS current_stock,
              COALESCE(SUM(t.total_amount) FILTER (WHERE t.transaction_type='INWARD'),0) AS total_spent,
              COALESCE(SUM(t.quantity) FILTER (
                WHERE t.transaction_type='OUTWARD_PROCESSING'
                  AND t.transaction_date >= $3::date
                  AND t.transaction_date < ($3::date + INTERVAL '1 month')
              ),0) AS monthly_consumed
       FROM raw_materials m
       LEFT JOIN raw_material_logs t ON t.material_id=m.id AND t.owner_id=m.owner_id
       WHERE m.owner_id=$1 AND m.id=$2
       GROUP BY m.id`,
      [ownerId, id, `${month}-01`]
    ),
    query(
      `SELECT t.*,
              p.produced_quantity, p.produced_unit, p.quantity_bags,
              f.name AS feed_product_name,
              COALESCE((
                SELECT json_agg(json_build_object(
                  'material_id', ingredient.material_id,
                  'name', ingredient_material.name,
                  'unit', ingredient.unit,
                  'quantity', ingredient.quantity
                ) ORDER BY ingredient.id)
                FROM raw_material_logs ingredient
                JOIN raw_materials ingredient_material
                  ON ingredient_material.id=ingredient.material_id
                 AND ingredient_material.owner_id=ingredient.owner_id
                WHERE ingredient.owner_id=t.owner_id
                  AND ingredient.processing_id=t.processing_id
                  AND ingredient.transaction_type='OUTWARD_PROCESSING'
              ), '[]'::json) AS materials
       FROM raw_material_logs t
       LEFT JOIN raw_material_processing p
         ON p.id=t.processing_id AND p.owner_id=t.owner_id
       LEFT JOIN feed_products f
         ON f.id=p.feed_product_id AND f.owner_id=p.owner_id
       WHERE t.owner_id=$1 AND t.material_id=$2
       ORDER BY t.transaction_date DESC, t.id DESC`,
      [ownerId, id]
    ),
  ]);
  if (!materialRows.length) throw new HttpError(404, 'Raw material not found');
  return { material: materialRows[0], transactions };
}

export async function createMaterial(ownerId: string, d: any) {
  return withTx(async (client) => {
    await lockOwner(client, ownerId);
    const existing = await client.query(
      'SELECT id FROM raw_materials WHERE owner_id=$1 AND lower(trim(name))=lower(trim($2)) FOR UPDATE',
      [ownerId, d.name]
    );
    const duplicate = existing.rows.length > 0;
    if (!existing.rows.length) {
      const inserted = await client.query(
        `INSERT INTO raw_materials(owner_id,name,unit,min_alert_threshold)
         VALUES($1,$2,'kg',$3) RETURNING id`,
        [ownerId, d.name, d.min_alert_threshold]
      );
      existing.rows.push(inserted.rows[0]);
    }
    const summary = await client.query(
      `SELECT m.id,m.name,m.unit,m.min_alert_threshold,
              COALESCE(SUM(t.quantity) FILTER (WHERE t.transaction_type='INWARD'),0) AS total_purchased,
              COALESCE(SUM(t.quantity) FILTER (WHERE t.transaction_type='OUTWARD_PROCESSING'),0) AS total_consumed,
              COALESCE(SUM(CASE WHEN t.transaction_type='INWARD' THEN t.quantity ELSE -t.quantity END),0) AS current_stock
       FROM raw_materials m
       LEFT JOIN raw_material_logs t ON t.owner_id=m.owner_id AND t.material_id=m.id
       WHERE m.owner_id=$1 AND m.id=$2
       GROUP BY m.id`,
      [ownerId, existing.rows[0].id]
    );
    return { ...summary.rows[0], duplicate };
  });
}

export async function updateMaterial(ownerId: string, id: string, d: any) {
  return withTx(async (client) => {
    await lockOwner(client, ownerId);
    const existing = await client.query('SELECT id FROM raw_materials WHERE id=$1 AND owner_id=$2 FOR UPDATE', [id, ownerId]);
    if (!existing.rows.length) throw new HttpError(404, 'Raw material not found');
    const result = await client.query(
      `UPDATE raw_materials SET name=$3,unit='kg',min_alert_threshold=$4
       WHERE id=$1 AND owner_id=$2 RETURNING id,name,unit,min_alert_threshold`,
      [id, ownerId, d.name, d.min_alert_threshold]
    );
    return result.rows[0];
  });
}

export async function deleteMaterial(ownerId: string, id: string) {
  const rows = await query('DELETE FROM raw_materials WHERE id=$1 AND owner_id=$2 RETURNING id', [id, ownerId]);
  if (!rows.length) throw new HttpError(404, 'Raw material not found');
}

export async function listLogs(ownerId: string, from?: string, to?: string) {
  return query(
    `SELECT t.*, m.name AS material_name
     FROM raw_material_logs t
     JOIN raw_materials m ON m.id=t.material_id AND m.owner_id=t.owner_id
     WHERE t.owner_id=$1 AND ($2::date IS NULL OR t.transaction_date >= $2::date)
       AND ($3::date IS NULL OR t.transaction_date <= $3::date)
     ORDER BY t.transaction_date DESC,t.id DESC`,
    [ownerId, from ?? null, to ?? null]
  );
}

export async function receiveMaterial(ownerId: string, d: any) {
  return withTx(async (client) => {
    await lockOwner(client, ownerId);
    const settings = await client.query(
      'SELECT kg_per_bag FROM users WHERE id=$1',
      [ownerId],
    );
    const kgPerBag = Number(d.kg_per_bag ?? settings.rows[0]?.kg_per_bag ?? 50) || 50;
    const factor = d.unit === 'quintal' ? 100 : d.unit === 'bags' ? kgPerBag : 1;
    const quantityKg = Math.round(d.quantity * factor * 1000) / 1000;
    let material = d.material_id
      ? await client.query(
          'SELECT id,name,unit FROM raw_materials WHERE id=$1 AND owner_id=$2 FOR UPDATE',
          [d.material_id, ownerId]
        )
      : await client.query(
          'SELECT id,name,unit FROM raw_materials WHERE owner_id=$1 AND lower(trim(name))=lower(trim($2)) FOR UPDATE',
          [ownerId, d.material_name]
        );
    if (!d.material_id && !material.rows.length) {
      const created = await client.query(
        `INSERT INTO raw_materials(owner_id,name,unit)
         VALUES($1,$2,'kg') RETURNING id,name,unit`,
        [ownerId, d.material_name.trim()]
      );
      material = created;
    }
    if (!material.rows.length) throw new HttpError(404, 'Raw material not found');
    if (material.rows[0].unit !== 'kg') {
      throw new HttpError(500, 'Raw material has not been migrated to kilogram stock');
    }
    const totalAmount = Math.round(d.quantity * d.rate_per_unit * 100) / 100;
    const result = await client.query(
      `INSERT INTO raw_material_logs
       (owner_id,material_id,transaction_type,quantity,unit,transaction_date,supplier,rate_per_unit,total_amount,remarks,
        bill_number,vendor_name,entered_quantity,entered_unit,entered_kg_per_unit)
       VALUES($1,$2,'INWARD',$3,'kg',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [ownerId, material.rows[0].id, quantityKg, d.date, d.supplier, d.rate_per_unit, totalAmount, d.remarks,
        d.bill_number, d.vendor_name ?? (d.supplier?.length <= 150 ? d.supplier : null),
        d.quantity, d.unit, d.unit === 'bags' ? kgPerBag : null]
    );
    return { ...result.rows[0], kg_per_bag: kgPerBag };
  });
}

export async function listProcessing(ownerId: string) {
  const operations = await query(
    `SELECT p.*, f.name AS feed_product_name
     FROM raw_material_processing p
     JOIN feed_products f ON f.id=p.feed_product_id AND f.owner_id=p.owner_id
     WHERE p.owner_id=$1 ORDER BY p.processing_date DESC,p.id DESC`,
    [ownerId]
  );
  if (!operations.length) return [];
  const materials = await query(
    `SELECT t.processing_id,t.material_id,m.name,m.unit,t.quantity
     FROM raw_material_logs t
     JOIN raw_materials m ON m.id=t.material_id AND m.owner_id=t.owner_id
     WHERE t.owner_id=$1 AND t.transaction_type='OUTWARD_PROCESSING'
       AND t.processing_id=ANY($2::uuid[])
     ORDER BY t.id`,
    [ownerId, operations.map((p: any) => p.id)]
  );
  return operations.map((p: any) => ({
    ...p,
    produced_quantity: p.produced_quantity ?? p.quantity_bags,
    produced_unit: p.produced_unit ?? 'bags',
    materials: materials
      .filter((m: any) => m.processing_id === p.id)
      .map((m: any) => ({ material_id: m.material_id, name: m.name, unit: m.unit, quantity: m.quantity })),
  }));
}

export async function processMaterials(ownerId: string, d: any) {
  return withTx(async (client) => {
    await lockOwner(client, ownerId);
    const materialResult = await client.query(
      'SELECT id,name,unit FROM raw_materials WHERE owner_id=$1 AND id=$2 FOR UPDATE',
      [ownerId, d.material_id],
    );
    if (!materialResult.rows.length) throw new HttpError(404, 'Raw material not found');
    const material = materialResult.rows[0];
    if (material.unit !== 'kg') {
      throw new HttpError(500, 'Raw material has not been migrated to kilogram stock');
    }

    const settings = await client.query('SELECT kg_per_bag FROM users WHERE id=$1', [ownerId]);
    const kgPerBag = Number(settings.rows[0]?.kg_per_bag ?? 50) || 50;
    const factor = d.unit === 'quintal' ? 100 : d.unit === 'bags' ? kgPerBag : 1;
    const quantityKg = Math.round(d.quantity * factor * 1000) / 1000;

    const stock = await client.query(
      `SELECT COALESCE(SUM(CASE WHEN transaction_type='INWARD' THEN quantity ELSE -quantity END),0) AS balance
       FROM raw_material_logs WHERE owner_id=$1 AND material_id=$2`,
      [ownerId, d.material_id],
    );
    const availableKg = Number(stock.rows[0].balance);
    if (availableKg + 0.0005 < quantityKg) {
      throw new HttpError(
        400,
        `Insufficient stock for ${material.name} (${availableKg} kg available)`,
      );
    }

    const feed = await client.query(
      'SELECT id,name FROM feed_products WHERE owner_id=$1 AND lower(trim(name))=lower(trim($2)) FOR UPDATE',
      [ownerId, material.name],
    );
    if (!feed.rows.length) {
      const created = await client.query(
        'INSERT INTO feed_products(owner_id,name) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING id,name',
        [ownerId, material.name.trim()],
      );
      if (created.rows.length) {
        feed.rows.push(created.rows[0]);
      } else {
        const existingFeed = await client.query(
          'SELECT id,name FROM feed_products WHERE owner_id=$1 AND lower(trim(name))=lower(trim($2)) FOR UPDATE',
          [ownerId, material.name],
        );
        if (!existingFeed.rows.length) {
          throw new HttpError(409, 'Could not create or find matching feed product');
        }
        feed.rows.push(existingFeed.rows[0]);
      }
    }

    const feedBags = Math.round((quantityKg / kgPerBag) * 100) / 100;
    if (!Number.isFinite(feedBags) || feedBags <= 0) {
      throw new HttpError(400, 'Consumed quantity is too small to add to feed inventory');
    }
    const operation = await client.query(
      `INSERT INTO raw_material_processing
       (owner_id,processing_date,feed_product_id,quantity_bags,produced_quantity,produced_unit,remarks)
       VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [ownerId, d.date, feed.rows[0].id, feedBags, quantityKg, 'kg', d.remarks],
    );
    await client.query(
      `INSERT INTO raw_material_logs
       (owner_id,material_id,transaction_type,quantity,unit,transaction_date,remarks,processing_id,
        entered_quantity,entered_unit)
       VALUES($1,$2,'OUTWARD_PROCESSING',$3,'kg',$4,$5,$6,$7,$8)`,
      [ownerId, d.material_id, quantityKg, d.date, d.remarks, operation.rows[0].id, d.quantity, d.unit],
    );
    await client.query(
      `INSERT INTO feed_purchases(owner_id,delivery_date,feed_type,feed_product_id,bags,cost_per_bag,total_cost,source,processing_id)
       VALUES($1,$2,$3,$4,$5,0,0,'PROCESSING',$6)`,
      [ownerId, d.date, feed.rows[0].name, feed.rows[0].id, feedBags, operation.rows[0].id],
    );
    return {
      ...operation.rows[0],
      feed_product_name: feed.rows[0].name,
      produced_quantity: quantityKg,
      produced_unit: 'kg',
      materials: [{
        material_id: d.material_id,
        name: material.name,
        unit: 'kg',
        quantity: quantityKg,
      }],
    };
  });
}

async function rawStockExcluding(client: PoolClient, ownerId: string, materialId: string, excludeLogId?: string) {
  const params: any[] = [ownerId, materialId];
  const exclude = excludeLogId ? ` AND id<>$${params.push(excludeLogId)}` : '';
  const result = await client.query(
    `SELECT COALESCE(SUM(CASE WHEN transaction_type='INWARD' THEN quantity ELSE -quantity END),0) AS balance
     FROM raw_material_logs WHERE owner_id=$1 AND material_id=$2${exclude}`,
    params,
  );
  return Number(result.rows[0].balance);
}

export async function updateInward(ownerId: string, logId: string, d: any) {
  return withTx(async (client) => {
    await lockOwner(client, ownerId);
    const existing = await client.query(
      'SELECT * FROM raw_material_logs WHERE id=$1 AND owner_id=$2 AND transaction_type=\'INWARD\' FOR UPDATE',
      [logId, ownerId],
    );
    if (!existing.rows.length) throw new HttpError(404, 'Raw material inward record not found');
    const old = existing.rows[0];
    const settings = await client.query('SELECT kg_per_bag FROM users WHERE id=$1', [ownerId]);
    const unit = d.unit ?? old.entered_unit ?? old.unit;
    const kgPerBag = Number(
      d.kg_per_bag ??
        (unit === (old.entered_unit ?? old.unit)
            ? old.entered_kg_per_unit
            : null) ??
        settings.rows[0]?.kg_per_bag ??
        50,
    ) || 50;
    const quantity = d.quantity ?? Number(old.entered_quantity ?? old.quantity);
    const factor = unit === 'quintal' ? 100 : unit === 'bags' ? kgPerBag : 1;
    const quantityKg = Math.round(quantity * factor * 1000) / 1000;
    const baseStock = await rawStockExcluding(client, ownerId, old.material_id, logId);
    if (baseStock + quantityKg < -0.0005) throw new HttpError(400, 'Edit would make raw material stock negative');
    const rate = d.rate_per_unit ?? Number(old.rate_per_unit ?? 0);
    const totalAmount = Math.round(quantity * rate * 100) / 100;
    const result = await client.query(
      `UPDATE raw_material_logs SET
        quantity=$3, unit='kg', transaction_date=COALESCE($4,transaction_date),
        supplier=$5, vendor_name=$6, rate_per_unit=$7, total_amount=$8,
        remarks=$9, bill_number=$10,
        entered_quantity=$11, entered_unit=$12, entered_kg_per_unit=$13
       WHERE id=$1 AND owner_id=$2 RETURNING *`,
      [logId, ownerId, quantityKg, d.date ?? null,
        d.supplier ?? old.supplier, d.vendor_name ?? d.supplier ?? old.vendor_name,
        rate, totalAmount, d.remarks ?? old.remarks,
        d.bill_number ?? old.bill_number,
        quantity, unit, unit === 'bags' ? kgPerBag : null],
    );
    return { ...result.rows[0], kg_per_bag: kgPerBag };
  });
}

export async function deleteInward(ownerId: string, logId: string) {
  return withTx(async (client) => {
    await lockOwner(client, ownerId);
    const existing = await client.query(
      'SELECT * FROM raw_material_logs WHERE id=$1 AND owner_id=$2 AND transaction_type=\'INWARD\' FOR UPDATE',
      [logId, ownerId],
    );
    if (!existing.rows.length) throw new HttpError(404, 'Raw material inward record not found');
    const stock = await rawStockExcluding(client, ownerId, existing.rows[0].material_id, logId);
    if (stock < -0.0005) throw new HttpError(400, 'Cannot delete this inward entry because its stock has already been consumed');
    await client.query('DELETE FROM raw_material_logs WHERE id=$1 AND owner_id=$2', [logId, ownerId]);
  });
}

export async function updateUsage(ownerId: string, logId: string, d: any) {
  return withTx(async (client) => {
    await lockOwner(client, ownerId);
    const existing = await client.query(
      'SELECT * FROM raw_material_logs WHERE id=$1 AND owner_id=$2 AND transaction_type=\'OUTWARD_PROCESSING\' FOR UPDATE',
      [logId, ownerId],
    );
    if (!existing.rows.length) throw new HttpError(404, 'Raw material usage record not found');
    const old = existing.rows[0];
    if (old.preparation_id) {
      throw new HttpError(400, 'Ready Feed ingredient usage can only be changed by editing its preparation batch');
    }
    const settings = await client.query('SELECT kg_per_bag FROM users WHERE id=$1', [ownerId]);
    const kgPerBag = Number(settings.rows[0]?.kg_per_bag ?? 50) || 50;
    const unit = d.unit ?? old.entered_unit ?? 'kg';
    const quantity = d.quantity ?? Number(old.entered_quantity ?? old.quantity);
    const factor = unit === 'quintal' ? 100 : unit === 'bags' ? kgPerBag : 1;
    const quantityKg = Math.round(quantity * factor * 1000) / 1000;
    const baseStock = await rawStockExcluding(client, ownerId, old.material_id, logId);
    if (baseStock < quantityKg - 0.0005) throw new HttpError(400, 'Insufficient raw material stock');
    const result = await client.query(
      `UPDATE raw_material_logs SET quantity=$3, unit='kg', transaction_date=COALESCE($4,transaction_date),
       remarks=$5, entered_quantity=$6, entered_unit=$7
       WHERE id=$1 AND owner_id=$2 RETURNING *`,
      [logId, ownerId, quantityKg, d.date ?? null, d.remarks ?? old.remarks, quantity, unit],
    );
    await refreshProcessingBatch(client, ownerId, old.processing_id, kgPerBag);
    return result.rows[0];
  });
}

export async function deleteUsage(ownerId: string, logId: string) {
  return withTx(async (client) => {
    await lockOwner(client, ownerId);
    const existing = await client.query(
      'SELECT * FROM raw_material_logs WHERE id=$1 AND owner_id=$2 AND transaction_type=\'OUTWARD_PROCESSING\' FOR UPDATE',
      [logId, ownerId],
    );
    if (!existing.rows.length) throw new HttpError(404, 'Raw material usage record not found');
    if (existing.rows[0].preparation_id) {
      throw new HttpError(400, 'Ready Feed ingredient usage can only be changed by editing its preparation batch');
    }
    if (existing.rows[0].processing_id) {
      await deleteProcessingInTx(client, ownerId, existing.rows[0].processing_id);
      return;
    }
    await client.query('DELETE FROM raw_material_logs WHERE id=$1 AND owner_id=$2', [logId, ownerId]);
  });
}

async function refreshProcessingBatch(client: PoolClient, ownerId: string, processingId: string | null, kgPerBag: number) {
  if (!processingId) return;
  const ingredients = await client.query(
    `SELECT l.*, m.name FROM raw_material_logs l JOIN raw_materials m ON m.id=l.material_id
     WHERE l.owner_id=$1 AND l.processing_id=$2 AND l.transaction_type='OUTWARD_PROCESSING'`,
    [ownerId, processingId],
  );
  if (!ingredients.rows.length) {
    await deleteProcessingInTx(client, ownerId, processingId);
    return;
  }
  const totalKg = ingredients.rows.reduce((sum: number, row: any) => sum + Number(row.quantity), 0);
  const totalBags = Math.round((totalKg / kgPerBag) * 100000) / 100000;
  let totalCost = 0;
  for (const row of ingredients.rows) {
    const cost = await client.query(
      `SELECT CASE WHEN COALESCE(SUM(quantity),0)>0
               THEN SUM(total_amount)/SUM(quantity) ELSE 0 END AS rate
       FROM raw_material_logs
       WHERE owner_id=$1 AND material_id=$2 AND transaction_type='INWARD'`,
      [ownerId, row.material_id],
    );
    totalCost += Number(row.quantity) * Number(cost.rows[0].rate);
  }
  const costPerBag = totalBags > 0 ? Math.round((totalCost / totalBags) * 100) / 100 : 0;
  await client.query(
    `UPDATE raw_material_processing SET quantity_bags=$3,produced_quantity=$4,produced_unit='kg'
     WHERE id=$1 AND owner_id=$2`,
    [processingId, ownerId, totalBags, Math.round(totalKg * 1000) / 1000],
  );
  await client.query(
    `UPDATE feed_purchases SET bags=$3,cost_per_bag=$4,total_cost=$5
     WHERE owner_id=$1 AND processing_id=$2`,
    [ownerId, processingId, totalBags, costPerBag, Math.round(totalCost * 100) / 100],
  );
}

async function deleteProcessingInTx(client: PoolClient, ownerId: string, processingId: string) {
  const operation = await client.query(
    'SELECT id FROM raw_material_processing WHERE id=$1 AND owner_id=$2 FOR UPDATE',
    [processingId, ownerId],
  );
  if (!operation.rows.length) throw new HttpError(404, 'Feed mix batch not found');
  await client.query('DELETE FROM feed_purchases WHERE owner_id=$1 AND processing_id=$2', [ownerId, processingId]);
  await client.query('DELETE FROM raw_material_logs WHERE owner_id=$1 AND processing_id=$2', [ownerId, processingId]);
  await client.query('DELETE FROM raw_material_processing WHERE id=$1 AND owner_id=$2', [processingId, ownerId]);
}

export async function deleteProcessing(ownerId: string, processingId: string) {
  return withTx(async (client) => {
    await lockOwner(client, ownerId);
    await deleteProcessingInTx(client, ownerId, processingId);
  });
}
