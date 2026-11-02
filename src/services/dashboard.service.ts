import { query } from '../config/db';
import { getStock } from './feed.service';
import { availableStock } from './egg.service';

export async function getDashboard(ownerId: number, today: string) {
  const [birds, eggs, money, week, stock, eggStock] = await Promise.all([
    query(
      `SELECT COALESCE((SELECT SUM(quantity) FROM flock_batches WHERE owner_id=$1),0)
            - COALESCE((SELECT SUM(dead_count) FROM mortality_logs WHERE owner_id=$1),0) AS active_birds`,
      [ownerId]
    ),
    query(
      `SELECT COALESCE(SUM(net_eggs) FILTER (WHERE collection_date=$2::date),0) AS today_eggs,
              COALESCE(SUM(net_eggs),0) AS total_produced
       FROM egg_production WHERE owner_id=$1`,
      [ownerId, today]
    ),
    query(
      `WITH period AS (
         SELECT date_trunc('month',$2::date)::date AS start_date,
                (date_trunc('month',$2::date) + interval '1 month')::date AS end_date
       ),
       expense_rows AS (
         SELECT f.total_cost AS amount
         FROM flock_batches f, period p
         WHERE f.owner_id=$1 AND f.arrival_date >= p.start_date AND f.arrival_date < p.end_date
         UNION ALL
         SELECT f.total_cost
         FROM feed_purchases f, period p
         WHERE f.owner_id=$1 AND f.source='PURCHASE'
           AND f.delivery_date >= p.start_date AND f.delivery_date < p.end_date
         UNION ALL
         SELECT r.total_amount
         FROM raw_material_logs r, period p
         WHERE r.owner_id=$1 AND r.transaction_type='INWARD'
           AND r.transaction_date >= p.start_date AND r.transaction_date < p.end_date
         UNION ALL
         SELECT m.total_cost
         FROM medicine_batches m, period p
         WHERE m.owner_id=$1 AND m.received_date >= p.start_date AND m.received_date < p.end_date
       )
       SELECT
         COALESCE((SELECT SUM(i.grand_total) FROM invoices i, period p
                   WHERE i.owner_id=$1 AND i.invoice_date >= p.start_date AND i.invoice_date < p.end_date),0) AS month_revenue,
         COALESCE((SELECT SUM(amount) FROM expense_rows),0) AS month_expense,
         (SELECT COUNT(*) FROM expense_rows) AS month_expense_records,
         (SELECT start_date::text FROM period) AS expense_period_start,
         (SELECT end_date::text FROM period) AS expense_period_end`,
      [ownerId, today]
    ),
    query(
      `SELECT to_char(d::date,'YYYY-MM-DD') AS date, COALESCE(SUM(e.net_eggs),0) AS net_eggs
       FROM generate_series($2::date - 6, $2::date, interval '1 day') d
       LEFT JOIN egg_production e ON e.collection_date = d::date AND e.owner_id=$1
       GROUP BY d ORDER BY d`,
      [ownerId, today]
    ),
    getStock(ownerId),
    availableStock(ownerId),
  ]);
  console.info('Dashboard monthly expense aggregation:', {
    periodStart: money[0].expense_period_start,
    periodEndExclusive: money[0].expense_period_end,
    recordsFound: Number(money[0].month_expense_records),
    total: Number(money[0].month_expense),
  });
  return {
    active_birds: birds[0].active_birds,
    today_eggs: eggs[0].today_eggs,
    available_eggs: eggStock.available_eggs,
    feed_remaining_bags: stock.remaining,
    feed_low_stock: stock.low_stock,
    feed_threshold: stock.threshold,
    month_revenue: Number(money[0].month_revenue),
    month_expense: Number(money[0].month_expense),
    month_profit: Number(money[0].month_revenue) - Number(money[0].month_expense),
    last7_eggs: week,
  };
}
