import { PoolClient } from 'pg';
import { query, withTx } from '../config/db';
import { getFarmContext } from '../config/farmContext';
import { HttpError } from '../utils/httpError';
import { ensureBatch } from './flock.service';

export async function getStock(ownerId: string) {
  const farmContext = getFarmContext();
  const activeFarmId = farmContext?.farmId ?? null;
  const farmIds = farmContext?.farmIds ?? null;
  if (activeFarmId != null) await ensureReadyFeed(ownerId);
  const [totals, feeds, settings] = await Promise.all([
    query(
      `SELECT COALESCE((SELECT SUM(bags) FROM feed_purchases
                        WHERE owner_id=$1
                          AND ($3::uuid[] IS NULL OR farm_id=ANY($3::uuid[]))
                          AND ($2::uuid IS NULL OR farm_id=$2)),0) AS purchased,
              COALESCE((SELECT SUM(bags_equivalent) FROM feed_usage
                        WHERE owner_id=$1
                          AND ($3::uuid[] IS NULL OR farm_id=ANY($3::uuid[]))
                          AND ($2::uuid IS NULL OR farm_id=$2)),0) AS consumed`,
      [ownerId, activeFarmId, farmIds]
    ),
    query(
      `SELECT fp.id, fp.name AS feed_type,fp.farm_id,f.name AS farm_name,
              COALESCE((SELECT SUM(p.bags) FROM feed_purchases p
                        WHERE p.owner_id=fp.owner_id AND p.feed_product_id=fp.id
                          AND ($3::uuid[] IS NULL OR p.farm_id=ANY($3::uuid[]))
                          AND ($2::uuid IS NULL OR p.farm_id=$2)),0) AS purchased,
              COALESCE((SELECT SUM(u.bags_equivalent) FROM feed_usage u
                        WHERE u.owner_id=fp.owner_id AND u.feed_product_id=fp.id
                          AND ($3::uuid[] IS NULL OR u.farm_id=ANY($3::uuid[]))
                          AND ($2::uuid IS NULL OR u.farm_id=$2)),0) AS consumed
       FROM feed_products fp
       JOIN farms f ON f.id=fp.farm_id AND f.owner_user_id=fp.owner_id
       WHERE fp.owner_id=$1
         AND ($3::uuid[] IS NULL OR fp.farm_id=ANY($3::uuid[]))
         AND ($2::uuid IS NULL OR fp.farm_id=$2)
       ORDER BY CASE WHEN lower(trim(fp.name))='ready feed' THEN 0 ELSE 1 END, lower(fp.name), fp.id`,
      [ownerId, activeFarmId, farmIds]
    ),
    query(
      `SELECT COALESCE(SUM(low_stock_threshold),10) AS threshold,
              COALESCE(AVG(kg_per_bag),50) AS kg_per_bag
       FROM farms
       WHERE owner_user_id=$1
         AND ($3::uuid[] IS NULL OR id=ANY($3::uuid[]))
         AND ($2::uuid IS NULL OR id=$2)`,
      [ownerId, activeFarmId, farmIds],
    ),
  ]);
  const { purchased, consumed } = totals[0];
  const threshold = settings[0]?.threshold ?? 10;
  const remaining = Math.round((purchased - consumed) * 1000) / 1000;
  return {
    purchased,
    consumed,
    remaining,
    threshold,
    kg_per_bag: settings[0]?.kg_per_bag ?? 50,
    feeds: feeds.map((feed) => ({
      ...feed,
      remaining: feed.purchased - feed.consumed,
    })),
    low_stock: remaining <= threshold,
  };
}

export const listPurchases = async (ownerId: string, limit = 20, offset = 0) => {
  const [data, count] = await Promise.all([
    query(
      `SELECT p.*, fp.name AS feed_type, fp.id AS feed_product_id
       FROM feed_purchases p JOIN feed_products fp ON fp.id=p.feed_product_id AND fp.owner_id=p.owner_id
       WHERE p.owner_id=$1 ORDER BY p.delivery_date DESC, p.id DESC
       LIMIT $2 OFFSET $3`,
      [ownerId, limit, offset]
    ),
    query(
      `SELECT COUNT(*)::int AS total FROM feed_purchases p
       JOIN feed_products fp ON fp.id=p.feed_product_id AND fp.owner_id=p.owner_id
       WHERE p.owner_id=$1`,
      [ownerId]
    ),
  ]);
  return { data, total: Number(count[0].total) };
};

export const listProducts = async (ownerId: string) => {
  if (getFarmContext()?.farmId != null) await ensureReadyFeed(ownerId);
  const rows = await query(
    `SELECT fp.id, fp.name,
            COALESCE((SELECT SUM(p.bags) FROM feed_purchases p WHERE p.owner_id=fp.owner_id AND p.feed_product_id=fp.id),0) AS purchased_bags,
            COALESCE((SELECT SUM(u.bags_equivalent) FROM feed_usage u WHERE u.owner_id=fp.owner_id AND u.feed_product_id=fp.id),0) AS consumed_bags,
            COALESCE((SELECT SUM(p.total_cost) FROM feed_purchases p WHERE p.owner_id=fp.owner_id AND p.feed_product_id=fp.id),0) AS total_spent
     FROM feed_products fp WHERE fp.owner_id=$1
     ORDER BY CASE WHEN lower(trim(fp.name))='ready feed' THEN 0 ELSE 1 END, lower(fp.name), fp.id`,
    [ownerId]
  );
  return rows.map((row) => ({ ...row, remaining_bags: row.purchased_bags - row.consumed_bags }));
};

export async function getProductDetail(
  ownerId: string,
  id: string,
  month: string,
  purchaseOffset = 0,
  usageOffset = 0,
  limit = 20
) {
  const start = `${month}-01`;
  const [products, purchases, usage, purchaseCount, usageCount, monthly] = await Promise.all([
    query(
      `SELECT fp.id, fp.name,
              COALESCE((SELECT SUM(p.bags) FROM feed_purchases p WHERE p.owner_id=fp.owner_id AND p.feed_product_id=fp.id),0) AS purchased_bags,
              COALESCE((SELECT SUM(u.bags_equivalent) FROM feed_usage u WHERE u.owner_id=fp.owner_id AND u.feed_product_id=fp.id),0) AS consumed_bags,
              COALESCE((SELECT SUM(p.total_cost) FROM feed_purchases p WHERE p.owner_id=fp.owner_id AND p.feed_product_id=fp.id),0) AS total_spent
       FROM feed_products fp WHERE fp.owner_id=$1 AND fp.id=$2`,
      [ownerId, id]
    ),
    query(
      `SELECT * FROM feed_purchases WHERE owner_id=$1 AND feed_product_id=$2
       ORDER BY delivery_date DESC,id DESC LIMIT $3 OFFSET $4`,
      [ownerId, id, limit, purchaseOffset]
    ),
    query(
      `SELECT u.*, b.batch_name FROM feed_usage u LEFT JOIN flock_batches b ON b.id=u.batch_id
       WHERE u.owner_id=$1 AND u.feed_product_id=$2
         AND u.usage_date >= $3::date AND u.usage_date < ($3::date + interval '1 month')
       ORDER BY u.usage_date DESC,u.id DESC LIMIT $4 OFFSET $5`,
      [ownerId, id, start, limit, usageOffset]
    ),
    query(
      `SELECT COUNT(*)::int AS total FROM feed_purchases
       WHERE owner_id=$1 AND feed_product_id=$2`,
      [ownerId, id]
    ),
    query(
      `SELECT COUNT(*)::int AS total FROM feed_usage
       WHERE owner_id=$1 AND feed_product_id=$2
         AND usage_date >= $3::date AND usage_date < ($3::date + interval '1 month')`,
      [ownerId, id, start]
    ),
    query(
      `SELECT COALESCE(SUM(bags_equivalent),0) AS consumed_bags FROM feed_usage
       WHERE owner_id=$1 AND feed_product_id=$2 AND usage_date >= $3::date
         AND usage_date < ($3::date + interval '1 month')`,
      [ownerId, id, start]
    ),
  ]);
  if (!products.length) throw new HttpError(404, 'Feed product not found');
  const product = products[0];
  const totalPurchases = Number(purchaseCount[0].total);
  const totalUsage = Number(usageCount[0].total);
  const purchasesPage = Math.floor(purchaseOffset / limit) + 1;
  const usagePage = Math.floor(usageOffset / limit) + 1;
  return {
    ...product,
    remaining_bags: product.purchased_bags - product.consumed_bags,
    monthly_used_bags: monthly[0].consumed_bags,
    month,
    purchases,
    purchases_has_more: purchaseOffset + limit < totalPurchases,
    purchases_pagination: {
      total: totalPurchases,
      page: purchasesPage,
      limit,
      totalPages: Math.ceil(totalPurchases / limit),
      hasMore: purchaseOffset + limit < totalPurchases,
    },
    usage,
    usage_has_more: usageOffset + limit < totalUsage,
    usage_pagination: {
      total: totalUsage,
      page: usagePage,
      limit,
      totalPages: Math.ceil(totalUsage / limit),
      hasMore: usageOffset + limit < totalUsage,
    },
  };
}

export async function createProduct(ownerId: string, name: string) {
  if (name.trim().toLowerCase() === 'ready feed') {
    throw new HttpError(409, 'Ready Feed is a permanent system product');
  }
  const rows = await query(
    'INSERT INTO feed_products(owner_id,name) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING id,name',
    [ownerId, name.trim()]
  );
  if (!rows.length) throw new HttpError(409, 'A feed product with this name already exists');
  return rows[0];
}

export async function updateProduct(ownerId: string, id: string, name: string) {
  return withTx(async (client) => {
    await lockOwner(client, ownerId);
    if (name.trim().toLowerCase() === 'ready feed') {
      throw new HttpError(409, 'A permanent Ready Feed system product already exists');
    }
    const existing = await client.query(
      'SELECT name FROM feed_products WHERE id=$1 AND owner_id=$2 FOR UPDATE',
      [id, ownerId],
    );
    if (!existing.rows.length) throw new HttpError(404, 'Feed product not found');
    if (existing.rows[0].name.trim().toLowerCase() === 'ready feed') {
      throw new HttpError(400, 'Ready Feed is a permanent system product and cannot be renamed');
    }
    const updated = await client.query(
      'UPDATE feed_products SET name=$3 WHERE id=$1 AND owner_id=$2 RETURNING id,name',
      [id, ownerId, name.trim()]
    );
    await client.query('UPDATE feed_purchases SET feed_type=$3 WHERE owner_id=$2 AND feed_product_id=$1', [id, ownerId, name.trim()]);
    await client.query('UPDATE feed_usage SET feed_type=$3 WHERE owner_id=$2 AND feed_product_id=$1', [id, ownerId, name.trim()]);
    return updated.rows[0];
  });
}

export async function deleteProduct(ownerId: string, id: string) {
  await withTx(async (client) => {
    await lockOwner(client, ownerId);
    const product = await client.query('SELECT name FROM feed_products WHERE id=$1 AND owner_id=$2', [id, ownerId]);
    if (!product.rows.length) throw new HttpError(404, 'Feed product not found');
    if (product.rows[0].name.trim().toLowerCase() === 'ready feed') {
      throw new HttpError(400, 'Ready Feed is a permanent system product and cannot be deleted');
    }
    const rows = await client.query('DELETE FROM feed_products WHERE id=$1 AND owner_id=$2 RETURNING id', [id, ownerId]);
  });
}

const lockOwner = (client: PoolClient, ownerId: string) => client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))', [ownerId]);

async function ensureReadyFeedInTx(client: PoolClient, ownerId: string) {
  const result = await client.query(
    `INSERT INTO feed_products(owner_id,name)
     VALUES($1,'Ready Feed')
     ON CONFLICT DO NOTHING
     RETURNING id,name`,
    [ownerId],
  );
  if (result.rows.length) return result.rows[0];
  const existing = await client.query(
    `SELECT id,name FROM feed_products
     WHERE owner_id=$1 AND lower(trim(name))='ready feed'
     FOR UPDATE`,
    [ownerId],
  );
  if (!existing.rows.length) throw new HttpError(500, 'Could not create or find Ready Feed');
  return existing.rows[0];
}

async function ensureReadyFeed(ownerId: string) {
  return withTx(async (client) => {
    await lockOwner(client, ownerId);
    return ensureReadyFeedInTx(client, ownerId);
  });
}

async function remainingForProduct(
  client: PoolClient,
  ownerId: string,
  productId: string,
  excludeUsageId?: string,
  excludePurchaseId?: string
): Promise<number> {
  const params: any[] = [ownerId, productId];
  const purchaseFilter = excludePurchaseId == null ? '' : ` AND id <> $${params.push(excludePurchaseId)}`;
  const usageFilter = excludeUsageId == null ? '' : ` AND id <> $${params.push(excludeUsageId)}`;
  const result = await client.query(
    `SELECT COALESCE((SELECT SUM(bags) FROM feed_purchases WHERE owner_id=$1 AND feed_product_id=$2${purchaseFilter}),0)
            - COALESCE((SELECT SUM(bags_equivalent) FROM feed_usage WHERE owner_id=$1 AND feed_product_id=$2${usageFilter}),0) AS remaining`,
    params
  );
  return Number(result.rows[0].remaining);
}

function assertEnoughStock(remaining: number, requested: number) {
  if (requested - remaining > 0.0005) {
    throw new HttpError(400, `Not enough ${requested ? 'selected feed' : 'feed'} in stock (${Math.max(0, remaining)} bags left)`);
  }
}

export async function createPurchase(ownerId: string, d: any) {
  return withTx(async (client) => {
    await lockOwner(client, ownerId);
    const product = await client.query('SELECT name FROM feed_products WHERE id=$1 AND owner_id=$2', [d.feed_product_id, ownerId]);
    if (!product.rows.length) throw new HttpError(404, 'Feed product not found');
    if (product.rows[0].name.trim().toLowerCase() === 'ready feed') {
      throw new HttpError(400, 'Ready Feed stock is added only through preparation batches');
    }
    const settings = await client.query(`SELECT kg_per_bag FROM farms WHERE owner_user_id=$1 AND id=NULLIF(current_setting('app.farm_id',true),'')::uuid`, [ownerId]);
    const kgPerBag = Number(settings.rows[0]?.kg_per_bag ?? 50) || 50;
    const enteredUnit = d.unit ?? 'bags';
    const enteredQuantity = Number(d.quantity ?? d.bags);
    const enteredRate = Number(d.rate_per_unit ?? d.cost_per_bag);
    const quantityKg = enteredUnit === 'quintal'
      ? enteredQuantity * 100
      : enteredUnit === 'kg'
        ? enteredQuantity
        : enteredQuantity * kgPerBag;
    const bags = Math.round((quantityKg / kgPerBag) * 100000) / 100000;
    const totalCost = Math.round(enteredQuantity * enteredRate * 100) / 100;
    const costPerBag = bags > 0 ? Math.round((totalCost / bags) * 100) / 100 : 0;
    const r = await client.query(
      `INSERT INTO feed_purchases
       (owner_id,feed_product_id,delivery_date,feed_type,bags,cost_per_bag,total_cost,
        entered_quantity,entered_unit,rate_per_unit,kg_per_bag)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [ownerId, d.feed_product_id, d.delivery_date, product.rows[0].name,
        bags, costPerBag, totalCost, enteredQuantity, enteredUnit, enteredRate, kgPerBag]
    );
    return r.rows[0];
  });
}

export async function updatePurchase(ownerId: string, id: string, d: any) {
  return withTx(async (client) => {
    await lockOwner(client, ownerId);
    const existing = await client.query('SELECT * FROM feed_purchases WHERE id=$1 AND owner_id=$2 FOR UPDATE', [id, ownerId]);
    if (!existing.rows.length) throw new HttpError(404, 'Feed purchase not found');
    const old = existing.rows[0];
    if (old.source === 'PROCESSING') throw new HttpError(400, 'Feed created by raw-material processing cannot be edited');
    const product = await client.query('SELECT name FROM feed_products WHERE id=$1 AND owner_id=$2', [d.feed_product_id, ownerId]);
    if (!product.rows.length) throw new HttpError(404, 'Feed product not found');
    if (product.rows[0].name.trim().toLowerCase() === 'ready feed') {
      throw new HttpError(400, 'Ready Feed stock is added only through preparation batches');
    }
    const settings = await client.query(`SELECT kg_per_bag FROM farms WHERE owner_user_id=$1 AND id=NULLIF(current_setting('app.farm_id',true),'')::uuid`, [ownerId]);
    const kgPerBag = Number(settings.rows[0]?.kg_per_bag ?? old.kg_per_bag ?? 50) || 50;
    const enteredUnit = d.unit ?? 'bags';
    const enteredQuantity = Number(d.quantity ?? d.bags);
    const enteredRate = Number(d.rate_per_unit ?? d.cost_per_bag);
    const quantityKg = enteredUnit === 'quintal'
      ? enteredQuantity * 100
      : enteredUnit === 'kg'
        ? enteredQuantity
        : enteredQuantity * kgPerBag;
    const bags = Math.round((quantityKg / kgPerBag) * 100000) / 100000;
    const totalCost = Math.round(enteredQuantity * enteredRate * 100) / 100;
    const costPerBag = bags > 0 ? Math.round((totalCost / bags) * 100) / 100 : 0;
    const remaining = await remainingForProduct(client, ownerId, old.feed_product_id, undefined, id);
    if (old.feed_product_id === d.feed_product_id && remaining + bags < 0) {
      throw new HttpError(400, 'This change would make feed stock negative');
    }
    if (old.feed_product_id !== d.feed_product_id && remaining < 0) {
      throw new HttpError(400, 'This change would leave used feed without enough stock');
    }
    const r = await client.query(
      `UPDATE feed_purchases SET delivery_date=$3, feed_product_id=$4, feed_type=$5,
       bags=$6,cost_per_bag=$7,total_cost=$8,entered_quantity=$9,entered_unit=$10,
       rate_per_unit=$11,kg_per_bag=$12
       WHERE id=$1 AND owner_id=$2 RETURNING *`,
      [id, ownerId, d.delivery_date, d.feed_product_id, product.rows[0].name, bags,
        costPerBag, totalCost, enteredQuantity, enteredUnit, enteredRate, kgPerBag]
    );
    return r.rows[0];
  });
}

export async function deletePurchase(ownerId: string, id: string) {
  await withTx(async (client) => {
    await lockOwner(client, ownerId);
    const existing = await client.query('SELECT feed_product_id,source FROM feed_purchases WHERE id=$1 AND owner_id=$2 FOR UPDATE', [id, ownerId]);
    if (!existing.rows.length) throw new HttpError(404, 'Feed purchase not found');
    if (existing.rows[0].source === 'PROCESSING') throw new HttpError(400, 'Feed created by raw-material processing cannot be deleted');
    const remaining = await remainingForProduct(client, ownerId, existing.rows[0].feed_product_id, undefined, id);
    if (remaining < 0) throw new HttpError(400, 'Cannot delete this delivery because feed of this type has already been used');
    await client.query('DELETE FROM feed_purchases WHERE id=$1 AND owner_id=$2', [id, ownerId]);
  });
}

export const listUsage = async (ownerId: string, limit = 20, offset = 0) => {
  const [data, count] = await Promise.all([
    query(
      `SELECT u.*, b.batch_name FROM feed_usage u LEFT JOIN flock_batches b ON b.id=u.batch_id
       WHERE u.owner_id=$1 ORDER BY u.usage_date DESC, u.id DESC
       LIMIT $2 OFFSET $3`,
      [ownerId, limit, offset]
    ),
    query('SELECT COUNT(*)::int AS total FROM feed_usage WHERE owner_id=$1', [ownerId]),
  ]);
  return { data, total: Number(count[0].total) };
};

export async function createUsage(ownerId: string, d: any) {
  await ensureBatch(ownerId, d.batch_id);
  return withTx(async (client) => {
    await lockOwner(client, ownerId);
    const settings = await client.query(`SELECT kg_per_bag FROM farms WHERE owner_user_id=$1 AND id=NULLIF(current_setting('app.farm_id',true),'')::uuid`, [ownerId]);
    const product = await client.query('SELECT name FROM feed_products WHERE id=$1 AND owner_id=$2', [d.feed_product_id, ownerId]);
    if (!product.rows.length) throw new HttpError(404, 'Feed product not found');
    const bags = d.unit === 'bags' ? d.quantity : d.quantity / (settings.rows[0]?.kg_per_bag || 50);
    const remaining = await remainingForProduct(client, ownerId, d.feed_product_id);
    assertEnoughStock(remaining, bags);
    const r = await client.query(
      `INSERT INTO feed_usage (owner_id,batch_id,usage_date,quantity,unit,bags_equivalent,feed_type,feed_product_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [ownerId, d.batch_id, d.usage_date, d.quantity, d.unit, bags, product.rows[0].name, d.feed_product_id]
    );
    return r.rows[0];
  });
}

export async function updateUsage(ownerId: string, id: string, d: any) {
  await ensureBatch(ownerId, d.batch_id);
  return withTx(async (client) => {
    await lockOwner(client, ownerId);
    const existing = await client.query('SELECT id,preparation_id FROM feed_usage WHERE id=$1 AND owner_id=$2 FOR UPDATE', [id, ownerId]);
    if (!existing.rows.length) throw new HttpError(404, 'Feed usage log not found');
    if (existing.rows[0].preparation_id) throw new HttpError(400, 'Ready Feed transfer usage can only be changed by editing its preparation batch');
    const settings = await client.query(`SELECT kg_per_bag FROM farms WHERE owner_user_id=$1 AND id=NULLIF(current_setting('app.farm_id',true),'')::uuid`, [ownerId]);
    const product = await client.query('SELECT name FROM feed_products WHERE id=$1 AND owner_id=$2', [d.feed_product_id, ownerId]);
    if (!product.rows.length) throw new HttpError(404, 'Feed product not found');
    const bags = d.unit === 'bags' ? d.quantity : d.quantity / (settings.rows[0]?.kg_per_bag || 50);
    const remaining = await remainingForProduct(client, ownerId, d.feed_product_id, id);
    assertEnoughStock(remaining, bags);
    const r = await client.query(
      `UPDATE feed_usage SET batch_id=$3, usage_date=$4, quantity=$5, unit=$6, bags_equivalent=$7, feed_type=$8, feed_product_id=$9
       WHERE id=$1 AND owner_id=$2 RETURNING *`,
      [id, ownerId, d.batch_id, d.usage_date, d.quantity, d.unit, bags, product.rows[0].name, d.feed_product_id]
    );
    return r.rows[0];
  });
}

export async function deleteUsage(ownerId: string, id: string) {
  await withTx(async (client) => {
    await lockOwner(client, ownerId);
    const existing = await client.query(
      'SELECT preparation_id FROM feed_usage WHERE id=$1 AND owner_id=$2 FOR UPDATE',
      [id, ownerId],
    );
    if (!existing.rows.length) throw new HttpError(404, 'Feed usage log not found');
    if (existing.rows[0].preparation_id) throw new HttpError(400, 'Ready Feed transfer usage can only be changed by editing its preparation batch');
    await client.query('DELETE FROM feed_usage WHERE id=$1 AND owner_id=$2', [id, ownerId]);
  });
}

export async function getReadyFeedDetail(ownerId: string) {
  if (getFarmContext()?.farmId == null) {
    throw new HttpError(409, 'Select an individual farm to view Ready Feed details');
  }
  const ready = await ensureReadyFeed(ownerId);
  const settings = await query(
    `SELECT kg_per_bag FROM farms WHERE owner_user_id=$1
     AND id=NULLIF(current_setting('app.farm_id',true),'')::uuid`,
    [ownerId],
  );
  const kgPerBag = Number(settings[0]?.kg_per_bag ?? 50) || 50;
  const [products, preparations, usage] = await Promise.all([
    listProducts(ownerId),
    query(
      `SELECT p.id,p.preparation_date,p.total_quantity_kg,p.remarks,p.created_at,
              COALESCE(json_agg(json_build_object(
                'source_type',i.source_type,
                'item_id',COALESCE(i.feed_product_id,i.raw_material_id),
                'feed_product_id',i.feed_product_id,
                'material_id',i.raw_material_id,
                'feed_name',COALESCE(fp.name,rm.name),
                'quantity_kg',i.quantity_kg
              ) ORDER BY COALESCE(fp.name,rm.name)) FILTER (WHERE i.id IS NOT NULL),'[]'::json) AS ingredients
       FROM feed_preparations p
       LEFT JOIN feed_preparation_items i ON i.preparation_id=p.id AND i.owner_id=p.owner_id
       LEFT JOIN feed_products fp ON fp.id=i.feed_product_id AND fp.owner_id=i.owner_id
       LEFT JOIN raw_materials rm ON rm.id=i.raw_material_id AND rm.owner_id=i.owner_id
       WHERE p.owner_id=$1 AND p.feed_product_id=$2
       GROUP BY p.id
       ORDER BY p.preparation_date DESC,p.id DESC`,
      [ownerId, ready.id],
    ),
    query(
      `SELECT u.*,b.batch_name
       FROM feed_usage u LEFT JOIN flock_batches b ON b.id=u.batch_id
       WHERE u.owner_id=$1 AND u.feed_product_id=$2 AND u.preparation_id IS NULL
       ORDER BY u.usage_date DESC,u.id DESC LIMIT 50`,
      [ownerId, ready.id],
    ),
  ]);
  const readyProduct = products.find((product) => product.id === ready.id);
  if (!readyProduct) throw new HttpError(500, 'Ready Feed stock could not be loaded');
  return {
    product: readyProduct,
    kg_per_bag: kgPerBag,
    source_products: products.filter((product) => product.id !== ready.id),
    preparations,
    usage,
  };
}

type ReadyFeedIngredient = {
  source_type: 'feed' | 'raw_material';
  item_id: string;
  quantity_kg?: number;
  quantity?: number;
  unit?: 'kg' | 'bags';
};

async function saveReadyFeedPreparation(
  client: PoolClient,
  ownerId: string,
  readyFeedId: string,
  kgPerBag: number,
  d: { date?: string; ingredients: ReadyFeedIngredient[] },
  preparationId?: string,
) {
  const activeFarmId = getFarmContext()?.farmId;
  if (!activeFarmId) {
    throw new HttpError(409, 'Select an individual farm to prepare feed');
  }
  const inventoryMode = await client.query<{ shared_inventory_enabled: boolean }>(
    'SELECT shared_inventory_enabled FROM users WHERE id=$1',
    [ownerId],
  );
  const sharedInventoryEnabled =
    inventoryMode.rows[0]?.shared_inventory_enabled === true;
  const previous = preparationId
    ? await client.query(
        'SELECT * FROM feed_preparations WHERE id=$1 AND owner_id=$2 FOR UPDATE',
        [preparationId, ownerId],
      )
    : { rows: [] as any[] };
  if (preparationId && !previous.rows.length) throw new HttpError(404, 'Ready Feed preparation not found');
  if (previous.rows.length && previous.rows[0].feed_product_id !== readyFeedId) {
    throw new HttpError(400, 'Preparation does not belong to Ready Feed');
  }

  const oldUsage = preparationId
    ? await client.query(
        `SELECT feed_product_id,SUM(bags_equivalent) AS bags
         FROM feed_usage WHERE owner_id=$1 AND preparation_id=$2
         GROUP BY feed_product_id`,
        [ownerId, preparationId],
      )
    : { rows: [] as any[] };
  const oldBagsByProduct = new Map<string, number>(
    oldUsage.rows.map((row: any) => [row.feed_product_id, Number(row.bags)]),
  );
  const oldRawUsage = preparationId
    ? await client.query(
        `SELECT material_id,SUM(quantity) AS quantity_kg
         FROM raw_material_logs
         WHERE owner_id=$1 AND preparation_id=$2 AND transaction_type='OUTWARD_PROCESSING'
         GROUP BY material_id`,
        [ownerId, preparationId],
      )
    : { rows: [] as any[] };
  const oldRawByMaterial = new Map<string, number>(
    oldRawUsage.rows.map((row: any) => [row.material_id, Number(row.quantity_kg)]),
  );
  const ingredients = new Map<string, { sourceType: 'feed' | 'raw_material'; itemId: string; quantityKg: number }>();
  for (const ingredient of d.ingredients) {
    const quantityKg = ingredient.quantity_kg != null
      ? Number(ingredient.quantity_kg)
      : ingredient.unit === 'bags'
        ? Number(ingredient.quantity) * kgPerBag
        : Number(ingredient.quantity);
    const roundedKg = Math.round(quantityKg * 1000) / 1000;
    if (!Number.isFinite(roundedKg) || roundedKg <= 0) {
      throw new HttpError(400, 'Ingredient quantities must be positive');
    }
    const key = `${ingredient.source_type}:${ingredient.item_id}`;
    const current = ingredients.get(key);
    ingredients.set(key, {
      sourceType: ingredient.source_type,
      itemId: ingredient.item_id,
      quantityKg: Math.round(((current?.quantityKg ?? 0) + roundedKg) * 1000) / 1000,
    });
  }
  if (!ingredients.size) throw new HttpError(400, 'Add at least one ingredient');
  const totalKg = Math.round(Array.from(ingredients.values()).reduce((sum, ingredient) => sum + ingredient.quantityKg, 0) * 1000) / 1000;
  const totalBags = Math.round((totalKg / kgPerBag) * 100000) / 100000;
  if (!Number.isFinite(totalBags) || totalBags <= 0) throw new HttpError(400, 'Ready Feed quantity is too small');

  const sourceRows: Array<{
    sourceType: 'feed' | 'raw_material';
    id: string;
    name: string;
    quantityKg: number;
    sharedPool: boolean;
    ratePerKg: number;
    totalCost: number;
  }> = [];
  for (const ingredient of ingredients.values()) {
    if (ingredient.sourceType === 'feed') {
      const product = await client.query(
        'SELECT id,name FROM feed_products WHERE id=$1 AND owner_id=$2 FOR UPDATE',
        [ingredient.itemId, ownerId],
      );
      if (!product.rows.length) throw new HttpError(404, 'Source feed product not found');
      if (product.rows[0].name.trim().toLowerCase() === 'ready feed') {
        throw new HttpError(400, 'Ready Feed cannot be used as its own ingredient');
      }
      const remaining = await remainingForProduct(client, ownerId, ingredient.itemId);
      const restored = oldBagsByProduct.get(ingredient.itemId) ?? 0;
      const availableKg = (remaining + restored) * kgPerBag;
      if (ingredient.quantityKg - availableKg > 0.0005) {
        throw new HttpError(400, `Not enough ${product.rows[0].name} in stock (${Math.max(0, availableKg)} kg available)`);
      }
      sourceRows.push({
        sourceType: 'feed',
        id: ingredient.itemId,
        name: product.rows[0].name,
        quantityKg: ingredient.quantityKg,
        sharedPool: false,
        ratePerKg: 0,
        totalCost: 0,
      });
    } else {
      const material = await client.query(
        `SELECT m.id,m.name,m.unit,m.is_shared_pool
         FROM raw_materials m
         JOIN farms f ON f.id=m.farm_id AND f.owner_user_id=m.owner_id
         WHERE m.id=$1 AND m.owner_id=$2
           AND (m.farm_id=$3 OR (m.is_shared_pool=TRUE AND $4::boolean))
         FOR UPDATE OF m`,
        [ingredient.itemId, ownerId, activeFarmId, sharedInventoryEnabled],
      );
      if (!material.rows.length) throw new HttpError(404, 'Source raw material not found');
      if (material.rows[0].is_shared_pool && !sharedInventoryEnabled) {
        throw new HttpError(409, 'Enable Central Godown to consume shared stock');
      }
      if (material.rows[0].unit !== 'kg') {
        throw new HttpError(500, 'Raw material has not been migrated to kilogram stock');
      }
      const stock = await client.query(
        `SELECT COALESCE(SUM(CASE WHEN transaction_type='INWARD' THEN quantity ELSE -quantity END),0) AS balance
         FROM raw_material_logs WHERE owner_id=$1 AND material_id=$2`,
        [ownerId, ingredient.itemId],
      );
      const availableKg = Number(stock.rows[0].balance) + (oldRawByMaterial.get(ingredient.itemId) ?? 0);
      if (ingredient.quantityKg - availableKg > 0.0005) {
        throw new HttpError(400, `Not enough ${material.rows[0].name} in stock (${Math.max(0, availableKg)} kg available)`);
      }
      let ratePerKg = 0;
      let totalCost = 0;
      if (material.rows[0].is_shared_pool) {
        const weightedCost = await client.query(
          `SELECT CASE WHEN COALESCE(SUM(quantity),0)>0
                       THEN SUM(total_amount)/SUM(quantity) ELSE 0 END AS rate
           FROM raw_material_logs
           WHERE owner_id=$1 AND material_id=$2 AND transaction_type='INWARD'`,
          [ownerId, ingredient.itemId],
        );
        ratePerKg = Number(weightedCost.rows[0].rate);
        totalCost = Math.round(ingredient.quantityKg * ratePerKg * 100) / 100;
      }
      sourceRows.push({
        sourceType: 'raw_material',
        id: ingredient.itemId,
        name: material.rows[0].name,
        quantityKg: ingredient.quantityKg,
        sharedPool: Boolean(material.rows[0].is_shared_pool),
        ratePerKg,
        totalCost,
      });
    }
  }

  const rawMaterialCost = sourceRows.reduce((sum, source) => sum + source.totalCost, 0);
  const preparedFeedCost = Math.round(rawMaterialCost * 100) / 100;
  const currentReady = await remainingForProduct(client, ownerId, readyFeedId);
  const oldReadyPurchase = preparationId
    ? await client.query(
        'SELECT COALESCE(SUM(bags),0) AS bags FROM feed_purchases WHERE owner_id=$1 AND preparation_id=$2',
        [ownerId, preparationId],
      )
    : { rows: [{ bags: 0 }] };
  const readyAfterReplacement =
    currentReady + totalBags - Number(oldReadyPurchase.rows[0].bags);
  if (readyAfterReplacement < -0.000005) {
    throw new HttpError(400, 'This change would remove Ready Feed that has already been consumed');
  }

  const date = d.date
    ?? (previous.rows[0]
      ? String(previous.rows[0].preparation_date).slice(0, 10)
      : new Date().toISOString().slice(0, 10));
  const description = `Prepared ${totalKg} kg (${sourceRows.map((row) => `${row.quantityKg} kg ${row.name}`).join(' + ')})`;
  let batchId = preparationId;
  if (preparationId) {
    await client.query('DELETE FROM feed_usage WHERE owner_id=$1 AND preparation_id=$2', [ownerId, preparationId]);
    await client.query('DELETE FROM feed_purchases WHERE owner_id=$1 AND preparation_id=$2', [ownerId, preparationId]);
    await client.query('DELETE FROM raw_material_logs WHERE owner_id=$1 AND preparation_id=$2', [ownerId, preparationId]);
    await client.query('DELETE FROM feed_preparation_items WHERE owner_id=$1 AND preparation_id=$2', [ownerId, preparationId]);
    await client.query(
      `UPDATE feed_preparations SET preparation_date=$3,total_quantity_kg=$4,remarks=$5
       WHERE id=$1 AND owner_id=$2`,
      [preparationId, ownerId, date, totalKg, description],
    );
  } else {
    const batch = await client.query(
      `INSERT INTO feed_preparations(owner_id,feed_product_id,preparation_date,total_quantity_kg,remarks)
       VALUES($1,$2,$3,$4,$5) RETURNING id`,
      [ownerId, readyFeedId, date, totalKg, description],
    );
    batchId = batch.rows[0].id;
  }
  for (const source of sourceRows) {
    if (source.sourceType === 'feed') {
      const bagsEquivalent = Math.round((source.quantityKg / kgPerBag) * 100000) / 100000;
      await client.query(
        `INSERT INTO feed_preparation_items(owner_id,preparation_id,source_type,feed_product_id,quantity_kg)
         VALUES($1,$2,'feed',$3,$4)`,
        [ownerId, batchId, source.id, source.quantityKg],
      );
      await client.query(
        `INSERT INTO feed_usage
         (owner_id,usage_date,quantity,unit,bags_equivalent,feed_type,feed_product_id,remarks,preparation_id)
         VALUES($1,$2,$3,'kg',$4,$5,$6,'Used in Ready Feed batch',$7)`,
        [ownerId, date, source.quantityKg, bagsEquivalent, source.name, source.id, batchId],
      );
    } else {
      await client.query(
        `INSERT INTO feed_preparation_items(owner_id,preparation_id,source_type,raw_material_id,quantity_kg)
         VALUES($1,$2,'raw_material',$3,$4)`,
        [ownerId, batchId, source.id, source.quantityKg],
      );
      await client.query(
        `INSERT INTO raw_material_logs
         (owner_id,farm_id,is_shared_pool,material_id,transaction_type,quantity,unit,transaction_date,
          remarks,preparation_id,rate_per_unit,total_amount)
         VALUES($1,$2,$3,$4,'OUTWARD_PROCESSING',$5,'kg',$6,'Used in Ready Feed batch',$7,$8,$9)`,
        [ownerId, activeFarmId, source.sharedPool, source.id, source.quantityKg,
          date, batchId, source.ratePerKg || null, source.totalCost || null],
      );
    }
  }
  await client.query(
    `INSERT INTO feed_purchases
     (owner_id,delivery_date,feed_type,feed_product_id,bags,cost_per_bag,total_cost,source,preparation_id)
     VALUES($1,$2,'Ready Feed',$3,$4,$5,$6,'PROCESSING',$7)`,
    [ownerId, date, readyFeedId, totalBags,
      totalBags > 0 ? Math.round((preparedFeedCost / totalBags) * 100) / 100 : 0,
      preparedFeedCost, batchId],
  );
  return { id: batchId, preparation_date: date, total_quantity_kg: totalKg, remarks: description };
}

export async function prepareReadyFeed(ownerId: string, d: { date?: string; ingredients: ReadyFeedIngredient[] }) {
  return withTx(async (client) => {
    await lockOwner(client, ownerId);
    const ready = await ensureReadyFeedInTx(client, ownerId);
    const settings = await client.query(`SELECT kg_per_bag FROM farms WHERE owner_user_id=$1 AND id=NULLIF(current_setting('app.farm_id',true),'')::uuid`, [ownerId]);
    const kgPerBag = Number(settings.rows[0]?.kg_per_bag ?? 50) || 50;
    return saveReadyFeedPreparation(client, ownerId, ready.id, kgPerBag, d);
  });
}

export async function updateReadyFeedPreparation(
  ownerId: string,
  id: string,
  d: { date?: string; ingredients: ReadyFeedIngredient[] },
) {
  return withTx(async (client) => {
    await lockOwner(client, ownerId);
    const ready = await ensureReadyFeedInTx(client, ownerId);
    const settings = await client.query(`SELECT kg_per_bag FROM farms WHERE owner_user_id=$1 AND id=NULLIF(current_setting('app.farm_id',true),'')::uuid`, [ownerId]);
    const kgPerBag = Number(settings.rows[0]?.kg_per_bag ?? 50) || 50;
    return saveReadyFeedPreparation(client, ownerId, ready.id, kgPerBag, d, id);
  });
}

export async function deleteReadyFeedPreparation(ownerId: string, id: string) {
  await withTx(async (client) => {
    await lockOwner(client, ownerId);
    const ready = await ensureReadyFeedInTx(client, ownerId);
    const batch = await client.query(
      'SELECT id,feed_product_id FROM feed_preparations WHERE id=$1 AND owner_id=$2 FOR UPDATE',
      [id, ownerId],
    );
    if (!batch.rows.length) throw new HttpError(404, 'Ready Feed preparation not found');
    if (batch.rows[0].feed_product_id !== ready.id) throw new HttpError(400, 'Preparation does not belong to Ready Feed');
    const readyRemaining = await remainingForProduct(client, ownerId, ready.id);
    const linked = await client.query(
      'SELECT COALESCE(SUM(bags),0) AS bags FROM feed_purchases WHERE owner_id=$1 AND preparation_id=$2',
      [ownerId, id],
    );
    if (readyRemaining - Number(linked.rows[0].bags) < -0.000005) {
      throw new HttpError(400, 'Cannot delete a batch that has already been consumed from Ready Feed');
    }
    await client.query('DELETE FROM feed_preparations WHERE id=$1 AND owner_id=$2', [id, ownerId]);
  });
}
