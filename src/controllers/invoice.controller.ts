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
        unit_price: z.coerce.number().min(0).refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-8, 'Use at most 2 decimal places'),
        egg_unit: z.enum(['eggs', 'crate', 'tray']).nullable().optional(),
        egg_quantity: z.coerce.number().int().positive().nullable().optional(),
      })
    )
    .min(1, 'Add at least one line item'),
}).superRefine((invoice, context) => {
  invoice.items.forEach((item, index) => {
    if (invoice.invoice_type === 'egg_sale') {
      if (!item.egg_unit) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['items', index, 'egg_unit'],
          message: 'Choose an egg billing unit',
        });
      } else if (item.quantity !== Math.floor(item.quantity)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['items', index, 'quantity'],
          message: 'Egg and crate quantities must be whole numbers',
        });
      }
      if (item.egg_quantity == null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['items', index, 'egg_quantity'],
          message: 'Egg quantity is required for egg sales',
        });
      }
    } else if (item.egg_unit != null || item.egg_quantity != null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['items', index, 'egg_unit'],
        message: 'Egg billing fields are only valid for egg-sale invoices',
      });
    }
  });
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
