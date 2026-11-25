import { pool, query, withTx } from '../config/db';
import { runWithFarmContext } from '../config/farmContext';
import { HttpError } from '../utils/httpError';
import { round2 } from '../utils/http';
import { buildInvoicePdf } from './pdf.service';
import {
  findOrCreateCustomer,
  normalizeCustomerPhone,
} from './customer.service';
import { assertCanCreateInvoice } from './subscription.service';

export const list = async (ownerId: string, limit = 10, offset = 0) => {
  const [data, count] = await Promise.all([
    query(
      `SELECT i.*,
            COALESCE(to_jsonb(i)->>'payment_status','unpaid') AS payment_status,
            to_jsonb(i)->>'paid_at' AS paid_at,
            (SELECT COUNT(*) FROM invoice_items it WHERE it.invoice_id=i.id) AS items_count,
            COALESCE((SELECT json_agg(json_build_object(
              'description',it.description,'quantity',it.quantity,'unit_price',it.unit_price,
              'amount',it.amount,'egg_quantity',it.egg_quantity,'egg_unit',it.egg_unit,
              'sale_unit',it.sale_unit
            ) ORDER BY it.id) FROM invoice_items it
              WHERE it.invoice_id=i.id AND it.owner_id=i.owner_id),'[]'::json) AS items
     FROM invoices i WHERE i.owner_id=$1 ORDER BY i.created_at DESC, i.id DESC
     LIMIT $2 OFFSET $3`,
      [ownerId, limit, offset]
    ),
    query('SELECT COUNT(*)::int AS total FROM invoices WHERE owner_id=$1', [ownerId]),
  ]);
  return { data, total: Number(count[0].total) };
};

export const paymentSummary = async (ownerId: string) => {
  const rows = await query(
    `WITH customer_balances AS (
       SELECT c.id,
         GREATEST(COALESCE(SUM(i.grand_total),0) -
           COALESCE((SELECT SUM(p.amount_paid) FROM customer_payments p
                     WHERE p.owner_id=c.owner_id AND p.customer_id=c.id),0),0) AS balance
       FROM customers c
       LEFT JOIN invoices i ON i.owner_id=c.owner_id AND i.customer_id=c.id
       WHERE c.owner_id=$1
       GROUP BY c.id
     ),
     unlinked AS (
       SELECT GREATEST(i.grand_total-i.paid_amount,0) AS balance
       FROM invoices i WHERE i.owner_id=$1 AND i.customer_id IS NULL
     )
     SELECT COALESCE((SELECT SUM(balance) FROM customer_balances),0)
              + COALESCE((SELECT SUM(balance) FROM unlinked),0) AS pending_amount,
            (SELECT COUNT(*) FROM invoices i WHERE i.owner_id=$1
              AND i.paid_amount < i.grand_total)::int AS pending_count`,
    [ownerId],
  );
  return {
    pending_amount: Number(rows[0].pending_amount),
    pending_count: Number(rows[0].pending_count),
  };
};

export const getEggStock = async (ownerId: string, client?: any) => {
  const sql = `SELECT COALESCE((SELECT SUM(net_eggs) FROM egg_production WHERE owner_id=$1),0) AS produced,
                      COALESCE((SELECT SUM(COALESCE(egg_quantity,0)) FROM invoice_items WHERE owner_id=$1),0) AS sold`;
  const row = client ? (await client.query(sql, [ownerId])).rows[0] : (await query(sql, [ownerId]))[0];
  const produced = Number(row.produced);
  const sold = Number(row.sold);
  const rawAvailable = produced - sold;
  return {
    produced,
    sold,
    available_eggs: Math.max(0, rawAvailable),
    over_billed_eggs: Math.max(0, -rawAvailable),
  };
};

const eggQuantityForItem = (item: any, invoiceType: string) =>
  invoiceType === 'egg_sale' && item.egg_quantity != null ? Number(item.egg_quantity) : null;

export async function getOne(ownerId: string, id: string) {
  const inv = await query('SELECT * FROM invoices WHERE id=$1 AND owner_id=$2', [id, ownerId]);
  if (!inv.length) throw new HttpError(404, 'Invoice not found');
  const items = await query('SELECT * FROM invoice_items WHERE invoice_id=$1 AND owner_id=$2 ORDER BY id', [id, ownerId]);
  for (const item of items) item.egg_quantity = eggQuantityForItem(item, inv[0].invoice_type);
  return { ...inv[0], items };
}

export async function create(ownerId: string, d: any) {
  const items = d.items.map((it: any) => {
    let eggQuantity = null;
    let amount: number;
    if (d.invoice_type === 'egg_sale') {
      if (it.sale_unit != null) {
        throw new HttpError(400, 'Sale units are only valid for poultry-manure invoices');
      }
      if (!['eggs', 'tray'].includes(it.egg_unit)) {
        throw new HttpError(400, 'Each egg-sale item must include a valid egg billing unit');
      }
      if (!Number.isSafeInteger(Number(it.quantity)) || Number(it.quantity) <= 0) {
        throw new HttpError(400, 'Egg and tray quantities must be whole numbers');
      }
      const eggsPerUnit = it.egg_unit === 'eggs' ? 1 : 30;
      const expectedEggQuantity = Number(it.quantity) * eggsPerUnit;
      if (!Number.isSafeInteger(expectedEggQuantity) || expectedEggQuantity > 2147483647) {
        throw new HttpError(400, 'Egg quantity is too large');
      }
      if (Number(it.egg_quantity) !== expectedEggQuantity) {
        throw new HttpError(400, 'Egg quantity must match the selected billing unit');
      }
      eggQuantity = expectedEggQuantity;
      amount = round2(eggQuantity * Number(it.unit_price));
    } else {
      if (it.egg_unit != null || it.egg_quantity != null) {
        throw new HttpError(400, 'Egg billing fields are only valid for egg-sale invoices');
      }
      if (
        d.invoice_type === 'poultry_manure_sale' &&
        !['bag', 'tractor_trolley', 'ton'].includes(it.sale_unit)
      ) {
        throw new HttpError(400, 'Each poultry-manure item must include a valid sale unit');
      }
      if (d.invoice_type !== 'poultry_manure_sale' && it.sale_unit != null) {
        throw new HttpError(400, 'Sale units are only valid for poultry-manure invoices');
      }
      amount = round2(Number(it.quantity) * Number(it.unit_price));
    }
    return { ...it, egg_quantity: eggQuantity, amount };
  });
  const subtotal = round2(items.reduce((s: number, it: any) => s + it.amount, 0));
  const taxAmount = round2((subtotal * d.tax_percent) / 100);
  const grand = round2(subtotal + taxAmount);

  const id = await withTx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))', [ownerId]);
    await assertCanCreateInvoice(c, ownerId);
    const year = new Date().getFullYear();
    const stock = await getEggStock(ownerId, c);
    let totalEggQuantity = 0;
    if (d.invoice_type === 'egg_sale') {
      for (const item of items) {
        const quantity = eggQuantityForItem(item, d.invoice_type);
        if (quantity == null) throw new HttpError(400, 'Each egg-sale item must include its egg quantity');
        totalEggQuantity += quantity;
      }
      if (totalEggQuantity > stock.available_eggs) {
        throw new HttpError(400, `Cannot bill more than available stock (Max available: ${stock.available_eggs})`);
      }
    }
    const rawPhone = String(d.customer_mobile ?? '').trim();
    const phone = normalizeCustomerPhone(rawPhone);
    if (rawPhone && !phone) {
      throw new HttpError(400, 'Customer mobile must contain a valid 10-digit number');
    }
    const customerId = await findOrCreateCustomer(
      c,
      ownerId,
      d.customer_name.trim(),
      phone,
    );
    const seqRow = await c.query('SELECT COALESCE(MAX(invoice_seq),0)+1 AS n FROM invoices WHERE owner_id=$1 AND invoice_year=$2', [ownerId, year]);
    const seq = Number(seqRow.rows[0].n);
    const no = `INV-${year}-${String(seq).padStart(4, '0')}`;
    const ins = await c.query(
      `INSERT INTO invoices (owner_id,customer_id,invoice_year,invoice_seq,invoice_no,invoice_type,customer_name,customer_mobile,invoice_date,
         subtotal,tax_percent,tax_amount,grand_total,notes,payment_status,paid_at,paid_amount)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::numeric,$14,$15,
           CASE WHEN $15='paid' THEN NOW() ELSE NULL END,
           CASE WHEN $15='paid' THEN $13::numeric ELSE 0::numeric END) RETURNING id`,
      [ownerId, customerId, year, seq, no, d.invoice_type, d.customer_name, phone || null, d.invoice_date, subtotal, d.tax_percent, taxAmount, grand, d.notes, d.payment_status]
    );
    const invId = ins.rows[0].id;
    for (const it of items) {
      await c.query(
        'INSERT INTO invoice_items (owner_id,invoice_id,description,quantity,unit_price,amount,egg_quantity,egg_unit,sale_unit) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [ownerId, invId, it.description, it.quantity, it.unit_price, it.amount,
          eggQuantityForItem(it, d.invoice_type), d.invoice_type === 'egg_sale' ? it.egg_unit : null,
          d.invoice_type === 'poultry_manure_sale' ? it.sale_unit : null]
      );
    }
    if (d.payment_status === 'paid' && grand > 0) {
      await c.query(
        `INSERT INTO customer_payments
         (owner_id,customer_id,invoice_id,amount_paid,payment_mode,note,payment_date)
         VALUES($1,$2,$3,$4,'Cash','Invoice paid at creation',$5)`,
        [ownerId, customerId, invId, grand, d.invoice_date],
      );
    }
    return invId;
  });
  return getOne(ownerId, id);
}

export async function updatePaymentStatus(
  ownerId: string,
  id: string,
  paymentStatus: 'paid' | 'unpaid',
) {
  return withTx(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))', [ownerId]);
    const invoices = await client.query(
      'SELECT id,customer_id,grand_total,paid_amount FROM invoices WHERE id=$1 AND owner_id=$2 FOR UPDATE',
      [id, ownerId],
    );
    if (!invoices.rows.length) throw new HttpError(404, 'Invoice not found');
    const invoice = invoices.rows[0];

    if (paymentStatus === 'paid') {
      const due = Math.max(0, Number(invoice.grand_total) - Number(invoice.paid_amount));
      if (due > 0 && invoice.customer_id) {
        await client.query(
          `INSERT INTO customer_payments
           (owner_id,customer_id,invoice_id,amount_paid,payment_mode,note,payment_date)
           VALUES($1,$2,$3,$4,'Cash','Marked Paid from Bills',CURRENT_DATE)`,
          [ownerId, invoice.customer_id, id, due],
        );
      }
      const updated = await client.query(
        `UPDATE invoices SET payment_status='paid',paid_at=COALESCE(paid_at,NOW()),
           paid_amount=grand_total WHERE id=$1 AND owner_id=$2
         RETURNING id,payment_status,paid_at,paid_amount`,
        [id, ownerId],
      );
      return updated.rows[0];
    }

    await client.query(
      'DELETE FROM customer_payments WHERE owner_id=$1 AND invoice_id=$2',
      [ownerId, id],
    );
    const updated = await client.query(
      `UPDATE invoices SET payment_status='unpaid',paid_at=NULL,
         paid_amount=0::numeric WHERE id=$1 AND owner_id=$2
       RETURNING id,payment_status,paid_at,paid_amount`,
      [id, ownerId],
    );
    return updated.rows[0];
  });
}

export async function remove(ownerId: string, id: string) {
  await withTx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))', [ownerId]);
    const invoices = await c.query(
      'SELECT customer_id,grand_total FROM invoices WHERE id=$1 AND owner_id=$2 FOR UPDATE',
      [id, ownerId],
    );
    if (!invoices.rows.length) throw new HttpError(404, 'Invoice not found');
    const invoice = invoices.rows[0];

    await c.query(
      'DELETE FROM customer_payments WHERE owner_id=$1 AND invoice_id=$2',
      [ownerId, id],
    );

    await c.query('DELETE FROM invoices WHERE id=$1 AND owner_id=$2', [id, ownerId]);
    if (invoice.customer_id) {
      await c.query(
        `DELETE FROM customer_payments p
         WHERE p.owner_id=$1 AND p.customer_id=$2 AND p.invoice_id IS NULL
           AND p.note='Opening balance: previously marked paid'
           AND NOT EXISTS (
             SELECT 1 FROM invoices i
             WHERE i.owner_id=p.owner_id AND i.customer_id=p.customer_id
           )`,
        [ownerId, invoice.customer_id],
      );
    }

    if (invoice.customer_id) {
      await c.query(
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
        [ownerId, invoice.customer_id],
      );
    }
  });
}

export async function pdfFor(ownerId: string, id: string) {
  const inv = await getOne(ownerId, id);
  const farm = (await query(
    `SELECT f.name AS farm_name,u.owner_name,u.mobile,f.address,
            f.avatar_url AS logo_url,
            f.signature_url,f.payment_qr_url
     FROM farms f JOIN users u ON u.id=f.owner_user_id
     WHERE f.owner_user_id=$1 AND (f.is_primary=TRUE OR f.id=$2)
     ORDER BY f.is_primary DESC
     LIMIT 1`,
    [ownerId, inv.farm_id],
  ))[0];
  return {
    buffer: await buildInvoicePdf(inv, inv.items, farm, ownerId),
    invoice: inv,
    farm,
  };
}

/** Public invoice links accept the invoice UUID and retain compatibility with older share tokens. */
export async function pdfByPublicIdOrToken(idOrToken: string) {
  if (!/^[0-9a-f-]{36}$/i.test(idOrToken)) throw new HttpError(404, 'Invoice not found');
  const client = await pool.connect();
  let invoice: { id: string; owner_id: string; farm_id: string } | undefined;
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE egg_farm_runtime');
    await client.query(
      "SELECT set_config('app.public_invoice_id',$1,true)",
      [idOrToken],
    );
    const result = await client.query<{ id: string; owner_id: string; farm_id: string }>(
      `SELECT id,owner_id,farm_id FROM invoices
       WHERE id=$1::uuid OR share_token=$1::uuid LIMIT 1`,
      [idOrToken],
    );
    invoice = result.rows[0];
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  if (!invoice) throw new HttpError(404, 'Invoice not found');
  return runWithFarmContext(
    { ownerId: invoice.owner_id, farmId: invoice.farm_id, farmIds: [invoice.farm_id] },
    () => pdfFor(invoice.owner_id, invoice.id),
  );
}
