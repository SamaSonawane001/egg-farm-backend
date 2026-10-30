import { z } from 'zod';
import { asyncHandler, dateStr, idParam, ok, optText } from '../utils/http';
import * as svc from '../services/flock.service';

const batchBody = z.object({
  batch_name: z.string().trim().min(1).max(120),
  arrival_date: dateStr,
  quantity: z.coerce.number().int().positive(),
  unit_price: z.coerce.number().min(0),
  notes: optText,
});
const mortalityBody = z.object({
  batch_id: z.coerce.number().int().positive(),
  log_date: dateStr,
  dead_count: z.coerce.number().int().positive(),
  cause: optText,
});

export const listBatches = asyncHandler(async (req, res) => ok(res, await svc.listBatches(req.ownerId)));
export const createBatch = asyncHandler(async (req, res) => ok(res, await svc.createBatch(req.ownerId, batchBody.parse(req.body)), 201));
export const updateBatch = asyncHandler(async (req, res) =>
  ok(res, await svc.updateBatch(req.ownerId, idParam(req.params.id), batchBody.parse(req.body))));
export const deleteBatch = asyncHandler(async (req, res) => {
  await svc.deleteBatch(req.ownerId, idParam(req.params.id));
  ok(res, { deleted: true });
});

export const listMortality = asyncHandler(async (req, res) =>
  ok(res, await svc.listMortality(req.ownerId, req.query.batchId ? idParam(String(req.query.batchId)) : undefined)));
export const createMortality = asyncHandler(async (req, res) =>
  ok(res, await svc.createMortality(req.ownerId, mortalityBody.parse(req.body)), 201));
export const updateMortality = asyncHandler(async (req, res) =>
  ok(res, await svc.updateMortality(req.ownerId, idParam(req.params.id), mortalityBody.parse(req.body))));
export const deleteMortality = asyncHandler(async (req, res) => {
  await svc.deleteMortality(req.ownerId, idParam(req.params.id));
  ok(res, { deleted: true });
});
