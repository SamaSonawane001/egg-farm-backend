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

export async function getMaterialDetails(ownerId: number, id: number, month: string) {
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

export async function createMaterial(ownerId: number, d: any) {
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

export async function updateMaterial(ownerId: number, id: number, d: any) {
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
    const settings = await client.query(
      'SELECT kg_per_bag FROM users WHERE id=$1',
      [ownerId],
    );
    const kgPerBag = Number(settings.rows[0]?.kg_per_bag ?? 50) || 50;
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
        bill_image_url,bill_number,vendor_name,entered_quantity,entered_unit)
       VALUES($1,$2,'INWARD',$3,'kg',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [ownerId, material.rows[0].id, quantityKg, d.date, d.supplier, d.rate_per_unit, totalAmount, d.remarks,
        d.bill_image_url, d.bill_number, d.vendor_name ?? (d.supplier?.length <= 150 ? d.supplier : null),
        d.quantity, d.unit]
    );
    return { ...result.rows[0], kg_per_bag: kgPerBag };
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
      `INSERT INTO feed_purchases(owner_id,delivery_date,feed_type,feed_product_id,bags,cost_per_bag,source)
       VALUES($1,$2,$3,$4,$5,0,'PROCESSING')`,
      [ownerId, d.date, feed.rows[0].name, feed.rows[0].id, feedBags],
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
