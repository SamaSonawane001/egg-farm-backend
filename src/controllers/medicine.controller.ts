import { z } from 'zod';
import { asyncHandler, dateStr, idParam, ok, optText } from '../utils/http';
import { HttpError } from '../utils/httpError';
import * as svc from '../services/medicine.service';
import { assertTenantBillUrl } from '../services/storage.service';

const units = ['L', 'ml', 'kg', 'g'] as const;
const calendarDate = dateStr.refine((v) => {
  const parsed = new Date(`${v}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === v;
}, 'Date must be a valid calendar date');
const quantity3 = z.coerce.number().positive().refine((n) => Math.abs(n * 1000 - Math.round(n * 1000)) < 1e-8, 'Use at most 3 decimal places');
const amount2 = z.coerce.number().min(0).refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-8, 'Use at most 2 decimal places');
const medicineBody = z.object({
  name: z.string().trim().min(1).max(120),
  category: z.enum(['Antibiotic', 'Vitamin', 'Vaccine', 'Sanitizer']),
  unit: z.enum(units),
  min_alert_level: z.coerce.number().min(0).refine((n) => Math.abs(n * 1000 - Math.round(n * 1000)) < 1e-8, 'Use at most 3 decimal places'),
});
const inwardBody = z.object({
  medicine_id: z.coerce.number().int().positive().optional(),
  medicine_name: z.string().trim().min(1).max(120).optional(),
  category: z.enum(['Antibiotic', 'Vitamin', 'Vaccine', 'Sanitizer']).optional(),
  quantity: quantity3,
  unit: z.enum(units),
  batch_number: z.string().trim().min(1).max(120),
  expiry_date: calendarDate,
  total_cost: amount2,
  date: calendarDate,
  remarks: optText,
  bill_image_url: z.preprocess((v) => (v === '' || v === undefined ? null : v), z.string().url().max(2048).nullable()),
  bill_number: z.preprocess((v) => (v === '' || v === undefined ? null : v), z.string().trim().max(100).nullable()),
  vendor_name: z.preprocess((v) => (v === '' || v === undefined ? null : v), z.string().trim().max(150).nullable()),
}).superRefine((body, context) => {
  if (!body.medicine_id && !body.medicine_name) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['medicine_name'], message: 'Medicine name is required' });
  }
  if (!body.medicine_id && !body.category) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['category'], message: 'Medicine category is required' });
  }
});
const usageBody = z.object({
  medicine_id: z.coerce.number().int().positive(),
  quantity: quantity3,
  unit: z.enum(units),
  flock_id: z.coerce.number().int().positive(),
  admin_route: z.enum(['Water', 'Feed', 'Spray', 'Injection']),
  date: calendarDate,
  remarks: optText,
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

export const list = asyncHandler(async (req, res) => ok(res, await svc.listMedicines(req.ownerId)));
export const create = asyncHandler(async (req, res) => ok(res, await svc.createMedicine(req.ownerId, medicineBody.parse(req.body)), 201));
export const update = asyncHandler(async (req, res) =>
  ok(res, await svc.updateMedicine(req.ownerId, idParam(req.params.id), medicineBody.parse(req.body))));
export const remove = asyncHandler(async (req, res) => {
  await svc.deleteMedicine(req.ownerId, idParam(req.params.id));
  ok(res, { deleted: true });
});
export const inward = asyncHandler(async (req, res) => {
  const body = inwardBody.parse(req.body);
  assertTenantBillUrl(req.ownerId, 'medicines', body.bill_image_url);
  ok(res, await svc.receiveMedicine(req.ownerId, body), 201);
});
export const usage = asyncHandler(async (req, res) => ok(res, await svc.createUsage(req.ownerId, usageBody.parse(req.body)), 201));
export const listUsage = asyncHandler(async (req, res) => {
  const { from, to } = getDateFilters(req);
  ok(res, await svc.listUsage(req.ownerId, from, to));
});
export const logs = asyncHandler(async (req, res) => {
  const { from, to } = getDateFilters(req);
  ok(res, await svc.listLogs(req.ownerId, from, to));
});
