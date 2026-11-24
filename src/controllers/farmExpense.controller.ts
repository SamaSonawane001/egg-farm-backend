import { z } from 'zod';
import { asyncHandler, dateStr, idParam, ok } from '../utils/http';
import { HttpError } from '../utils/httpError';
import * as svc from '../services/farmExpense.service';

const categories = [
  'farm_labour_salary',
  'feed_truck_unloading_hamali',
  'feed_mill_expense',
  'electricity_water',
  'transport_diesel',
  'other_farm_expense',
] as const;
const bodySchema = z.object({
  category: z.enum(categories),
  person_or_vendor: z.string().trim().max(150).nullable().optional(),
  description: z.string().trim().min(1).max(500),
  workers_count: z.coerce.number().int().positive().nullable().optional(),
  amount: z.coerce.number().positive()
    .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-8, 'Use at most 2 decimal places'),
  payment_mode: z.enum(['Cash', 'UPI / Online', 'Bank Transfer']),
  expense_date: dateStr,
});
const filtersSchema = z.object({
  month: z.coerce.number().int().min(1).max(12),
  year: z.coerce.number().int().min(2000).max(2100),
  category: z.enum([...categories, 'electricity_transport']).optional(),
});

export const list = asyncHandler(async (req, res) => {
  const parsed = filtersSchema.safeParse(req.query);
  if (!parsed.success) throw new HttpError(400, 'Invalid farm expense filters');
  ok(res, await svc.listFarmExpenses(
    req.ownerId,
    parsed.data.month,
    parsed.data.year,
    parsed.data.category,
  ));
});

export const create = asyncHandler(async (req, res) =>
  ok(res, await svc.createFarmExpense(req.ownerId, bodySchema.parse(req.body)), 201));

export const update = asyncHandler(async (req, res) =>
  ok(res, await svc.updateFarmExpense(
    req.ownerId,
    idParam(req.params.id),
    bodySchema.parse(req.body),
  )));

export const remove = asyncHandler(async (req, res) => {
  await svc.deleteFarmExpense(req.ownerId, idParam(req.params.id));
  ok(res, { deleted: true });
});
