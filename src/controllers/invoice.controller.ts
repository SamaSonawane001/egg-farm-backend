import { Response } from 'express';
import { z } from 'zod';
import { asyncHandler, dateStr, idParam, ok, okPaginated, optText } from '../utils/http';
import { parsePagination, paginationMetadata } from '../utils/pagination';
import * as svc from '../services/invoice.service';

const body = z.object({
  invoice_type: z.enum(['egg_sale', 'spent_hen_sale', 'feed_trade']),
  customer_name: z.string().trim().min(1).max(160),
  customer_mobile: z.string().regex(
    /^[6-9]\d{9}$/,
    'Please enter a valid 10-digit mobile number'
  ),
  invoice_date: dateStr,
  payment_status: z.enum(['paid', 'unpaid']).default('unpaid'),
  tax_percent: z.coerce.number().min(0).max(100).default(0),
  notes: optText,
  items: z
    .array(
      z.object({
        description: z.string().trim().min(1).max(255),
        quantity: z.coerce.number().positive(),
        unit_price: z.coerce.number().min(0).refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-8, 'Use at most 2 decimal places'),
        egg_unit: z.enum(['eggs', 'tray']).nullable().optional(),
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
function pdfFileName(farmName: string | null, customerName: string | null) {
  const safePart = (value: string | null, fallback: string) =>
    value?.trim().replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') ||
    fallback;
  return `${safePart(farmName, 'Farm')}_${safePart(customerName, 'Customer')}_Invoice.pdf`;
}

function sendPdf(res: Response, buffer: Buffer, fileName: string) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
  res.send(buffer);
}

export const list = asyncHandler(async (req, res) => {
  const { page, limit, offset } = parsePagination({
    ...req.query,
    limit: req.query.limit ?? 10,
  });
  const result = await svc.list(req.ownerId, limit, offset);
  okPaginated(res, result.data, paginationMetadata(result.total, page, limit, offset));
});
export const paymentSummary = asyncHandler(async (req, res) =>
  ok(res, await svc.paymentSummary(req.ownerId)));
export const updatePaymentStatus = asyncHandler(async (req, res) => {
  const body = z.object({ payment_status: z.enum(['paid', 'unpaid']) }).parse(req.body);
  ok(res, await svc.updatePaymentStatus(
    req.ownerId,
    idParam(req.params.id),
    body.payment_status,
  ));
});
export const getOne = asyncHandler(async (req, res) => ok(res, await svc.getOne(req.ownerId, idParam(req.params.id))));
export const create = asyncHandler(async (req, res) => ok(res, await svc.create(req.ownerId, body.parse(req.body)), 201));
export const remove = asyncHandler(async (req, res) => {
  await svc.remove(req.ownerId, idParam(req.params.id));
  ok(res, { deleted: true });
});
export const pdf = asyncHandler(async (req, res) => {
  const { buffer, invoice, farm } = await svc.pdfFor(req.ownerId, idParam(req.params.id));
  sendPdf(res, buffer, pdfFileName(farm.farm_name, invoice.customer_name));
});
export const publicPdf = asyncHandler(async (req, res) => {
  const { buffer, invoice, farm } = await svc.pdfByPublicIdOrToken(req.params.id);
  sendPdf(res, buffer, pdfFileName(farm.farm_name, invoice.customer_name));
});
