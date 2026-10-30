import { query, withTx } from '../config/db';
import { HttpError } from '../utils/httpError';
import { round2 } from '../utils/http';
import { buildInvoicePdf } from './pdf.service';

export const list = (ownerId: number) =>
  query(
    `SELECT i.*, (SELECT COUNT(*) FROM invoice_items it WHERE it.invoice_id=i.id) AS items_count
     FROM invoices i WHERE i.owner_id=$1 ORDER BY i.created_at DESC, i.id DESC`,
    [ownerId]
  );

export const getEggStock = async (ownerId: number, client?: any) => {
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

export async function getOne(ownerId: number, id: number) {
  const inv = await query('SELECT * FROM invoices WHERE id=$1 AND owner_id=$2', [id, ownerId]);
  if (!inv.length) throw new HttpError(404, 'Invoice not found');
  const items = await query('SELECT * FROM invoice_items WHERE invoice_id=$1 AND owner_id=$2 ORDER BY id', [id, ownerId]);
  for (const item of items) item.egg_quantity = eggQuantityForItem(item, inv[0].invoice_type);
  return { ...inv[0], items };
}

export async function create(ownerId: number, d: any) {
  const items = d.items.map((it: any) => ({ ...it, amount: round2(it.quantity * it.unit_price) }));
  const subtotal = round2(items.reduce((s: number, it: any) => s + it.amount, 0));
  const taxAmount = round2((subtotal * d.tax_percent) / 100);
  const grand = round2(subtotal + taxAmount);

  const id = await withTx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock($1::bigint)', [ownerId]);
    const year = new Date().getFullYear();
    const stock = await getEggStock(ownerId, c);
    let eggQuantity = 0;
    if (d.invoice_type === 'egg_sale') {
      for (const item of items) {
        const quantity = eggQuantityForItem(item, d.invoice_type);
        if (quantity == null) throw new HttpError(400, 'Each egg-sale item must include its egg quantity');
        eggQuantity += quantity;
      }
      if (eggQuantity > stock.available_eggs) {
        throw new HttpError(400, `Cannot bill more than available stock (Max available: ${stock.available_eggs})`);
      }
    }
    const seqRow = await c.query('SELECT COALESCE(MAX(invoice_seq),0)+1 AS n FROM invoices WHERE owner_id=$1 AND invoice_year=$2', [ownerId, year]);
    const seq = Number(seqRow.rows[0].n);
    const no = `INV-${year}-${String(seq).padStart(4, '0')}`;
    const ins = await c.query(
      `INSERT INTO invoices (owner_id,invoice_year,invoice_seq,invoice_no,invoice_type,customer_name,customer_mobile,invoice_date,
         subtotal,tax_percent,tax_amount,grand_total,notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [ownerId, year, seq, no, d.invoice_type, d.customer_name, d.customer_mobile, d.invoice_date, subtotal, d.tax_percent, taxAmount, grand, d.notes]
    );
    const invId = Number(ins.rows[0].id);
    for (const it of items) {
      await c.query(
        'INSERT INTO invoice_items (owner_id,invoice_id,description,quantity,unit_price,amount,egg_quantity) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [ownerId, invId, it.description, it.quantity, it.unit_price, it.amount, eggQuantityForItem(it, d.invoice_type)]
      );
    }
    return invId;
  });
  return getOne(ownerId, id);
}

export async function remove(ownerId: number, id: number) {
  await withTx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock($1::bigint)', [ownerId]);
    const r = await c.query('DELETE FROM invoices WHERE id=$1 AND owner_id=$2 RETURNING id', [id, ownerId]);
    if (!r.rows.length) throw new HttpError(404, 'Invoice not found');
  });
}

export async function pdfFor(ownerId: number, id: number) {
  const inv = await getOne(ownerId, id);
  const farm = (await query('SELECT farm_name, owner_name, mobile, address FROM users WHERE id=$1', [ownerId]))[0];
  return { buffer: await buildInvoicePdf(inv, inv.items, farm), invoice: inv };
}

/** Public, unguessable share link (UUID token) used in WhatsApp messages. */
export async function pdfByToken(token: string) {
  if (!/^[0-9a-f-]{36}$/i.test(token)) throw new HttpError(404, 'Invoice not found');
  const r = await query('SELECT id, owner_id FROM invoices WHERE share_token=$1', [token]);
  if (!r.length) throw new HttpError(404, 'Invoice not found');
  return pdfFor(r[0].owner_id, r[0].id);
}
