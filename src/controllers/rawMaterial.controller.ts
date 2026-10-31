import { z } from 'zod';
import { asyncHandler, dateStr, idParam, ok, optText } from '../utils/http';
import { HttpError } from '../utils/httpError';
import * as svc from '../services/rawMaterial.service';
import { assertTenantBillUrl } from '../services/storage.service';

const calendarDate = dateStr.refine((v) => {
  const parsed = new Date(`${v}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === v;
}, 'Date must be a valid calendar date');
const quantity3 = z.coerce.number().positive().refine((n) => Math.abs(n * 1000 - Math.round(n * 1000)) < 1e-8, 'Use at most 3 decimal places');
const amount2 = z.coerce.number().min(0).refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-8, 'Use at most 2 decimal places');
const nonnegative3 = z.coerce.number().min(0).refine((n) => Math.abs(n * 1000 - Math.round(n * 1000)) < 1e-8, 'Use at most 3 decimal places');
const materialBody = z.object({
  name: z.string().trim().min(1).max(120),
  unit: z.string().trim().min(1).max(30),
  min_alert_threshold: z.coerce.number().min(0).refine((n) => Math.abs(n * 1000 - Math.round(n * 1000)) < 1e-8, 'Use at most 3 decimal places'),
});
const inwardBody = z.object({
  material_id: z.coerce.number().int().positive().optional(),
  material_name: z.string().trim().min(1).max(120).optional(),
  quantity: quantity3,
  unit: z.string().trim().min(1).max(30),
  date: calendarDate,
  supplier: z.preprocess((v) => (v === '' || v === undefined ? null : v), z.string().trim().max(160).nullable()),
  vendor_name: z.preprocess((v) => (v === '' || v === undefined ? null : v), z.string().trim().max(150).nullable()),
  rate_per_unit: nonnegative3,
  total_amount: amount2,
  remarks: optText,
  bill_image_url: z.preprocess((v) => (v === '' || v === undefined ? null : v), z.string().url().max(2048).nullable()),
  bill_number: z.preprocess((v) => (v === '' || v === undefined ? null : v), z.string().trim().max(100).nullable()),
}).superRefine((body, context) => {
  if (!body.material_id && !body.material_name) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['material_name'], message: 'Material name is required' });
  }
});
const processingBody = z.object({
  date: calendarDate,
  feed_product_id: z.coerce.number().int().positive().optional(),
  feed_product_name: z.string().trim().min(1).max(120).optional(),
  output_quantity: z.coerce.number().positive().refine((n) => Math.abs(n * 1000 - Math.round(n * 1000)) < 1e-8, 'Use at most 3 decimal places').optional(),
  output_unit: z.enum(['bags', 'kg']).optional(),
  quantity_bags: z.coerce.number().positive().refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-8, 'Use at most 2 decimal places').optional(),
  materials: z.array(z.object({
    material_id: z.coerce.number().int().positive(),
    quantity: quantity3,
  })).min(1),
  remarks: optText,
}).superRefine((body, context) => {
  if (!body.feed_product_id && !body.feed_product_name) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['feed_product_name'], message: 'Finished feed name is required' });
  }
  if (body.output_quantity !== undefined && !body.output_unit) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['output_unit'], message: 'Output unit is required' });
  }
  if (body.output_quantity === undefined && body.quantity_bags === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['output_quantity'], message: 'Produced quantity is required' });
  }
});
const dateFilters = z.object({
  from: z.preprocess((v) => (v === '' ? undefined : v), calendarDate.optional()),
  to: z.preprocess((v) => (v === '' ? undefined : v), calendarDate.optional()),
});
function getDateFilters(req: any) {
  const { from, to } = dateFilters.parse({ from: req.query.from, to: req.query.to });
  if (from && to && from > to) throw new HttpError(400, 'from must be on or before to');
  return { from, to };
}

export const list = asyncHandler(async (req, res) => ok(res, await svc.listMaterials(req.ownerId)));
export const create = asyncHandler(async (req, res) => {
  const result = await svc.createMaterial(req.ownerId, materialBody.parse(req.body));
  ok(res, result, result.duplicate ? 200 : 201);
});
export const update = asyncHandler(async (req, res) =>
  ok(res, await svc.updateMaterial(req.ownerId, idParam(req.params.id), materialBody.parse(req.body))));
export const remove = asyncHandler(async (req, res) => {
  await svc.deleteMaterial(req.ownerId, idParam(req.params.id));
  ok(res, { deleted: true });
});
export const inward = asyncHandler(async (req, res) => {
  const body = inwardBody.parse(req.body);
  assertTenantBillUrl(req.ownerId, 'raw_materials', body.bill_image_url);
  ok(res, await svc.receiveMaterial(req.ownerId, body), 201);
});
export const logs = asyncHandler(async (req, res) => {
  const { from, to } = getDateFilters(req);
  ok(res, await svc.listLogs(req.ownerId, from, to));
});
export const processing = asyncHandler(async (req, res) => ok(res, await svc.listProcessing(req.ownerId)));
export const createProcessing = asyncHandler(async (req, res) =>
  ok(res, await svc.processMaterials(req.ownerId, processingBody.parse(req.body)), 201));
