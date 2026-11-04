import { z } from 'zod';
import { asyncHandler, dateStr, idParam, ok, okPaginated, optId } from '../utils/http';
import { HttpError } from '../utils/httpError';
import * as svc from '../services/egg.service';
import { parsePagination, paginationMetadata } from '../utils/pagination';

const body = z.object({
  collection_date: dateStr,
  batch_id: optId,
  trays_count: z.coerce.number().int().min(0).max(2147483647),
  loose_eggs: z.coerce.number().int().min(0).max(2147483647).default(0),
  damaged_eggs: z.coerce.number().int().min(0).max(2147483647).default(0),
});

const monthParam = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Month must be YYYY-MM');

export const list = asyncHandler(async (req, res) => {
  const date = req.query.date === undefined ? undefined : dateStr.parse(req.query.date);
  const month = req.query.month === undefined ? undefined : monthParam.parse(req.query.month);
  if (date && month) {
    throw new HttpError(400, 'Specify either a date or a month, not both');
  }
  const { page, limit, offset } = parsePagination(req.query);
  const result = await svc.list(req.ownerId, date ? { date } : { month }, limit, offset);
  okPaginated(res, result.data, paginationMetadata(result.total, page, limit, offset));
});
export const summary = asyncHandler(async (req, res) => {
  const today = dateStr.catch(new Date().toISOString().slice(0, 10)).parse(req.query.today);
  ok(res, await svc.summary(req.ownerId, today));
});
export const monthly = asyncHandler(async (req, res) => {
  const month = monthParam.parse(req.query.month ?? new Date().toISOString().slice(0, 7));
  ok(res, await svc.monthlySummary(req.ownerId, month));
});
export const months = asyncHandler(async (req, res) => ok(res, await svc.monthlySummaries(req.ownerId)));
export const stock = asyncHandler(async (req, res) => ok(res, await svc.availableStock(req.ownerId)));
export const create = asyncHandler(async (req, res) => ok(res, await svc.create(req.ownerId, body.parse(req.body)), 201));
export const update = asyncHandler(async (req, res) => ok(res, await svc.update(req.ownerId, idParam(req.params.id), body.parse(req.body))));
export const remove = asyncHandler(async (req, res) => {
  await svc.remove(req.ownerId, idParam(req.params.id));
  ok(res, { deleted: true });
});
