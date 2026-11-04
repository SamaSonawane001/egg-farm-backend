import { z } from 'zod';
import { asyncHandler, dateStr, idParam, ok, okPaginated, optId } from '../utils/http';
import { HttpError } from '../utils/httpError';
import * as svc from '../services/feed.service';
import { parsePagination, paginationMetadata } from '../utils/pagination';

const purchaseBody = z.object({
  delivery_date: dateStr,
  feed_product_id: z.string().uuid(),
  bags: z.coerce.number().positive(),
  cost_per_bag: z.coerce.number().min(0),
});
const usageBody = z.object({
  usage_date: dateStr,
  batch_id: optId,
  feed_product_id: z.string().uuid(),
  quantity: z.coerce.number().positive(),
  unit: z.enum(['bags', 'kg']),
});
const productBody = z.object({ name: z.string().trim().min(1).max(120) });
export const stock = asyncHandler(async (req, res) => ok(res, await svc.getStock(req.ownerId)));
export const products = asyncHandler(async (req, res) => ok(res, await svc.listProducts(req.ownerId)));
export const createProduct = asyncHandler(async (req, res) =>
  ok(res, await svc.createProduct(req.ownerId, productBody.parse(req.body).name), 201));
export const productDetail = asyncHandler(async (req, res) => {
  const parsed = z.object({
    month: z.string().optional(),
    page: z.unknown().optional(),
    limit: z.unknown().optional(),
    offset: z.unknown().optional(),
    purchase_page: z.unknown().optional(),
    usage_page: z.unknown().optional(),
    purchase_offset: z.unknown().optional(),
    usage_offset: z.unknown().optional(),
  }).safeParse(req.query);
  if (!parsed.success) throw new HttpError(400, 'Invalid feed history pagination');
  const month = parsed.data.month ?? new Date().toISOString().slice(0, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new HttpError(400, 'Month must use YYYY-MM format');
  const purchasePagination = parsePagination({
    page: parsed.data.purchase_page ?? parsed.data.page,
    limit: parsed.data.limit,
    offset: parsed.data.purchase_offset ?? parsed.data.offset,
  });
  const usagePagination = parsePagination({
    page: parsed.data.usage_page ?? parsed.data.page,
    limit: parsed.data.limit,
    offset: parsed.data.usage_offset ?? parsed.data.offset,
  });
  ok(res, await svc.getProductDetail(
    req.ownerId,
    idParam(req.params.id),
    month,
    purchasePagination.offset,
    usagePagination.offset,
    purchasePagination.limit
  ));
});
export const updateProduct = asyncHandler(async (req, res) =>
  ok(res, await svc.updateProduct(req.ownerId, idParam(req.params.id), productBody.parse(req.body).name)));
export const removeProduct = asyncHandler(async (req, res) => {
  await svc.deleteProduct(req.ownerId, idParam(req.params.id));
  ok(res, { deleted: true });
});
export const listPurchases = asyncHandler(async (req, res) => {
  const { page, limit, offset } = parsePagination(req.query);
  const result = await svc.listPurchases(req.ownerId, limit, offset);
  okPaginated(res, result.data, paginationMetadata(result.total, page, limit, offset));
});
export const createPurchase = asyncHandler(async (req, res) => ok(res, await svc.createPurchase(req.ownerId, purchaseBody.parse(req.body)), 201));
export const updatePurchase = asyncHandler(async (req, res) =>
  ok(res, await svc.updatePurchase(req.ownerId, idParam(req.params.id), purchaseBody.parse(req.body))));
export const deletePurchase = asyncHandler(async (req, res) => {
  await svc.deletePurchase(req.ownerId, idParam(req.params.id));
  ok(res, { deleted: true });
});

export const listUsage = asyncHandler(async (req, res) => {
  const { page, limit, offset } = parsePagination(req.query);
  const result = await svc.listUsage(req.ownerId, limit, offset);
  okPaginated(res, result.data, paginationMetadata(result.total, page, limit, offset));
});
export const createUsage = asyncHandler(async (req, res) => ok(res, await svc.createUsage(req.ownerId, usageBody.parse(req.body)), 201));
export const updateUsage = asyncHandler(async (req, res) =>
  ok(res, await svc.updateUsage(req.ownerId, idParam(req.params.id), usageBody.parse(req.body))));
export const deleteUsage = asyncHandler(async (req, res) => {
  await svc.deleteUsage(req.ownerId, idParam(req.params.id));
  ok(res, { deleted: true });
});
