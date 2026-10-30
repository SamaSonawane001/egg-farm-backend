import { z } from 'zod';
import { asyncHandler, dateStr, idParam, ok, optId } from '../utils/http';
import { HttpError } from '../utils/httpError';
import * as svc from '../services/feed.service';

const purchaseBody = z.object({
  delivery_date: dateStr,
  feed_product_id: z.coerce.number().int().positive(),
  bags: z.coerce.number().positive(),
  cost_per_bag: z.coerce.number().min(0),
});
const usageBody = z.object({
  usage_date: dateStr,
  batch_id: optId,
  feed_product_id: z.coerce.number().int().positive(),
  quantity: z.coerce.number().positive(),
  unit: z.enum(['bags', 'kg']),
});
const productBody = z.object({ name: z.string().trim().min(1).max(120) });

export const stock = asyncHandler(async (req, res) => ok(res, await svc.getStock(req.ownerId)));
export const products = asyncHandler(async (req, res) => ok(res, await svc.listProducts(req.ownerId)));
export const createProduct = asyncHandler(async (req, res) =>
  ok(res, await svc.createProduct(req.ownerId, productBody.parse(req.body).name), 201));
export const productDetail = asyncHandler(async (req, res) => {
  const month = typeof req.query.month === 'string' ? req.query.month : new Date().toISOString().slice(0, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new HttpError(400, 'Month must use YYYY-MM format');
  ok(res, await svc.getProductDetail(req.ownerId, idParam(req.params.id), month));
});
export const updateProduct = asyncHandler(async (req, res) =>
  ok(res, await svc.updateProduct(req.ownerId, idParam(req.params.id), productBody.parse(req.body).name)));
export const removeProduct = asyncHandler(async (req, res) => {
  await svc.deleteProduct(req.ownerId, idParam(req.params.id));
  ok(res, { deleted: true });
});
export const listPurchases = asyncHandler(async (req, res) => ok(res, await svc.listPurchases(req.ownerId)));
export const createPurchase = asyncHandler(async (req, res) => ok(res, await svc.createPurchase(req.ownerId, purchaseBody.parse(req.body)), 201));
export const updatePurchase = asyncHandler(async (req, res) =>
  ok(res, await svc.updatePurchase(req.ownerId, idParam(req.params.id), purchaseBody.parse(req.body))));
export const deletePurchase = asyncHandler(async (req, res) => {
  await svc.deletePurchase(req.ownerId, idParam(req.params.id));
  ok(res, { deleted: true });
});

export const listUsage = asyncHandler(async (req, res) => ok(res, await svc.listUsage(req.ownerId)));
export const createUsage = asyncHandler(async (req, res) => ok(res, await svc.createUsage(req.ownerId, usageBody.parse(req.body)), 201));
export const updateUsage = asyncHandler(async (req, res) =>
  ok(res, await svc.updateUsage(req.ownerId, idParam(req.params.id), usageBody.parse(req.body))));
export const deleteUsage = asyncHandler(async (req, res) => {
  await svc.deleteUsage(req.ownerId, idParam(req.params.id));
  ok(res, { deleted: true });
});
