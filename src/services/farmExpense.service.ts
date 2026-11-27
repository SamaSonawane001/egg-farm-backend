import { query, withTx } from '../config/db';
import { HttpError } from '../utils/httpError';
import { getActiveFarmId, resolveFarmId } from './farmId.service';

const categories = [
  'farm_labour_salary',
  'feed_truck_unloading_hamali',
  'feed_mill_expense',
  'electricity_water',
  'transport_diesel',
  'other_farm_expense',
] as const;

export async function listFarmExpenses(
  ownerId: string,
  month: number,
  year: number,
  category?: string,
) {
  const farmId = getActiveFarmId(ownerId);
  const rows = await query(
    `WITH period AS (
       SELECT make_date($2::int,$1::int,1) AS start_date,
              (make_date($2::int,$1::int,1)+interval '1 month')::date AS end_date
     )
     SELECT e.*,
       COALESCE(SUM(e.amount) OVER (),0) AS month_total,
       COALESCE(SUM(e.amount) FILTER (WHERE e.category IN
         ('farm_labour_salary','feed_truck_unloading_hamali')) OVER (),0) AS labour_total,
       COALESCE(SUM(e.amount) FILTER (WHERE e.category NOT IN
         ('farm_labour_salary','feed_truck_unloading_hamali')) OVER (),0) AS operations_total
     FROM farm_expenses e, period p
     WHERE e.owner_id=$3 AND e.farm_id=$5
       AND e.expense_date >= p.start_date AND e.expense_date < p.end_date
       AND ($4::text IS NULL
         OR ($4='electricity_transport' AND e.category IN ('electricity_water','transport_diesel'))
         OR e.category=$4)
     ORDER BY e.expense_date DESC,e.created_at DESC,e.id DESC`,
    [month, year, ownerId, category ?? null, farmId],
  );
  const [summary] = await query(
    `SELECT COALESCE(SUM(amount),0) AS month_total,
       COALESCE(SUM(amount) FILTER (WHERE category IN
         ('farm_labour_salary','feed_truck_unloading_hamali')),0) AS labour_total,
       COALESCE(SUM(amount) FILTER (WHERE category NOT IN
         ('farm_labour_salary','feed_truck_unloading_hamali')),0) AS operations_total
     FROM farm_expenses
     WHERE owner_id=$1 AND farm_id=$4
       AND expense_date >= make_date($3::int,$2::int,1)
       AND expense_date < (make_date($3::int,$2::int,1)+interval '1 month')::date`,
    [ownerId, month, year, farmId],
  );
  return { expenses: rows, summary };
}

export async function createFarmExpense(ownerId: string, d: any) {
  return withTx(async (client) => {
    const farmId = await resolveFarmId(client, ownerId);
    const result = await client.query(
      `INSERT INTO farm_expenses
        (owner_id,farm_id,category,person_or_vendor,description,workers_count,amount,payment_mode,expense_date)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [ownerId, farmId, d.category, d.person_or_vendor, d.description, d.workers_count,
        d.amount, d.payment_mode, d.expense_date],
    );
    return result.rows[0];
  });
}

export async function updateFarmExpense(ownerId: string, id: string, d: any) {
  if (!categories.includes(d.category)) throw new HttpError(400, 'Invalid farm expense category');
  const farmId = getActiveFarmId(ownerId);
  const rows = await query(
    `UPDATE farm_expenses SET category=$3,person_or_vendor=$4,description=$5,
       workers_count=$6,amount=$7,payment_mode=$8,expense_date=$9
     WHERE id=$1 AND owner_id=$2 AND farm_id=$10 RETURNING *`,
    [id, ownerId, d.category, d.person_or_vendor, d.description, d.workers_count,
      d.amount, d.payment_mode, d.expense_date, farmId],
  );
  if (!rows.length) throw new HttpError(404, 'Farm expense not found');
  return rows[0];
}

export async function deleteFarmExpense(ownerId: string, id: string) {
  const rows = await query(
    'DELETE FROM farm_expenses WHERE id=$1 AND owner_id=$2 AND farm_id=$3 RETURNING id',
    [id, ownerId, getActiveFarmId(ownerId)],
  );
  if (!rows.length) throw new HttpError(404, 'Farm expense not found');
}
