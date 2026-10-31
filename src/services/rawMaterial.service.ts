import { PoolClient } from 'pg';
import { query, withTx } from '../config/db';
import { HttpError } from '../utils/httpError';

const lockOwner = (client: PoolClient, ownerId: number) =>
  client.query('SELECT pg_advisory_xact_lock($1::bigint)', [ownerId]);

export async function listMaterials(ownerId: number) {
  return query(
    `SELECT m.id, m.name, m.unit, m.min_alert_threshold,
            COALESCE(SUM(t.quantity) FILTER (WHERE t.transaction_type='INWARD'),0) AS total_purchased,
            COALESCE(SUM(t.quantity) FILTER (WHERE t.transaction_type='OUTWARD_PROCESSING'),0) AS total_consumed,
            COALESCE(SUM(CASE WHEN t.transaction_type='INWARD' THEN t.quantity ELSE -t.quantity END),0) AS current_stock
     FROM raw_materials m
     LEFT JOIN raw_material_logs t ON t.material_id=m.id AND t.owner_id=m.owner_id
     WHERE m.owner_id=$1
     GROUP BY m.id, m.name, m.unit, m.min_alert_threshold
     ORDER BY lower(m.name), m.id`,
    [ownerId]
  );
}

export async function createMaterial(ownerId: number, d: any) {
  return withTx(async (client) => {
    await lockOwner(client, ownerId);
    const existing = await client.query(
      'SELECT id,unit FROM raw_materials WHERE owner_id=$1 AND lower(trim(name))=lower(trim($2)) FOR UPDATE',
      [ownerId, d.name]
    );
    const duplicate = existing.rows.length > 0;
    if (existing.rows.length && existing.rows[0].unit !== d.unit) {
      throw new HttpError(400, 'A raw material with this name already exists with a different unit');
    }
    if (!existing.rows.length) {
      const inserted = await client.query(
        `INSERT INTO raw_materials(owner_id,name,unit,min_alert_threshold)
         VALUES($1,$2,$3,$4) RETURNING id`,
        [ownerId, d.name, d.unit, d.min_alert_threshold]
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

export async function updateMaterial(ownerId: number, id: number, d: any) {
  return withTx(async (client) => {
    await lockOwner(client, ownerId);
    const existing = await client.query('SELECT unit FROM raw_materials WHERE id=$1 AND owner_id=$2 FOR UPDATE', [id, ownerId]);
    if (!existing.rows.length) throw new HttpError(404, 'Raw material not found');
    if (existing.rows[0].unit !== d.unit) {
      const history = await client.query(
        'SELECT id FROM raw_material_logs WHERE material_id=$1 AND owner_id=$2 LIMIT 1',
        [id, ownerId]
      );
      if (history.rows.length) throw new HttpError(400, 'Cannot change the unit after stock transactions exist');
    }
    const result = await client.query(
      `UPDATE raw_materials SET name=$3,unit=$4,min_alert_threshold=$5
       WHERE id=$1 AND owner_id=$2 RETURNING id,name,unit,min_alert_threshold`,
      [id, ownerId, d.name, d.unit, d.min_alert_threshold]
    );
    return result.rows[0];
  });
}

export async function deleteMaterial(ownerId: number, id: number) {
  const rows = await query('DELETE FROM raw_materials WHERE id=$1 AND owner_id=$2 RETURNING id', [id, ownerId]);
  if (!rows.length) throw new HttpError(404, 'Raw material not found');
}

export async function listLogs(ownerId: number, from?: string, to?: string) {
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

export async function receiveMaterial(ownerId: number, d: any) {
  return withTx(async (client) => {
    await lockOwner(client, ownerId);
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
         VALUES($1,$2,$3) RETURNING id,name,unit`,
        [ownerId, d.material_name.trim(), d.unit]
      );
      material = created;
    }
    if (!material.rows.length) throw new HttpError(404, 'Raw material not found');
    if (material.rows[0].unit !== d.unit) throw new HttpError(400, 'Unit must match the raw material unit');
    const result = await client.query(
      `INSERT INTO raw_material_logs
       (owner_id,material_id,transaction_type,quantity,unit,transaction_date,supplier,rate_per_unit,total_amount,remarks,
        bill_image_url,bill_number,vendor_name)
       VALUES($1,$2,'INWARD',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [ownerId, material.rows[0].id, d.quantity, d.unit, d.date, d.supplier, d.rate_per_unit, d.total_amount, d.remarks,
         d.bill_image_url, d.bill_number, d.vendor_name ?? (d.supplier?.length <= 150 ? d.supplier : null)]
    );
    return result.rows[0];
  });
}

export async function listProcessing(ownerId: number) {
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
       AND t.processing_id=ANY($2::bigint[])
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

export async function processMaterials(ownerId: number, d: any) {
  return withTx(async (client) => {
    await lockOwner(client, ownerId);
    const feed = d.feed_product_id
      ? await client.query(
          'SELECT id,name FROM feed_products WHERE id=$1 AND owner_id=$2 FOR UPDATE',
          [d.feed_product_id, ownerId]
        )
      : await client.query(
          'SELECT id,name FROM feed_products WHERE owner_id=$1 AND lower(trim(name))=lower(trim($2)) FOR UPDATE',
          [ownerId, d.feed_product_name]
        );
    if (!d.feed_product_id && !feed.rows.length) {
      const created = await client.query(
        'INSERT INTO feed_products(owner_id,name) VALUES($1,$2) RETURNING id,name',
        [ownerId, d.feed_product_name.trim()]
      );
      feed.rows.push(created.rows[0]);
    }
    if (!feed.rows.length) throw new HttpError(404, 'Feed product not found');
    const settings = await client.query('SELECT kg_per_bag FROM users WHERE id=$1', [ownerId]);
    const kgPerBag = Number(settings.rows[0]?.kg_per_bag ?? 50);
    const producedUnit = d.output_unit ?? 'bags';
    const producedQuantity = Number(d.output_quantity ?? d.quantity_bags);
    const rawBagCount = d.output_quantity === undefined || producedUnit === 'bags'
      ? producedQuantity
      : producedQuantity / kgPerBag;
    const quantityBags = Math.round(rawBagCount * 100) / 100;
    if (!Number.isFinite(quantityBags) || quantityBags <= 0) {
      throw new HttpError(400, 'Produced quantity is too small to add to feed inventory');
    }
    const ids = [...new Set<number>(d.materials.map((m: any) => m.material_id))].sort((a, b) => a - b);
    if (ids.length !== d.materials.length) throw new HttpError(400, 'A material may only appear once per processing operation');
    const materials = await client.query(
      'SELECT id,name,unit FROM raw_materials WHERE owner_id=$1 AND id=ANY($2::bigint[]) ORDER BY id FOR UPDATE',
      [ownerId, ids]
    );
    if (materials.rows.length !== ids.length) throw new HttpError(404, 'One or more raw materials were not found');
    const materialMap = new Map<number, any>(materials.rows.map((m: any) => [Number(m.id), m]));
    for (const line of d.materials) {
      const stock = await client.query(
        `SELECT COALESCE(SUM(CASE WHEN transaction_type='INWARD' THEN quantity ELSE -quantity END),0) AS balance
         FROM raw_material_logs WHERE owner_id=$1 AND material_id=$2`,
        [ownerId, line.material_id]
      );
      if (Number(stock.rows[0].balance) + 0.0005 < line.quantity) {
        throw new HttpError(400, `Insufficient stock for ${materialMap.get(line.material_id).name} (${stock.rows[0].balance} ${materialMap.get(line.material_id).unit} available)`);
      }
    }
    const operation = await client.query(
      `INSERT INTO raw_material_processing
       (owner_id,processing_date,feed_product_id,quantity_bags,produced_quantity,produced_unit,remarks)
       VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [ownerId, d.date, feed.rows[0].id, quantityBags, producedQuantity, producedUnit, d.remarks]
    );
    for (const line of d.materials) {
      const material = materialMap.get(line.material_id);
      await client.query(
        `INSERT INTO raw_material_logs
         (owner_id,material_id,transaction_type,quantity,unit,transaction_date,remarks,processing_id)
         VALUES($1,$2,'OUTWARD_PROCESSING',$3,$4,$5,$6,$7)`,
        [ownerId, line.material_id, line.quantity, material.unit, d.date, d.remarks, operation.rows[0].id]
      );
    }
    await client.query(
      `INSERT INTO feed_purchases(owner_id,delivery_date,feed_type,feed_product_id,bags,cost_per_bag,source)
       VALUES($1,$2,$3,$4,$5,0,'PROCESSING')`,
      [ownerId, d.date, feed.rows[0].name, feed.rows[0].id, quantityBags]
    );
    return {
      ...operation.rows[0],
      feed_product_name: feed.rows[0].name,
      produced_quantity: producedQuantity,
      produced_unit: producedUnit,
      materials: d.materials.map((line: any) => ({
        ...line,
        name: materialMap.get(line.material_id).name,
        unit: materialMap.get(line.material_id).unit,
      })),
    };
  });
}
