import { INVOICE_TYPE_LABEL, InvoiceType } from '../models/types';
import { env } from '../config/env';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const PdfPrinter = require('pdfmake');

// Built-in PDF fonts: no font files required. (They have no ₹ glyph, so "Rs." is used.)
const printer = new PdfPrinter({
  Helvetica: { normal: 'Helvetica', bold: 'Helvetica-Bold', italics: 'Helvetica-Oblique', bolditalics: 'Helvetica-BoldOblique' },
});

const rs = (n: number) => 'Rs. ' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const quantity = (n: number) => Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const eggItemCalculation = (item: any) => {
  const eggs = Number(item.egg_quantity);
  const unit = item.egg_unit;
  const label = unit === 'crate' ? 'Crates' : unit === 'tray' ? 'Trays' : null;
  const billedQuantity = label
    ? `${quantity(Number(item.quantity))} ${label} (${quantity(eggs)} eggs)`
    : `${quantity(eggs)} Eggs`;
  return `${billedQuantity} @ ${rs(Number(item.unit_price))} / egg`;
};
const GREEN = '#047857';
const GREY = '#78716C';
const MAX_LOGO_BYTES = 3 * 1024 * 1024;

function resolveFarmLogoUrl(logoUrl: string | null | undefined, ownerId: string): URL | null {
  if (!logoUrl) return null;

  try {
    const url = logoUrl.startsWith('/uploads/')
      ? new URL(logoUrl, env.publicUrl)
      : new URL(logoUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      return null;
    }

    if (env.supabaseUrl) {
      const supabase = new URL(env.supabaseUrl);
      const avatarBuckets = new Set([env.supabaseStorageBucket, 'farm-profiles']);
      for (const bucketName of avatarBuckets) {
        const avatarPrefix = `${supabase.pathname.replace(/\/$/, '')}/storage/v1/object/public/${bucketName}/avatars/${ownerId}/`;
        if (
          url.origin === supabase.origin &&
          url.pathname.startsWith(avatarPrefix) &&
          /^profile_photo_\d+(?:_[a-f0-9]{8})?\.(?:jpg|png|webp)$/i.test(url.pathname.slice(avatarPrefix.length))
        ) {
          return url;
        }
      }
    }

    const publicOrigin = new URL(env.publicUrl).origin;
    if (
      url.origin === publicOrigin &&
      /^\/uploads\/[A-Za-z0-9_.-]+\.(?:jpe?g|png)$/i.test(url.pathname)
    ) {
      return url;
    }
  } catch {
    return null;
  }
  return null;
}

async function loadFarmLogo(logoUrl: string | null | undefined, ownerId: string): Promise<string | null> {
  const url = resolveFarmLogoUrl(logoUrl, ownerId);
  if (!url) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'error' });
    if (!response.ok) return null;

    const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
    if (contentType !== 'image/png' && contentType !== 'image/jpeg') return null;
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_LOGO_BYTES) return null;

    const reader = response.body?.getReader();
    if (!reader) return null;
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_LOGO_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(Buffer.from(value));
    }

    const image = Buffer.concat(chunks, totalBytes);
    const isPng = contentType === 'image/png'
      && image.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const isJpeg = contentType === 'image/jpeg'
      && image.length >= 3
      && image.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
    if (!isPng && !isJpeg) return null;

    return `data:${contentType};base64,${image.toString('base64')}`;
  } catch (error) {
    console.warn('Failed to load farm logo for invoice PDF:', error);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function buildInvoicePdf(inv: any, items: any[], farm: any, ownerId: string): Promise<Buffer> {
  const logo = await loadFarmLogo(farm.avatar_url, ownerId);
  const def: any = {
    defaultStyle: { font: 'Helvetica', fontSize: 10, color: '#1C1917' },
    pageSize: 'A4',
    pageMargins: [40, 40, 40, 50],
    ...(logo ? { images: { farmLogo: logo } } : {}),
    content: [
      {
        margin: [0, 0, 0, 12],
        columns: [
          {
            width: '*',
            margin: [0, 8, 0, 0],
            stack: [
              { text: farm.farm_name, fontSize: 19, bold: true, color: GREEN },
              { text: farm.owner_name, fontSize: 10, color: GREY, margin: [0, 3, 0, 0] },
              { text: `Mobile: ${farm.mobile}`, fontSize: 10, color: GREY, margin: [0, 3, 0, 0] },
              ...(farm.address ? [{ text: farm.address, fontSize: 10, color: GREY, margin: [0, 3, 0, 0] }] : []),
            ],
          },
          {
            width: 85,
            ...(logo
              ? { image: 'farmLogo', fit: [82, 82] }
              : { text: '' }),
            alignment: 'center',
          },
          {
            width: '*',
            margin: [0, 8, 0, 0],
            stack: [
              { text: 'INVOICE', fontSize: 22, bold: true, alignment: 'right' },
              { text: inv.invoice_no, fontSize: 10, alignment: 'right', color: GREY, margin: [0, 3, 0, 0] },
              { text: `Date: ${inv.invoice_date}`, fontSize: 10, alignment: 'right', color: GREY, margin: [0, 3, 0, 0] },
              { text: INVOICE_TYPE_LABEL[inv.invoice_type as InvoiceType] || inv.invoice_type, fontSize: 11, alignment: 'right', bold: true, color: GREEN, margin: [0, 3, 0, 0] },
            ],
          },
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
              inv.invoice_type === 'egg_sale' && it.egg_unit
                ? {
                    stack: [
                      {
                        text: String(it.description ?? '').trim() || 'Eggs',
                        bold: true,
                        fontSize: 10,
                        color: '#000000',
                      },
                      {
                        text: eggItemCalculation(it),
                        fontSize: 8,
                        color: '#78716C',
                        margin: [0, 2, 0, 0],
                      },
                    ],
                    margin: [4, 3, 4, 3],
                  }
                : { text: it.description, margin: [4, 3, 4, 3] },
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
