import { PoolClient } from 'pg';
import { query, withTx } from '../config/db';
import { HttpError } from '../utils/httpError';

export function normalizeCustomerPhone(value: unknown): string {
  let digits = String(value ?? '').replace(/\D/g, '');
  if (digits.length > 10 && digits.startsWith('91')) {
    digits = digits.slice(2);
  }
  if (digits.length === 11 && digits.startsWith('0')) {
    digits = digits.slice(1);
  }
  return digits.length === 10 ? digits : '';
}

export async function findOrCreateCustomer(
  client: PoolClient,
  ownerId: string,
  name: string,
  normalizedPhone: string,
): Promise<string> {
  if (normalizedPhone) {
    const result = await client.query(
      `INSERT INTO customers(owner_id,name,phone,normalized_phone)
       VALUES($1,$2,$3,$3)
       ON CONFLICT (farm_id,normalized_phone) WHERE normalized_phone <> ''
       DO UPDATE SET name=CASE
         WHEN btrim(customers.name)='' THEN EXCLUDED.name
         ELSE customers.name
       END
       RETURNING id`,
      [ownerId, name, normalizedPhone],
    );
    return result.rows[0].id;
  }

  const existing = await client.query(
    `SELECT id FROM customers
     WHERE owner_id=$1
       AND farm_id=NULLIF(current_setting('app.farm_id',true),'')::uuid
       AND lower(trim(name))=lower(trim($2))
     ORDER BY created_at,id
     LIMIT 1
     FOR UPDATE`,
    [ownerId, name],
  );
  if (existing.rows.length) return existing.rows[0].id;

  const created = await client.query(
    `INSERT INTO customers(owner_id,name,phone,normalized_phone)
     VALUES($1,$2,'','') RETURNING id`,
    [ownerId, name],
  );
  return created.rows[0].id;
}

export async function listCustomers(
  ownerId: string,
  search: string,
  limit: number,
  offset: number,
) {
  const cte = `WITH invoice_totals AS (
      SELECT i.owner_id,i.customer_id,SUM(i.grand_total) AS total_billed,
             COALESCE((
               SELECT SUM(it.egg_quantity)
               FROM invoices ei
               JOIN invoice_items it ON it.owner_id=ei.owner_id AND it.invoice_id=ei.id
               WHERE ei.owner_id=i.owner_id AND ei.customer_id=i.customer_id
                 AND ei.invoice_type='egg_sale'
                 AND ei.invoice_date >= CURRENT_DATE - INTERVAL '30 days'
             ),0) AS total_eggs
      FROM invoices i
      WHERE i.owner_id=$1
        AND i.invoice_date >= CURRENT_DATE - INTERVAL '30 days'
      GROUP BY i.owner_id,i.customer_id
    ), payment_totals AS (
      SELECT owner_id,customer_id,SUM(amount_paid) AS total_paid
      FROM customer_payments
      WHERE owner_id=$1
        AND payment_date >= CURRENT_DATE - INTERVAL '30 days'
      GROUP BY owner_id,customer_id
    ), customer_activity AS (
      SELECT c.id,c.name,c.phone,c.normalized_phone,c.farm_id,c.created_at,
             COALESCE(i.total_billed,0) AS total_billed,
             COALESCE(p.total_paid,0) AS total_paid,
             GREATEST(COALESCE(i.total_billed,0)-COALESCE(p.total_paid,0),0) AS pending_balance,
             COALESCE(i.total_eggs,0) AS total_eggs
      FROM customers c
      LEFT JOIN invoice_totals i ON i.owner_id=c.owner_id AND i.customer_id=c.id
      LEFT JOIN payment_totals p ON p.owner_id=c.owner_id AND p.customer_id=c.id
      WHERE c.owner_id=$1
        AND ($2='' OR c.name ILIKE '%' || $2 || '%'
          OR c.phone ILIKE '%' || $2 || '%'
          OR c.normalized_phone ILIKE '%' || $2 || '%')
    )`;
  const params = [ownerId, search.trim()];
  const [data, count] = await Promise.all([
    query(
      `${cte} SELECT * FROM customer_activity
       ORDER BY lower(name),phone LIMIT $3 OFFSET $4`,
      [...params, limit, offset],
    ),
    query(`${cte} SELECT COUNT(*)::int AS total FROM customer_activity`, params),
  ]);
  return { data, total: Number(count[0].total) };
}

export async function customerLedger(
  ownerId: string,
  customerId: string,
  sinceDate: string | null,
  limit: number,
  offset: number,
) {
  const [customers, summary, openInvoices, latestInvoice] = await Promise.all([
    query('SELECT id,name,phone FROM customers WHERE id=$1 AND owner_id=$2', [customerId, ownerId]),
    query(
      `SELECT COALESCE((SELECT SUM(grand_total) FROM invoices
                        WHERE owner_id=$1 AND customer_id=$2),0) AS total_billed,
              COALESCE((SELECT SUM(p.amount_paid) FROM customer_payments p
                        WHERE p.owner_id=$1 AND p.customer_id=$2),0) AS total_paid,
              COALESCE((SELECT SUM(it.egg_quantity)
                        FROM invoices i JOIN invoice_items it
                          ON it.invoice_id=i.id AND it.owner_id=i.owner_id
                        WHERE i.owner_id=$1 AND i.customer_id=$2
                          AND i.invoice_type='egg_sale'),0) AS total_eggs,
              GREATEST(
                COALESCE((SELECT SUM(grand_total) FROM invoices
                          WHERE owner_id=$1 AND customer_id=$2),0) -
                COALESCE((SELECT SUM(amount_paid) FROM customer_payments
                          WHERE owner_id=$1 AND customer_id=$2),0),
                0
              ) AS pending_balance`,
      [ownerId, customerId],
    ),
    query(
      `SELECT id,invoice_no,invoice_date,grand_total,paid_amount,
              grand_total-paid_amount AS balance
       FROM invoices
       WHERE owner_id=$1 AND customer_id=$2 AND paid_amount < grand_total
       ORDER BY invoice_date,id`,
      [ownerId, customerId],
    ),
    query(
      `SELECT id,invoice_no FROM invoices
       WHERE owner_id=$1 AND customer_id=$2
       ORDER BY created_at DESC,id DESC LIMIT 1`,
      [ownerId, customerId],
    ),
  ]);
  if (!customers.length) throw new HttpError(404, 'Customer not found');
  const timeline = `WITH ledger AS (
       SELECT i.id::text AS id,i.invoice_date AS entry_date,'invoice'::text AS entry_type,
              i.id AS invoice_id,i.invoice_no,i.invoice_type,i.grand_total AS billed_amount,
              i.paid_amount,i.created_at,
              COALESCE((SELECT SUM(it.egg_quantity) FROM invoice_items it
                        WHERE it.owner_id=i.owner_id AND it.invoice_id=i.id),0) AS egg_quantity,
              COALESCE((SELECT string_agg(
                          format('%s × %s%s @ %s',it.description,it.quantity,
                            CASE it.sale_unit
                              WHEN 'bag' THEN ' Bags / पोती'
                              WHEN 'tractor_trolley' THEN ' Tractor Trolley / ट्रॉली'
                              WHEN 'ton' THEN ' Ton / टन'
                              ELSE ''
                            END,
                            it.unit_price),
                          ', ' ORDER BY it.id)
                        FROM invoice_items it
                        WHERE it.owner_id=i.owner_id AND it.invoice_id=i.id),'Invoice') AS details,
              NULL::text AS payment_mode,NULL::text AS note,
              COALESCE((
                SELECT SUM(it.amount) / NULLIF(SUM(
                  CASE WHEN i.invoice_type='egg_sale'
                    THEN COALESCE(it.egg_quantity,0)
                    ELSE it.quantity
                  END
                ),0)
                FROM invoice_items it
                WHERE it.owner_id=i.owner_id AND it.invoice_id=i.id
              ),0) AS unit_rate,
              COALESCE((SELECT SUM(it.quantity) FROM invoice_items it
                        WHERE it.owner_id=i.owner_id AND it.invoice_id=i.id),0) AS item_quantity
       FROM invoices i
       WHERE i.owner_id=$1 AND i.customer_id=$2
       UNION ALL
       SELECT p.id::text,p.payment_date,'payment'::text,p.invoice_id,
              NULL::text,NULL::text,0::numeric,p.amount_paid,p.created_at,0::numeric,
              'Payment received'::text,p.payment_mode,p.note,NULL::numeric,0::numeric
       FROM customer_payments p
       WHERE p.owner_id=$1 AND p.customer_id=$2
     )`;
  const [ledger, count] = await Promise.all([
    query(
      `${timeline}
       SELECT * FROM ledger
       WHERE ($3::date IS NULL OR entry_date >= $3::date)
       ORDER BY created_at DESC,id DESC
       LIMIT $4 OFFSET $5`,
      [ownerId, customerId, sinceDate, limit, offset],
    ),
    query(
      `${timeline}
       SELECT COUNT(*)::int AS total FROM ledger
       WHERE ($3::date IS NULL OR entry_date >= $3::date)`,
      [ownerId, customerId, sinceDate],
    ),
  ]);
  return {
    customer: customers[0],
    summary: summary[0],
    entries: ledger,
    open_invoices: openInvoices,
    latest_invoice: latestInvoice[0] ?? null,
    total: Number(count[0].total),
  };
}

export async function receiveCustomerPayment(
  ownerId: string,
  customerId: string,
  d: any,
) {
  return withTx(async (client: PoolClient) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))', [ownerId]);
    const customer = await client.query(
      'SELECT id FROM customers WHERE owner_id=$1 AND id=$2 FOR UPDATE',
      [ownerId, customerId],
    );
    if (!customer.rows.length) throw new HttpError(404, 'Customer not found');

    const invoices = await client.query(
      `SELECT id,grand_total,paid_amount FROM invoices
       WHERE owner_id=$1 AND customer_id=$2
         AND ($3::uuid IS NULL OR id=$3)
         AND paid_amount < grand_total
       ORDER BY invoice_date ASC,created_at ASC,id ASC
       FOR UPDATE`,
      [ownerId, customerId, d.invoice_id ?? null],
    );
    if (d.invoice_id && !invoices.rows.length) {
      const exists = await client.query(
        'SELECT 1 FROM invoices WHERE owner_id=$1 AND customer_id=$2 AND id=$3',
        [ownerId, customerId, d.invoice_id],
      );
      if (!exists.rows.length) throw new HttpError(404, 'Invoice not found for this customer');
      throw new HttpError(400, 'This invoice has no pending balance');
    }

    const totalDue = invoices.rows.reduce(
      (sum, invoice) => sum + Number(invoice.grand_total) - Number(invoice.paid_amount),
      0,
    );
    if (d.amount_paid > totalDue + 0.005) {
      throw new HttpError(400, `Payment exceeds the pending balance (${totalDue.toFixed(2)})`);
    }

    let remaining = Math.round(d.amount_paid * 100);
    const payments = [];
    for (const invoice of invoices.rows) {
      if (remaining <= 0) break;
      const due = Math.round(
        (Number(invoice.grand_total) - Number(invoice.paid_amount)) * 100,
      );
      const appliedCents = Math.min(remaining, due);
      if (appliedCents <= 0) continue;
      const applied = appliedCents / 100;
      const newPaid = Number(invoice.paid_amount) + applied;
      await client.query(
        `UPDATE invoices SET paid_amount=$3::numeric,
          payment_status=CASE WHEN $3::numeric >= grand_total THEN 'paid' ELSE 'unpaid' END,
          paid_at=CASE WHEN $3::numeric >= grand_total THEN COALESCE(paid_at,NOW()) ELSE NULL END
         WHERE owner_id=$1 AND id=$2`,
        [ownerId, invoice.id, newPaid],
      );
      const result = await client.query(
        `INSERT INTO customer_payments
         (owner_id,customer_id,invoice_id,amount_paid,payment_mode,note,payment_date)
         VALUES($1,$2,$3,$4::numeric,$5,$6,$7) RETURNING *`,
        [ownerId, customerId, invoice.id, applied, d.payment_mode, d.note ?? null, d.payment_date],
      );
      payments.push(result.rows[0]);
      remaining -= appliedCents;
    }
    return payments;
  });
}

export async function removeCustomerPayment(
  ownerId: string,
  customerId: string,
  paymentId: string,
) {
  return withTx(async (client: PoolClient) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))', [ownerId]);
    const payment = await client.query(
      `SELECT id,invoice_id FROM customer_payments
       WHERE owner_id=$1 AND customer_id=$2 AND id=$3 FOR UPDATE`,
      [ownerId, customerId, paymentId],
    );
    if (!payment.rows.length) throw new HttpError(404, 'Customer payment not found');

    await client.query(
      'DELETE FROM customer_payments WHERE owner_id=$1 AND customer_id=$2 AND id=$3',
      [ownerId, customerId, paymentId],
    );

    if (payment.rows[0].invoice_id) {
      await client.query(
        `UPDATE invoices i SET
           paid_amount=LEAST(COALESCE(p.total_paid,0),i.grand_total),
           payment_status=CASE WHEN COALESCE(p.total_paid,0)>=i.grand_total
                               THEN 'paid' ELSE 'unpaid' END,
           paid_at=CASE WHEN COALESCE(p.total_paid,0)>=i.grand_total
                        THEN COALESCE(i.paid_at,NOW()) ELSE NULL END
         FROM (
           SELECT COALESCE(SUM(amount_paid),0) AS total_paid
           FROM customer_payments
           WHERE owner_id=$1 AND customer_id=$2 AND invoice_id=$3
         ) p
         WHERE i.owner_id=$1 AND i.customer_id=$2 AND i.id=$3`,
        [ownerId, customerId, payment.rows[0].invoice_id],
      );
    }

    await client.query(
      `DELETE FROM customers c
       WHERE c.owner_id=$1 AND c.id=$2
         AND NOT EXISTS (
           SELECT 1 FROM invoices i
           WHERE i.owner_id=c.owner_id AND i.customer_id=c.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM customer_payments p
           WHERE p.owner_id=c.owner_id AND p.customer_id=c.id
         )`,
      [ownerId, customerId],
    );

    return { deleted: true };
  });
}
