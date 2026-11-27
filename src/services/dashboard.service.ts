import { query } from '../config/db';
import { getFarmContext } from '../config/farmContext';
import { getStock } from './feed.service';
import { availableStock } from './egg.service';
import { listMaterials } from './rawMaterial.service';

export async function getDashboard(ownerId: string, today: string, allFarms = false) {
  const farmContext = getFarmContext();
  const farmSettings = await query<{
    shared_inventory_enabled: boolean;
    primary_farm_id: string;
  }>(
    `SELECT u.shared_inventory_enabled,f.id AS primary_farm_id
     FROM users u JOIN farms f ON f.owner_user_id=u.id AND f.is_primary
     WHERE u.id=$1`,
    [ownerId],
  );
  const sharedInventoryEnabled =
    farmSettings[0]?.shared_inventory_enabled === true;
  const primaryFarmId = farmSettings[0]?.primary_farm_id ?? null;
  const [overview, stock, eggStock, rawMaterials] = await Promise.all([
    query(
      `WITH period AS (
         SELECT date_trunc('month',$2::date)::date AS start_date,
                (date_trunc('month',$2::date) + interval '1 month')::date AS end_date
       ),
       expense_rows AS (
         SELECT f.total_cost AS amount
         FROM flock_batches f, period p
         WHERE f.owner_id=$1 AND ($3::boolean OR f.farm_id=$4::uuid)
           AND f.arrival_date >= p.start_date AND f.arrival_date < p.end_date
         UNION ALL
         SELECT f.total_cost
         FROM feed_purchases f, period p
         WHERE f.owner_id=$1 AND f.source='PURCHASE'
           AND ($3::boolean OR f.farm_id=$4::uuid)
           AND f.delivery_date >= p.start_date AND f.delivery_date < p.end_date
         UNION ALL
         SELECT r.total_amount
         FROM raw_material_logs r, period p
         WHERE r.owner_id=$1 AND r.transaction_type='INWARD'
           AND (
             ($3::boolean AND r.farm_id=ANY(string_to_array(
               NULLIF(current_setting('app.farm_ids',true),''),','
             )::uuid[]))
             OR (NOT $3::boolean
                 AND $4::uuid=$6::uuid AND r.is_shared_pool=TRUE)
             OR (NOT r.is_shared_pool AND ($3::boolean OR r.farm_id=$4::uuid))
           )
           AND r.transaction_date >= p.start_date AND r.transaction_date < p.end_date
         UNION ALL
         SELECT r.total_amount
         FROM raw_material_logs r, period p
         WHERE r.owner_id=$1 AND r.transaction_type='OUTWARD_PROCESSING'
           AND NOT $3::boolean AND $4::uuid<>$6::uuid
           AND r.is_shared_pool=TRUE AND r.farm_id=$4::uuid
           AND r.transaction_date >= p.start_date AND r.transaction_date < p.end_date
         UNION ALL
         SELECT -r.total_amount
         FROM raw_material_logs r, period p
         WHERE r.owner_id=$1 AND r.transaction_type='OUTWARD_PROCESSING'
           AND NOT $3::boolean AND $4::uuid=$6::uuid
           AND r.is_shared_pool=TRUE AND r.farm_id<>$6::uuid
           AND r.transaction_date >= p.start_date AND r.transaction_date < p.end_date
         UNION ALL
         SELECT m.total_cost
         FROM medicine_batches m, period p
         WHERE m.owner_id=$1
           AND (
             ($3::boolean AND m.farm_id=ANY(string_to_array(
               NULLIF(current_setting('app.farm_ids',true),''),','
             )::uuid[]))
             OR (NOT $3::boolean AND NOT $5::boolean
                 AND $4::uuid=$6::uuid AND m.is_shared_pool=TRUE)
             OR (NOT m.is_shared_pool AND ($3::boolean OR m.farm_id=$4::uuid))
           )
           AND m.received_date >= p.start_date AND m.received_date < p.end_date
         UNION ALL
         SELECT u.total_cost
         FROM medicine_usage u, period p
         WHERE u.owner_id=$1 AND NOT $3::boolean AND $5::boolean
           AND u.is_shared_pool=TRUE AND u.farm_id=$4::uuid
           AND u.usage_date >= p.start_date AND u.usage_date < p.end_date
         UNION ALL
         SELECT e.amount
         FROM farm_expenses e, period p
         WHERE e.owner_id=$1 AND ($3::boolean OR e.farm_id=$4::uuid)
           AND e.expense_date >= p.start_date AND e.expense_date < p.end_date
       ),
       week AS (
         SELECT to_char(d::date,'YYYY-MM-DD') AS date,
                COALESCE(SUM(e.net_eggs),0) AS net_eggs
         FROM generate_series($2::date - 6, $2::date, interval '1 day') d
         LEFT JOIN egg_production e
           ON e.collection_date=d::date AND e.owner_id=$1
          AND ($3::boolean OR e.farm_id=$4::uuid)
         GROUP BY d
       )
       SELECT
         COALESCE((SELECT SUM(quantity) FROM flock_batches
                   WHERE owner_id=$1 AND ($3::boolean OR farm_id=$4::uuid)),0)
           - COALESCE((SELECT SUM(dead_count) FROM mortality_logs
                       WHERE owner_id=$1 AND ($3::boolean OR farm_id=$4::uuid)),0) AS active_birds,
         COALESCE((SELECT SUM(net_eggs) FROM egg_production
                   WHERE owner_id=$1 AND collection_date=$2::date
                     AND ($3::boolean OR farm_id=$4::uuid)),0) AS today_eggs,
         COALESCE((SELECT SUM(cp.amount_paid) FROM customer_payments cp, period p
                   WHERE cp.owner_id=$1 AND cp.payment_date >= p.start_date
                     AND cp.payment_date < p.end_date
                     AND ($3::boolean OR cp.farm_id=$4::uuid)),0)
         + COALESCE((SELECT SUM(i.grand_total) FROM invoices i, period p
                     WHERE i.owner_id=$1 AND i.customer_id IS NULL
                       AND i.payment_status='paid'
                       AND ($3::boolean OR i.farm_id=$4::uuid)
                       AND COALESCE(i.paid_at,i.invoice_date::timestamptz) >= p.start_date
                       AND COALESCE(i.paid_at,i.invoice_date::timestamptz) < p.end_date),0)
           AS month_revenue,
         COALESCE((SELECT SUM(GREATEST(billed-paid,0)) FROM (
                     SELECT COALESCE(SUM(i.grand_total),0) AS billed,
                            COALESCE((SELECT SUM(cp.amount_paid) FROM customer_payments cp
                                      WHERE cp.owner_id=c.owner_id AND cp.customer_id=c.id
                                        AND ($3::boolean OR cp.farm_id=$4::uuid)),0) AS paid
                     FROM customers c
                     LEFT JOIN invoices i ON i.owner_id=c.owner_id AND i.customer_id=c.id
                       AND ($3::boolean OR i.farm_id=$4::uuid)
                     WHERE c.owner_id=$1 AND ($3::boolean OR c.farm_id=$4::uuid)
                     GROUP BY c.id
                   ) balances),0)
         + COALESCE((SELECT SUM(GREATEST(i.grand_total-i.paid_amount,0)) FROM invoices i
                     WHERE i.owner_id=$1 AND i.customer_id IS NULL
                       AND ($3::boolean OR i.farm_id=$4::uuid)),0) AS pending_payments,
         COALESCE((SELECT SUM(amount) FROM expense_rows),0) AS month_expense,
         (SELECT COUNT(*) FROM expense_rows) AS month_expense_records,
         (SELECT start_date::text FROM period) AS expense_period_start,
         (SELECT end_date::text FROM period) AS expense_period_end,
         COALESCE((SELECT json_agg(json_build_object('date',date,'net_eggs',net_eggs) ORDER BY date)
                   FROM week),'[]'::json) AS last7_eggs`,
      [ownerId, today, allFarms, farmContext?.farmId ?? null,
        sharedInventoryEnabled, primaryFarmId]
    ),
    getStock(ownerId),
    availableStock(ownerId, allFarms),
    listMaterials(ownerId),
  ]);
  const summary = overview[0];
  const farmBreakdown = allFarms
    ? await query(
      `WITH period AS (
         SELECT date_trunc('month',$2::date)::date AS start_date,
                (date_trunc('month',$2::date) + interval '1 month')::date AS end_date
       )
       SELECT f.id AS farm_id,f.name AS farm_name,
         COALESCE((SELECT SUM(b.quantity) FROM flock_batches b
                   WHERE b.owner_id=$1 AND b.farm_id=f.id),0)
         - COALESCE((SELECT SUM(m.dead_count) FROM mortality_logs m
                     WHERE m.owner_id=$1 AND m.farm_id=f.id),0) AS active_birds,
         COALESCE((SELECT SUM(e.net_eggs) FROM egg_production e
                   WHERE e.owner_id=$1 AND e.farm_id=f.id AND e.collection_date=$2::date),0) AS today_eggs,
         COALESCE((SELECT SUM(p.amount_paid) FROM customer_payments p,period d
                   WHERE p.owner_id=$1 AND p.farm_id=f.id
                     AND p.payment_date >= d.start_date AND p.payment_date < d.end_date),0)
         + COALESCE((SELECT SUM(i.grand_total) FROM invoices i,period d
                     WHERE i.owner_id=$1 AND i.farm_id=f.id AND i.customer_id IS NULL
                       AND i.payment_status='paid'
                       AND COALESCE(i.paid_at,i.invoice_date::timestamptz) >= d.start_date
                       AND COALESCE(i.paid_at,i.invoice_date::timestamptz) < d.end_date),0) AS month_revenue,
         COALESCE((SELECT SUM(x.amount) FROM (
           SELECT b.total_cost AS amount FROM flock_batches b,period d
           WHERE b.owner_id=$1 AND b.farm_id=f.id
             AND b.arrival_date >= d.start_date AND b.arrival_date < d.end_date
           UNION ALL
           SELECT p.total_cost FROM feed_purchases p,period d
           WHERE p.owner_id=$1 AND p.farm_id=f.id AND p.source='PURCHASE'
             AND p.delivery_date >= d.start_date AND p.delivery_date < d.end_date
           UNION ALL
           SELECT l.total_amount FROM raw_material_logs l,period d
           WHERE l.owner_id=$1 AND l.farm_id=f.id AND l.transaction_type='INWARD'
             AND l.is_shared_pool=FALSE
             AND l.transaction_date >= d.start_date AND l.transaction_date < d.end_date
           UNION ALL
           SELECT l.total_amount FROM raw_material_logs l,period d
           WHERE l.owner_id=$1 AND f.is_primary
             AND l.is_shared_pool=TRUE AND l.transaction_type='INWARD'
             AND l.transaction_date >= d.start_date AND l.transaction_date < d.end_date
           UNION ALL
           SELECT l.total_amount FROM raw_material_logs l,period d
           WHERE l.owner_id=$1 AND l.farm_id=f.id
             AND l.transaction_type='OUTWARD_PROCESSING' AND l.is_shared_pool=TRUE
             AND NOT f.is_primary
             AND l.transaction_date >= d.start_date AND l.transaction_date < d.end_date
           UNION ALL
           SELECT -l.total_amount FROM raw_material_logs l,period d
           WHERE l.owner_id=$1 AND f.is_primary
             AND l.transaction_type='OUTWARD_PROCESSING' AND l.is_shared_pool=TRUE
             AND l.farm_id<>f.id
             AND l.transaction_date >= d.start_date AND l.transaction_date < d.end_date
           UNION ALL
           SELECT b.total_cost FROM medicine_batches b,period d
           WHERE b.owner_id=$1 AND b.farm_id=f.id
             AND b.is_shared_pool=FALSE
             AND b.received_date >= d.start_date AND b.received_date < d.end_date
           UNION ALL
           SELECT b.total_cost FROM medicine_batches b,period d
           WHERE b.owner_id=$1 AND f.is_primary AND NOT $5::boolean
             AND b.is_shared_pool=TRUE
             AND b.received_date >= d.start_date AND b.received_date < d.end_date
           UNION ALL
           SELECT u.total_cost FROM medicine_usage u,period d
           WHERE u.owner_id=$1 AND u.farm_id=f.id
             AND u.is_shared_pool=TRUE AND $5::boolean
             AND u.usage_date >= d.start_date AND u.usage_date < d.end_date
           UNION ALL
           SELECT e.amount FROM farm_expenses e,period d
           WHERE e.owner_id=$1 AND e.farm_id=f.id
             AND e.expense_date >= d.start_date AND e.expense_date < d.end_date
         ) x),0) AS month_expense
       FROM farms f
       WHERE f.owner_user_id=$1
         AND f.id=ANY(string_to_array(current_setting('app.farm_ids',true),',')::uuid[])
       ORDER BY f.is_primary DESC,f.created_at,f.id`,
      [ownerId, today, allFarms, farmContext?.farmId ?? null,
        sharedInventoryEnabled],
    )
    : [];
  console.info('Dashboard monthly expense aggregation:', {
    periodStart: summary.expense_period_start,
    periodEndExclusive: summary.expense_period_end,
    recordsFound: Number(summary.month_expense_records),
    total: Number(summary.month_expense),
  });
  return {
    active_birds: summary.active_birds,
    today_eggs: summary.today_eggs,
    available_eggs: eggStock.available_eggs,
    feed_remaining_bags: stock.remaining,
    feed_low_stock: stock.low_stock,
    feed_threshold: stock.threshold,
    stock_breakdown: {
      ready_feed_bags: stock.feeds
        .filter((feed) => String(feed.feed_type).trim().toLowerCase() === 'ready feed')
        .reduce((total, feed) => total + Number(feed.remaining), 0),
      feed_products: stock.feeds.map((feed) => ({
        ...feed,
        purchased: Number(feed.purchased),
        consumed: Number(feed.consumed),
        remaining: Number(feed.remaining),
      })),
      raw_materials: rawMaterials.map((material) => ({
        ...material,
        current_stock: Number(material.current_stock),
        bags_equivalent: Number(material.current_stock) /
          Math.max(Number(material.kg_per_bag) || 50, 1),
      })),
    },
    month_revenue: Number(summary.month_revenue),
    pending_payments: Number(summary.pending_payments),
    month_expense: Number(summary.month_expense),
    month_profit: Number(summary.month_revenue) - Number(summary.month_expense),
    last7_eggs: summary.last7_eggs,
    farm_breakdown: farmBreakdown.map((farm) => ({
      ...farm,
      month_profit: Number(farm.month_revenue) - Number(farm.month_expense),
    })),
  };
}
