import { PoolClient } from 'pg';
import { query, setFarmSettings, withTx } from '../config/db';
import { getFarmContext } from '../config/farmContext';
import { HttpError } from '../utils/httpError';

const lockOwner = (client: PoolClient, ownerId: string) =>
  client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))', [ownerId]);

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
      ON active_farm.id=$2::uuid
         AND (active_farm.owner_user_id=u.id
           OR to_jsonb(active_farm)->>'user_id'=u.id::text)
     LEFT JOIN LATERAL (
      SELECT f.id FROM farms f
      WHERE f.owner_user_id=u.id OR to_jsonb(f)->>'user_id'=u.id::text
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

async function includeOwnerFarms(
  client: PoolClient,
  ownerId: string,
): Promise<void> {
  const farms = await client.query<{ id: string }>(
    `SELECT f.id FROM farms f
     WHERE f.owner_user_id=$1::uuid OR to_jsonb(f)->>'user_id'=$1::text
     ORDER BY f.created_at,f.id`,
    [ownerId],
  );
  const farmIds = farms.rows.map((farm) => farm.id);
  if (!farmIds.length) throw new HttpError(404, 'No farms are associated with this account');
  const activeFarmId = getFarmContext()?.farmId ?? null;
  if (activeFarmId && !farmIds.includes(activeFarmId)) {
    throw new HttpError(404, 'Farm not found for this account');
  }
  await setFarmSettings(client, { ownerId, farmId: activeFarmId, farmIds });
}

async function withSharedInventoryScope<T>(
  ownerId: string,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withTx(async (client) => {
    const inventory = await client.query<{ shared_inventory_enabled: boolean }>(
      'SELECT shared_inventory_enabled FROM users WHERE id=$1',
      [ownerId],
    );
    if (inventory.rows[0]?.shared_inventory_enabled === true) {
      await includeOwnerFarms(client, ownerId);
    }
    return work(client);
  });
}

export async function listMaterials(ownerId: string) {
  const activeFarmId = getFarmContext()?.farmId ?? null;
  return withSharedInventoryScope(ownerId, async (client) => {
    const result = await client.query(
      `SELECT m.id, m.name, m.unit, m.min_alert_threshold,m.is_shared_pool,
            m.farm_id, owner_farm.name AS farm_name,
            COALESCE(
              (SELECT active_farm.kg_per_bag FROM farms active_farm
               WHERE (active_farm.owner_user_id=m.owner_id
                 OR to_jsonb(active_farm)->>'user_id'=m.owner_id::text)
                 AND active_farm.id=COALESCE(
                   NULLIF(current_setting('app.farm_id',true),'')::uuid,
                   owner_farm.id
                 )),
              50
            ) AS kg_per_bag,
            COALESCE(SUM(t.quantity) FILTER (WHERE t.transaction_type='INWARD'),0) AS total_purchased,
            COALESCE(SUM(t.quantity) FILTER (WHERE t.transaction_type='OUTWARD_PROCESSING'),0) AS total_consumed,
            COALESCE(SUM(CASE WHEN t.transaction_type='INWARD' THEN t.quantity ELSE -t.quantity END),0) AS current_stock,
            COALESCE(SUM(t.total_amount) FILTER (WHERE t.transaction_type='INWARD'),0) AS total_spent,
            CASE WHEN COALESCE(SUM(t.quantity) FILTER (WHERE t.transaction_type='INWARD'),0)>0
                 THEN COALESCE(SUM(t.total_amount) FILTER (WHERE t.transaction_type='INWARD'),0)
                      / SUM(t.quantity) FILTER (WHERE t.transaction_type='INWARD')
                 ELSE 0 END AS average_unit_cost
     FROM raw_materials m
     JOIN farms owner_farm
       ON owner_farm.id=m.farm_id
          AND (owner_farm.owner_user_id=m.owner_id
            OR to_jsonb(owner_farm)->>'user_id'=m.owner_id::text)
     LEFT JOIN raw_material_logs t ON t.material_id=m.id AND t.owner_id=m.owner_id
     WHERE m.owner_id=$1
       AND ($2::uuid IS NULL OR owner_farm.id=$2
         OR (m.is_shared_pool=TRUE AND EXISTS (
           SELECT 1 FROM users u
           WHERE u.id=m.owner_id AND u.shared_inventory_enabled=TRUE
         )))
     GROUP BY m.id, m.name, m.unit, m.min_alert_threshold,m.is_shared_pool,
              m.owner_id,m.farm_id,owner_farm.id,owner_farm.name,
              owner_farm.kg_per_bag
     ORDER BY lower(m.name), m.id`,
      [ownerId, activeFarmId],
    );
    return result.rows;
  });
}

export async function getMaterialDetails(ownerId: string, id: string, month: string) {
  const activeFarmId = getFarmContext()?.farmId ?? null;
  return withSharedInventoryScope(ownerId, async (client) => {
    const [materialResult, transactionResult] = await Promise.all([
      client.query(
      `SELECT m.id, m.name, m.unit, m.min_alert_threshold,m.is_shared_pool,
              COALESCE(SUM(t.quantity) FILTER (WHERE t.transaction_type='INWARD'),0) AS total_purchased,
              COALESCE(SUM(t.quantity) FILTER (WHERE t.transaction_type='OUTWARD_PROCESSING'),0) AS total_consumed,
              COALESCE(SUM(CASE WHEN t.transaction_type='INWARD' THEN t.quantity ELSE -t.quantity END),0) AS current_stock,
              COALESCE(SUM(t.total_amount) FILTER (WHERE t.transaction_type='INWARD'),0) AS total_spent,
              COALESCE(SUM(t.quantity) FILTER (
                WHERE t.transaction_type='OUTWARD_PROCESSING'
                  AND t.transaction_date >= $3::date
                  AND t.transaction_date < ($3::date + INTERVAL '1 month')
                  AND ($4::uuid IS NULL OR t.is_shared_pool=FALSE OR t.farm_id=$4::uuid)
              ),0) AS monthly_consumed
       FROM raw_materials m
       JOIN farms owner_farm
         ON owner_farm.id=m.farm_id
            AND (owner_farm.owner_user_id=m.owner_id
              OR to_jsonb(owner_farm)->>'user_id'=m.owner_id::text)
       LEFT JOIN raw_material_logs t ON t.material_id=m.id AND t.owner_id=m.owner_id
       WHERE m.owner_id=$1 AND m.id=$2
         AND ($4::uuid IS NULL OR owner_farm.id=$4
           OR (m.is_shared_pool=TRUE AND EXISTS (
             SELECT 1 FROM users u
             WHERE u.id=m.owner_id AND u.shared_inventory_enabled=TRUE
           )))
       GROUP BY m.id`,
        [ownerId, id, `${month}-01`, activeFarmId],
      ),
      client.query(
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
         AND ($3::uuid IS NULL OR t.transaction_type='INWARD' OR t.farm_id=$3::uuid)
       ORDER BY t.transaction_date DESC, t.id DESC`,
        [ownerId, id, activeFarmId],
      ),
    ]);
    if (!materialResult.rows.length) {
      throw new HttpError(404, 'Raw material not found');
    }
    return {
      material: materialResult.rows[0],
      transactions: transactionResult.rows,
    };
  });
}

export async function createMaterial(ownerId: string, d: any) {
  return withTx(async (client) => {
    await lockOwner(client, ownerId);
    const inventory = await inventoryContext(client, ownerId);
    const existing = await client.query(
      `SELECT id FROM raw_materials
       WHERE owner_id=$1 AND lower(trim(name))=lower(trim($2))
         AND is_shared_pool=$3
         AND ($3::boolean OR farm_id=$4) FOR UPDATE`,
      [ownerId, d.name, inventory.enabled, inventory.activeFarmId],
    );
    const duplicate = existing.rows.length > 0;
    if (!existing.rows.length) {
      const inserted = await client.query(
        `INSERT INTO raw_materials(owner_id,farm_id,name,unit,min_alert_threshold,is_shared_pool)
         VALUES($1,$2,$3,'kg',$4,$5) RETURNING id`,
        [ownerId, inventory.enabled ? inventory.primaryFarmId : inventory.activeFarmId,
          d.name, d.min_alert_threshold, inventory.enabled]
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
    const inventory = await inventoryContext(client, ownerId);
    const existing = await client.query(
      'SELECT id,is_shared_pool FROM raw_materials WHERE id=$1 AND owner_id=$2 FOR UPDATE',
      [id, ownerId],
    );
    if (!existing.rows.length) throw new HttpError(404, 'Raw material not found');
    if (existing.rows[0].is_shared_pool && !inventory.enabled) {
      throw new HttpError(409, 'Enable Central Godown to edit shared stock');
    }
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
  const activeFarmId = getFarmContext()?.farmId ?? null;
  return withSharedInventoryScope(ownerId, async (client) => {
    const result = await client.query(
      `SELECT t.*, m.name AS material_name
     FROM raw_material_logs t
     JOIN raw_materials m ON m.id=t.material_id AND m.owner_id=t.owner_id
     WHERE t.owner_id=$1 AND ($2::date IS NULL OR t.transaction_date >= $2::date)
       AND ($3::date IS NULL OR t.transaction_date <= $3::date)
       AND ($4::uuid IS NULL OR t.transaction_type='INWARD' OR t.farm_id=$4::uuid)
     ORDER BY t.transaction_date DESC,t.id DESC`,
      [ownerId, from ?? null, to ?? null, activeFarmId],
    );
    return result.rows;
  });
}

export async function receiveMaterial(ownerId: string, d: any) {
  return withTx(async (client) => {
    await lockOwner(client, ownerId);
    const inventory = await inventoryContext(client, ownerId);
    const settings = await client.query(
      `SELECT f.kg_per_bag FROM farms f
       WHERE f.id=NULLIF(current_setting('app.farm_id',true),'')::uuid
         AND (f.owner_user_id=$1::uuid OR to_jsonb(f)->>'user_id'=$1::text)`,
      [ownerId],
    );
    const kgPerBag = Number(d.kg_per_bag ?? settings.rows[0]?.kg_per_bag ?? 50) || 50;
    const factor = d.unit === 'quintal' ? 100 : d.unit === 'bags' ? kgPerBag : 1;
    const quantityKg = Math.round(d.quantity * factor * 1000) / 1000;
    let material = d.material_id
      ? await client.query(
          `SELECT id,name,unit,is_shared_pool FROM raw_materials
           WHERE id=$1 AND owner_id=$2 AND is_shared_pool=$3
             AND ($3::boolean OR farm_id=$4) FOR UPDATE`,
          [d.material_id, ownerId, inventory.enabled, inventory.activeFarmId]
        )
      : await client.query(
          `SELECT id,name,unit,is_shared_pool FROM raw_materials
           WHERE owner_id=$1 AND lower(trim(name))=lower(trim($2))
               AND is_shared_pool=$3
               AND ($3::boolean OR farm_id=$4) FOR UPDATE`,
          [ownerId, d.material_name, inventory.enabled, inventory.activeFarmId]
        );
    if (!d.material_id && !material.rows.length) {
      const created = await client.query(
        `INSERT INTO raw_materials(owner_id,farm_id,name,unit,is_shared_pool)
         VALUES($1,$2,$3,'kg',$4) RETURNING id,name,unit,is_shared_pool`,
        [ownerId, inventory.enabled ? inventory.primaryFarmId : inventory.activeFarmId,
          d.material_name.trim(), inventory.enabled]
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
       (owner_id,farm_id,is_shared_pool,material_id,transaction_type,quantity,unit,transaction_date,supplier,rate_per_unit,total_amount,remarks,
        bill_number,vendor_name,entered_quantity,entered_unit,entered_kg_per_unit)
       VALUES($1,$2,$3,$4,'INWARD',$5,'kg',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [ownerId, inventory.enabled ? inventory.primaryFarmId : inventory.activeFarmId,
        inventory.enabled, material.rows[0].id, quantityKg, d.date, d.supplier, d.rate_per_unit, totalAmount, d.remarks,
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
  try {
    return await withTx(async (client) => {
      await lockOwner(client, ownerId);
      const inventory = await inventoryContext(client, ownerId);
      if (inventory.enabled) await includeOwnerFarms(client, ownerId);
      const materialResult = await client.query(
        `SELECT m.id,m.name,m.unit,m.is_shared_pool
         FROM raw_materials m
         JOIN farms f ON f.id=m.farm_id
           AND (f.owner_user_id=m.owner_id
             OR to_jsonb(f)->>'user_id'=m.owner_id::text)
         WHERE m.owner_id=$1 AND m.id=$2
         AND (m.farm_id=$3 OR ($4::boolean AND (
          f.owner_user_id=$1::uuid OR to_jsonb(f)->>'user_id'=$1::text
         )))
         FOR UPDATE OF m`,
        [ownerId, d.material_id, inventory.activeFarmId, inventory.enabled],
      );
      if (!materialResult.rows.length) {
        throw new HttpError(404, 'Raw material not found');
      }
      const material = materialResult.rows[0];
      if (material.is_shared_pool && !inventory.enabled) {
        throw new HttpError(409, 'Enable Central Godown to consume shared stock');
      }
      if (material.unit !== 'kg') {
        throw new HttpError(
          500,
          'Raw material has not been migrated to kilogram stock',
        );
      }

      const settings = await client.query(
        `SELECT f.kg_per_bag FROM farms f
         WHERE f.id=NULLIF(current_setting('app.farm_id',true),'')::uuid
           AND (f.owner_user_id=$1::uuid OR to_jsonb(f)->>'user_id'=$1::text)`,
        [ownerId],
      );
      const kgPerBag = Number(settings.rows[0]?.kg_per_bag ?? 50) || 50;
      const factor =
        d.unit === 'quintal'
          ? 100
          : d.unit === 'ton'
            ? 1000
            : d.unit === 'bags'
              ? kgPerBag
              : 1;
      const quantityKg = Math.round(d.quantity * factor * 1000) / 1000;

      const stock = await client.query(
        `SELECT COALESCE(
           SUM(CASE WHEN transaction_type='INWARD' THEN quantity ELSE -quantity END),
           0
         ) AS balance
         FROM raw_material_logs
         WHERE owner_id=$1 AND material_id=$2`,
        [ownerId, d.material_id],
      );
      const availableKg = Number(stock.rows[0].balance);
      if (availableKg + 0.0005 < quantityKg) {
        throw new HttpError(
          400,
          `Insufficient stock for ${material.name} (${availableKg} kg available)`,
        );
      }

      let totalCost = 0;
      let ratePerKg = 0;
      if (material.is_shared_pool && inventory.enabled) {
        const weightedCost = await client.query(
          `SELECT CASE WHEN COALESCE(SUM(quantity),0)>0
                       THEN SUM(total_amount)/SUM(quantity) ELSE 0 END AS rate
           FROM raw_material_logs
           WHERE owner_id=$1 AND material_id=$2 AND transaction_type='INWARD'`,
          [ownerId, d.material_id],
        );
        ratePerKg = Number(weightedCost.rows[0].rate);
        totalCost = Math.round(quantityKg * ratePerKg * 100) / 100;
      }

      let feed = await client.query(
        `SELECT id,name FROM feed_products
         WHERE owner_id=$1 AND farm_id=$2 AND lower(trim(name))=lower(trim($3))
         FOR UPDATE`,
        [ownerId, inventory.activeFarmId, material.name],
      );
      if (!feed.rows.length) {
        const created = await client.query(
          `INSERT INTO feed_products(owner_id,farm_id,name)
           VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id,name`,
          [ownerId, inventory.activeFarmId, material.name.trim()],
        );
        if (created.rows.length) {
          feed = created;
        } else {
          feed = await client.query(
            `SELECT id,name FROM feed_products
             WHERE owner_id=$1 AND farm_id=$2
               AND lower(trim(name))=lower(trim($3))
             FOR UPDATE`,
            [ownerId, inventory.activeFarmId, material.name],
          );
          if (!feed.rows.length) {
            throw new HttpError(
              409,
              'Could not create or find the feed product in this unit',
            );
          }
        }
      }

      const feedBags = Math.round((quantityKg / kgPerBag) * 100) / 100;
      if (!Number.isFinite(feedBags) || feedBags <= 0) {
        throw new HttpError(
          400,
          'Consumed quantity is too small to add to feed inventory',
        );
      }
      const operation = await client.query(
        `INSERT INTO raw_material_processing
         (owner_id,processing_date,feed_product_id,quantity_bags,
          produced_quantity,produced_unit,remarks)
         VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [
          ownerId,
          d.date,
          feed.rows[0].id,
          feedBags,
          quantityKg,
          'kg',
          d.remarks,
        ],
      );
      await client.query(
        `INSERT INTO raw_material_logs
         (owner_id,farm_id,is_shared_pool,material_id,transaction_type,
          quantity,unit,transaction_date,remarks,processing_id,rate_per_unit,
          total_amount,entered_quantity,entered_unit)
         VALUES($1,$2,$3,$4,'OUTWARD_PROCESSING',$5,'kg',$6,$7,$8,$9,$10,$11,$12)`,
        [
          ownerId,
          inventory.activeFarmId,
          Boolean(material.is_shared_pool),
          d.material_id,
          quantityKg,
          d.date,
          d.remarks,
          operation.rows[0].id,
          ratePerKg || null,
          totalCost || null,
          d.quantity,
          d.unit,
        ],
      );
      await client.query(
        `INSERT INTO feed_purchases
         (owner_id,delivery_date,feed_type,feed_product_id,bags,cost_per_bag,
          total_cost,source,processing_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,'PROCESSING',$8)`,
        [
          ownerId,
          d.date,
          feed.rows[0].name,
          feed.rows[0].id,
          feedBags,
          feedBags > 0 ? Math.round((totalCost / feedBags) * 100) / 100 : 0,
          totalCost,
          operation.rows[0].id,
        ],
      );
      return {
        ...operation.rows[0],
        feed_product_name: feed.rows[0].name,
        produced_quantity: quantityKg,
        produced_unit: 'kg',
        total_cost: totalCost,
        materials: [
          {
            material_id: d.material_id,
            name: material.name,
            unit: 'kg',
            quantity: quantityKg,
          },
        ],
      };
    });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    console.error('Grind & Mix database operation failed:', error);
    throw new HttpError(
      500,
      error instanceof Error && error.message
        ? error.message
        : 'Unknown error while saving Grind & Mix',
    );
  }
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
    const settings = await client.query(`SELECT kg_per_bag FROM farms WHERE owner_user_id=$1 AND id=NULLIF(current_setting('app.farm_id',true),'')::uuid`, [ownerId]);
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
    const settings = await client.query(`SELECT kg_per_bag FROM farms WHERE owner_user_id=$1 AND id=NULLIF(current_setting('app.farm_id',true),'')::uuid`, [ownerId]);
    const kgPerBag = Number(settings.rows[0]?.kg_per_bag ?? 50) || 50;
    const unit = d.unit ?? old.entered_unit ?? 'kg';
    const quantity = d.quantity ?? Number(old.entered_quantity ?? old.quantity);
    const factor =
      unit === 'quintal'
        ? 100
        : unit === 'ton'
          ? 1000
          : unit === 'bags'
            ? kgPerBag
            : 1;
    const quantityKg = Math.round(quantity * factor * 1000) / 1000;
    const baseStock = await rawStockExcluding(client, ownerId, old.material_id, logId);
    if (baseStock < quantityKg - 0.0005) throw new HttpError(400, 'Insufficient raw material stock');
    const totalAmount = old.is_shared_pool
      ? Math.round(quantityKg * Number(old.rate_per_unit ?? 0) * 100) / 100
      : old.total_amount;
    const result = await client.query(
      `UPDATE raw_material_logs SET quantity=$3, unit='kg', transaction_date=COALESCE($4,transaction_date),
       total_amount=$5, remarks=$6, entered_quantity=$7, entered_unit=$8
       WHERE id=$1 AND owner_id=$2 RETURNING *`,
      [logId, ownerId, quantityKg, d.date ?? null, totalAmount,
        d.remarks ?? old.remarks, quantity, unit],
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
