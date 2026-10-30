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
      `WITH m AS (SELECT date_trunc('month',$2::date)::date AS s, (date_trunc('month',$2::date) + interval '1 month')::date AS e)
       SELECT
         COALESCE((SELECT SUM(grand_total) FROM invoices, m WHERE owner_id=$1 AND invoice_date >= m.s AND invoice_date < m.e),0) AS month_revenue,
         COALESCE((SELECT SUM(total_cost) FROM flock_batches, m WHERE owner_id=$1 AND arrival_date >= m.s AND arrival_date < m.e),0)
       + COALESCE((SELECT SUM(total_cost) FROM feed_purchases, m WHERE owner_id=$1 AND delivery_date >= m.s AND delivery_date < m.e),0) AS month_expense`,
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
  return {
    active_birds: birds[0].active_birds,
    today_eggs: eggs[0].today_eggs,
    available_eggs: eggStock.available_eggs,
    feed_remaining_bags: stock.remaining,
    feed_low_stock: stock.low_stock,
    feed_threshold: stock.threshold,
    month_revenue: money[0].month_revenue,
    month_expense: money[0].month_expense,
    month_profit: money[0].month_revenue - money[0].month_expense,
    last7_eggs: week,
  };
}
