import { query } from '../config/db';

export async function monthlyBreakdown(
  ownerId: number,
  month: number,
  year: number
) {
  const rows = await query(
    `WITH period AS (
       SELECT make_date($3::int,$2::int,1) AS start_date,
              (make_date($3::int,$2::int,1) + interval '1 month')::date AS end_date
     ),
     transactions AS (
       SELECT ('feed-' || p.id::text) AS id,p.delivery_date AS date,'Feed'::text AS category,
              p.feed_type || ' (' || p.bags::text || ' bags)' AS title,
              p.total_cost AS amount,NULL::text AS vendor,NULL::text AS bill_image_url
       FROM feed_purchases p,period d
       WHERE p.owner_id=$1 AND p.delivery_date >= d.start_date AND p.delivery_date < d.end_date
         AND p.source='PURCHASE'
       UNION ALL
       SELECT ('raw-' || l.id::text),l.transaction_date,'Raw Materials'::text,
              m.name || ' (' || l.quantity::text || ' ' || l.unit || ')',
              l.total_amount,COALESCE(l.vendor_name,l.supplier),l.bill_image_url
       FROM raw_material_logs l
       JOIN raw_materials m ON m.id=l.material_id AND m.owner_id=l.owner_id,
       period d
       WHERE l.owner_id=$1 AND l.transaction_type='INWARD'
         AND l.transaction_date >= d.start_date AND l.transaction_date < d.end_date
       UNION ALL
       SELECT ('medicine-' || b.id::text),b.received_date,'Medicines & Health'::text,
              m.name || ' (' || b.received_quantity::text || ' ' || b.unit || ')',
              b.total_cost,l.vendor_name,l.bill_image_url
       FROM medicine_batches b
       JOIN medicines m ON m.id=b.medicine_id AND m.owner_id=b.owner_id
       LEFT JOIN medicine_logs l ON l.owner_id=b.owner_id AND l.batch_id=b.id,
       period d
       WHERE b.owner_id=$1 AND b.received_date >= d.start_date AND b.received_date < d.end_date
       UNION ALL
       SELECT ('flock-' || f.id::text),f.arrival_date,'Birds / Chicks'::text,
              f.batch_name || ' (' || f.quantity::text || ' birds)',
              f.total_cost,NULL::text,NULL::text
       FROM flock_batches f,period d
       WHERE f.owner_id=$1 AND f.arrival_date >= d.start_date AND f.arrival_date < d.end_date
     )
     SELECT id,to_char(date,'YYYY-MM-DD') AS date,category,title,amount,vendor,bill_image_url
     FROM transactions
     ORDER BY date DESC,id DESC`,
    [ownerId, month, year]
  );
  const itemizedTransactions = rows.map((row: any) => ({
    ...row,
    amount: Number(row.amount ?? 0),
  }));
  const amounts = new Map<string, number>();
  for (const transaction of itemizedTransactions) {
    amounts.set(
      transaction.category,
      (amounts.get(transaction.category) ?? 0) + transaction.amount
    );
  }
  const total = [...amounts.values()].reduce((sum, amount) => sum + amount, 0);
  const categories = [...amounts.entries()].map(([category, amount]) => ({
    category,
    amount: Math.round((amount + Number.EPSILON) * 100) / 100,
    percentage: total > 0
      ? Math.round((amount / total) * 1000) / 10
      : 0,
  }));
  return {
    total_monthly_expense: Math.round((total + Number.EPSILON) * 100) / 100,
    month,
    year,
    categories,
    itemized_transactions: itemizedTransactions,
  };
}
