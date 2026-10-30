import { PoolClient } from 'pg';
import { query, withTx } from '../config/db';
import { HttpError } from '../utils/httpError';
import { ensureBatch } from './flock.service';

export async function getStock(ownerId: number) {
  const [totals, feeds, settings] = await Promise.all([
    query(
      `SELECT COALESCE((SELECT SUM(bags) FROM feed_purchases WHERE owner_id=$1),0) AS purchased,
              COALESCE((SELECT SUM(bags_equivalent) FROM feed_usage WHERE owner_id=$1),0) AS consumed`,
      [ownerId]
    ),
    query(
      `SELECT fp.id, fp.name AS feed_type,
              COALESCE((SELECT SUM(p.bags) FROM feed_purchases p WHERE p.owner_id=fp.owner_id AND p.feed_product_id=fp.id),0) AS purchased,
              COALESCE((SELECT SUM(u.bags_equivalent) FROM feed_usage u WHERE u.owner_id=fp.owner_id AND u.feed_product_id=fp.id),0) AS consumed
       FROM feed_products fp WHERE fp.owner_id=$1 ORDER BY lower(fp.name), fp.id`,
      [ownerId]
    ),
    query('SELECT low_stock_threshold AS threshold, kg_per_bag FROM users WHERE id=$1', [ownerId]),
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

export const listPurchases = (ownerId: number) =>
  query(
    `SELECT p.*, fp.name AS feed_type, fp.id AS feed_product_id
     FROM feed_purchases p JOIN feed_products fp ON fp.id=p.feed_product_id AND fp.owner_id=p.owner_id
     WHERE p.owner_id=$1 ORDER BY p.delivery_date DESC, p.id DESC`,
    [ownerId]
  );

export const listProducts = (ownerId: number) =>
  query(
    `SELECT fp.id, fp.name,
            COALESCE((SELECT SUM(p.bags) FROM feed_purchases p WHERE p.owner_id=fp.owner_id AND p.feed_product_id=fp.id),0) AS purchased_bags,
            COALESCE((SELECT SUM(u.bags_equivalent) FROM feed_usage u WHERE u.owner_id=fp.owner_id AND u.feed_product_id=fp.id),0) AS consumed_bags,
            COALESCE((SELECT SUM(p.total_cost) FROM feed_purchases p WHERE p.owner_id=fp.owner_id AND p.feed_product_id=fp.id),0) AS total_spent
     FROM feed_products fp WHERE fp.owner_id=$1 ORDER BY lower(fp.name), fp.id`,
    [ownerId]
  ).then((rows) => rows.map((row) => ({ ...row, remaining_bags: row.purchased_bags - row.consumed_bags })));

export async function getProductDetail(ownerId: number, id: number, month: string) {
  const start = `${month}-01`;
  const [products, purchases, usage, monthly] = await Promise.all([
    query(
      `SELECT fp.id, fp.name,
              COALESCE((SELECT SUM(p.bags) FROM feed_purchases p WHERE p.owner_id=fp.owner_id AND p.feed_product_id=fp.id),0) AS purchased_bags,
              COALESCE((SELECT SUM(u.bags_equivalent) FROM feed_usage u WHERE u.owner_id=fp.owner_id AND u.feed_product_id=fp.id),0) AS consumed_bags,
              COALESCE((SELECT SUM(p.total_cost) FROM feed_purchases p WHERE p.owner_id=fp.owner_id AND p.feed_product_id=fp.id),0) AS total_spent
       FROM feed_products fp WHERE fp.owner_id=$1 AND fp.id=$2`,
      [ownerId, id]
    ),
    query('SELECT * FROM feed_purchases WHERE owner_id=$1 AND feed_product_id=$2 ORDER BY delivery_date DESC,id DESC', [ownerId, id]),
    query(
      `SELECT u.*, b.batch_name FROM feed_usage u LEFT JOIN flock_batches b ON b.id=u.batch_id
       WHERE u.owner_id=$1 AND u.feed_product_id=$2 ORDER BY u.usage_date DESC,u.id DESC`,
      [ownerId, id]
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
  return {
    ...product,
    remaining_bags: product.purchased_bags - product.consumed_bags,
    monthly_used_bags: monthly[0].consumed_bags,
    month,
    purchases,
    usage,
  };
}

export async function createProduct(ownerId: number, name: string) {
  const rows = await query(
    'INSERT INTO feed_products(owner_id,name) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING id,name',
    [ownerId, name.trim()]
  );
  if (!rows.length) throw new HttpError(409, 'A feed product with this name already exists');
  return rows[0];
}

export async function updateProduct(ownerId: number, id: number, name: string) {
  return withTx(async (client) => {
    await lockOwner(client, ownerId);
    const updated = await client.query(
      'UPDATE feed_products SET name=$3 WHERE id=$1 AND owner_id=$2 RETURNING id,name',
      [id, ownerId, name.trim()]
    );
    if (!updated.rows.length) throw new HttpError(404, 'Feed product not found');
    await client.query('UPDATE feed_purchases SET feed_type=$3 WHERE owner_id=$2 AND feed_product_id=$1', [id, ownerId, name.trim()]);
    await client.query('UPDATE feed_usage SET feed_type=$3 WHERE owner_id=$2 AND feed_product_id=$1', [id, ownerId, name.trim()]);
    return updated.rows[0];
  });
}

export async function deleteProduct(ownerId: number, id: number) {
  await withTx(async (client) => {
    await lockOwner(client, ownerId);
    const rows = await client.query('DELETE FROM feed_products WHERE id=$1 AND owner_id=$2 RETURNING id', [id, ownerId]);
    if (!rows.rows.length) throw new HttpError(404, 'Feed product not found');
  });
}

const lockOwner = (client: PoolClient, ownerId: number) => client.query('SELECT pg_advisory_xact_lock($1::bigint)', [ownerId]);

async function remainingForProduct(
  client: PoolClient,
  ownerId: number,
  productId: number,
  excludeUsageId?: number,
  excludePurchaseId?: number
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

export async function createPurchase(ownerId: number, d: any) {
  return withTx(async (client) => {
    await lockOwner(client, ownerId);
    const product = await client.query('SELECT name FROM feed_products WHERE id=$1 AND owner_id=$2', [d.feed_product_id, ownerId]);
    if (!product.rows.length) throw new HttpError(404, 'Feed product not found');
    const r = await client.query(
      `INSERT INTO feed_purchases (owner_id,feed_product_id,delivery_date,feed_type,bags,cost_per_bag)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [ownerId, d.feed_product_id, d.delivery_date, product.rows[0].name, d.bags, d.cost_per_bag]
    );
    return r.rows[0];
  });
}

export async function updatePurchase(ownerId: number, id: number, d: any) {
  return withTx(async (client) => {
    await lockOwner(client, ownerId);
    const existing = await client.query('SELECT * FROM feed_purchases WHERE id=$1 AND owner_id=$2 FOR UPDATE', [id, ownerId]);
    if (!existing.rows.length) throw new HttpError(404, 'Feed purchase not found');
    const old = existing.rows[0];
    const product = await client.query('SELECT name FROM feed_products WHERE id=$1 AND owner_id=$2', [d.feed_product_id, ownerId]);
    if (!product.rows.length) throw new HttpError(404, 'Feed product not found');
    const remaining = await remainingForProduct(client, ownerId, old.feed_product_id, undefined, id);
    if (old.feed_product_id === d.feed_product_id && remaining + d.bags < 0) {
      throw new HttpError(400, 'This change would make feed stock negative');
    }
    if (old.feed_product_id !== d.feed_product_id && remaining < 0) {
      throw new HttpError(400, 'This change would leave used feed without enough stock');
    }
    const r = await client.query(
      `UPDATE feed_purchases SET delivery_date=$3, feed_product_id=$4, feed_type=$5, bags=$6, cost_per_bag=$7
       WHERE id=$1 AND owner_id=$2 RETURNING *`,
      [id, ownerId, d.delivery_date, d.feed_product_id, product.rows[0].name, d.bags, d.cost_per_bag]
    );
    return r.rows[0];
  });
}

export async function deletePurchase(ownerId: number, id: number) {
  await withTx(async (client) => {
    await lockOwner(client, ownerId);
    const existing = await client.query('SELECT feed_product_id FROM feed_purchases WHERE id=$1 AND owner_id=$2 FOR UPDATE', [id, ownerId]);
    if (!existing.rows.length) throw new HttpError(404, 'Feed purchase not found');
    const remaining = await remainingForProduct(client, ownerId, existing.rows[0].feed_product_id, undefined, id);
    if (remaining < 0) throw new HttpError(400, 'Cannot delete this delivery because feed of this type has already been used');
    await client.query('DELETE FROM feed_purchases WHERE id=$1 AND owner_id=$2', [id, ownerId]);
  });
}

export const listUsage = (ownerId: number) =>
  query(
    `SELECT u.*, b.batch_name FROM feed_usage u LEFT JOIN flock_batches b ON b.id=u.batch_id
     WHERE u.owner_id=$1 ORDER BY u.usage_date DESC, u.id DESC`,
    [ownerId]
  );

export async function createUsage(ownerId: number, d: any) {
  await ensureBatch(ownerId, d.batch_id);
  return withTx(async (client) => {
    await lockOwner(client, ownerId);
    const settings = await client.query('SELECT kg_per_bag FROM users WHERE id=$1', [ownerId]);
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

export async function updateUsage(ownerId: number, id: number, d: any) {
  await ensureBatch(ownerId, d.batch_id);
  return withTx(async (client) => {
    await lockOwner(client, ownerId);
    const existing = await client.query('SELECT id FROM feed_usage WHERE id=$1 AND owner_id=$2 FOR UPDATE', [id, ownerId]);
    if (!existing.rows.length) throw new HttpError(404, 'Feed usage log not found');
    const settings = await client.query('SELECT kg_per_bag FROM users WHERE id=$1', [ownerId]);
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

export async function deleteUsage(ownerId: number, id: number) {
  await withTx(async (client) => {
    await lockOwner(client, ownerId);
    const r = await client.query('DELETE FROM feed_usage WHERE id=$1 AND owner_id=$2 RETURNING id', [id, ownerId]);
    if (!r.rows.length) throw new HttpError(404, 'Feed usage log not found');
  });
}
