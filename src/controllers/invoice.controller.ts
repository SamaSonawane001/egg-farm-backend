import { Response } from 'express';
import { z } from 'zod';
import { asyncHandler, dateStr, idParam, ok, optText } from '../utils/http';
import * as svc from '../services/invoice.service';

const body = z.object({
  invoice_type: z.enum(['egg_sale', 'spent_hen_sale', 'feed_trade']),
  customer_name: z.string().trim().min(1).max(160),
  customer_mobile: optText,
  invoice_date: dateStr,
  tax_percent: z.coerce.number().min(0).max(100).default(0),
  notes: optText,
  items: z
    .array(
      z.object({
        description: z.string().trim().min(1).max(255),
        quantity: z.coerce.number().positive(),
        unit_price: z.coerce.number().min(0),
        egg_quantity: z.coerce.number().int().positive().nullable().optional(),
      })
    )
    .min(1, 'Add at least one line item'),
});

function sendPdf(res: Response, buffer: Buffer, invoiceNo: string) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${invoiceNo}.pdf"`);
  res.send(buffer);
}

export const list = asyncHandler(async (req, res) => ok(res, await svc.list(req.ownerId)));
export const getOne = asyncHandler(async (req, res) => ok(res, await svc.getOne(req.ownerId, idParam(req.params.id))));
export const create = asyncHandler(async (req, res) => ok(res, await svc.create(req.ownerId, body.parse(req.body)), 201));
export const remove = asyncHandler(async (req, res) => {
  await svc.remove(req.ownerId, idParam(req.params.id));
  ok(res, { deleted: true });
});
export const pdf = asyncHandler(async (req, res) => {
  const { buffer, invoice } = await svc.pdfFor(req.ownerId, idParam(req.params.id));
  sendPdf(res, buffer, invoice.invoice_no);
});
export const publicPdf = asyncHandler(async (req, res) => {
  const { buffer, invoice } = await svc.pdfByToken(req.params.token);
  sendPdf(res, buffer, invoice.invoice_no);
});
