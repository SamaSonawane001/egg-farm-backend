import { INVOICE_TYPE_LABEL, InvoiceType } from '../models/types';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const PdfPrinter = require('pdfmake');

// Built-in PDF fonts: no font files required. (They have no ₹ glyph, so "Rs." is used.)
const printer = new PdfPrinter({
  Helvetica: { normal: 'Helvetica', bold: 'Helvetica-Bold', italics: 'Helvetica-Oblique', bolditalics: 'Helvetica-BoldOblique' },
});

const rs = (n: number) => 'Rs. ' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const quantity = (n: number) => Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const eggItemDescription = (item: any) => {
  const eggs = Number(item.egg_quantity);
  const unit = item.egg_unit;
  const label = unit === 'crate' ? 'Crates' : unit === 'tray' ? 'Trays' : null;
  const billedQuantity = label
    ? `${quantity(Number(item.quantity))} ${label} (${quantity(eggs)} eggs)`
    : `${quantity(eggs)} Eggs`;
  return `${billedQuantity} @ ${rs(Number(item.unit_price))} / egg = ${rs(Number(item.amount))}`;
};
const GREEN = '#047857';
const GREY = '#78716C';

export function buildInvoicePdf(inv: any, items: any[], farm: any): Promise<Buffer> {
  const def: any = {
    defaultStyle: { font: 'Helvetica', fontSize: 10, color: '#1C1917' },
    pageSize: 'A4',
    pageMargins: [40, 40, 40, 50],
    content: [
      {
        columns: [
          [
            { text: farm.farm_name, fontSize: 18, bold: true, color: GREEN },
            { text: farm.owner_name, margin: [0, 2, 0, 0] },
            { text: `Mobile: ${farm.mobile}`, color: GREY },
            ...(farm.address ? [{ text: farm.address, color: GREY }] : []),
          ],
          [
            { text: 'INVOICE', fontSize: 22, bold: true, alignment: 'right' },
            { text: inv.invoice_no, alignment: 'right', color: GREY },
            { text: `Date: ${inv.invoice_date}`, alignment: 'right', color: GREY },
            { text: INVOICE_TYPE_LABEL[inv.invoice_type as InvoiceType] || inv.invoice_type, alignment: 'right', bold: true, color: GREEN },
          ],
        ],
      },
      { canvas: [{ type: 'line', x1: 0, y1: 8, x2: 515, y2: 8, lineWidth: 1, lineColor: '#E7E5E4' }] },
      { text: 'BILL TO', color: GREY, fontSize: 8, bold: true, margin: [0, 14, 0, 2] },
      { text: inv.customer_name, bold: true, fontSize: 12 },
      ...(inv.customer_mobile ? [{ text: inv.customer_mobile, color: GREY }] : []),
      {
        margin: [0, 18, 0, 0],
        table: {
          headerRows: 1,
          widths: ['*', 60, 80, 90],
          body: [
            ['Description', 'Qty', 'Rate', 'Amount'].map((t, i) => ({
              text: t, bold: true, color: '#FFFFFF', fillColor: GREEN, alignment: i === 0 ? 'left' : 'right', margin: [4, 4, 4, 4],
            })),
            ...items.map((it) => [
              { text: inv.invoice_type === 'egg_sale' && it.egg_unit
                ? eggItemDescription(it)
                : it.description, margin: [4, 3, 4, 3] },
              { text: String(it.quantity), alignment: 'right', margin: [4, 3, 4, 3] },
              { text: inv.invoice_type === 'egg_sale' && it.egg_unit
                ? `${rs(it.unit_price)} / egg`
                : rs(it.unit_price), alignment: 'right', margin: [4, 3, 4, 3] },
              { text: rs(it.amount), alignment: 'right', margin: [4, 3, 4, 3] },
            ]),
          ],
        },
        layout: { hLineColor: () => '#E7E5E4', vLineWidth: () => 0, hLineWidth: () => 0.5 },
      },
      {
        margin: [0, 14, 0, 0],
        alignment: 'right',
        stack: [
          { text: `Subtotal: ${rs(inv.subtotal)}` },
          ...(inv.tax_percent > 0 ? [{ text: `Tax (${inv.tax_percent}%): ${rs(inv.tax_amount)}`, margin: [0, 2, 0, 0] }] : []),
          { text: `Grand Total: ${rs(inv.grand_total)}`, bold: true, fontSize: 14, color: GREEN, margin: [0, 6, 0, 0] },
        ],
      },
      ...(inv.notes ? [{ text: `Notes: ${inv.notes}`, color: GREY, margin: [0, 20, 0, 0] }] : []),
    ],
    footer: { text: 'Thank you for your business!', alignment: 'center', color: GREY, fontSize: 9 },
  };

  const doc = printer.createPdfKitDocument(def);
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}
