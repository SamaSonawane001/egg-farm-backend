import { query } from '../config/db';
import { getStock } from './feed.service';
import { availableStock } from './egg.service';

export async function getDashboard(ownerId: string, today: string) {
  const [overview, stock, eggStock] = await Promise.all([
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
       ),
       week AS (
         SELECT to_char(d::date,'YYYY-MM-DD') AS date,
                COALESCE(SUM(e.net_eggs),0) AS net_eggs
         FROM generate_series($2::date - 6, $2::date, interval '1 day') d
         LEFT JOIN egg_production e
           ON e.collection_date=d::date AND e.owner_id=$1
         GROUP BY d
       )
       SELECT
         COALESCE((SELECT SUM(quantity) FROM flock_batches WHERE owner_id=$1),0)
           - COALESCE((SELECT SUM(dead_count) FROM mortality_logs WHERE owner_id=$1),0) AS active_birds,
         COALESCE((SELECT SUM(net_eggs) FROM egg_production
                   WHERE owner_id=$1 AND collection_date=$2::date),0) AS today_eggs,
         COALESCE((SELECT SUM(i.grand_total) FROM invoices i, period p
                   WHERE i.owner_id=$1 AND i.invoice_date >= p.start_date AND i.invoice_date < p.end_date),0) AS month_revenue,
         COALESCE((SELECT SUM(amount) FROM expense_rows),0) AS month_expense,
         (SELECT COUNT(*) FROM expense_rows) AS month_expense_records,
         (SELECT start_date::text FROM period) AS expense_period_start,
         (SELECT end_date::text FROM period) AS expense_period_end,
         COALESCE((SELECT json_agg(json_build_object('date',date,'net_eggs',net_eggs) ORDER BY date)
                   FROM week),'[]'::json) AS last7_eggs`,
      [ownerId, today]
    ),
    getStock(ownerId),
    availableStock(ownerId),
  ]);
  const summary = overview[0];
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
    month_revenue: Number(summary.month_revenue),
    month_expense: Number(summary.month_expense),
    month_profit: Number(summary.month_revenue) - Number(summary.month_expense),
    last7_eggs: summary.last7_eggs,
  };
}
