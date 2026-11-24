import { z } from 'zod';
import {
  asyncHandler,
  dateStr,
  idParam,
  ok,
  okPaginated,
  optText,
} from '../utils/http';
import { HttpError } from '../utils/httpError';
import { parsePagination, paginationMetadata } from '../utils/pagination';
import * as svc from '../services/customer.service';

const paymentSchema = z.object({
  amount_paid: z.coerce.number().positive()
    .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-8, 'Use at most 2 decimal places'),
  payment_mode: z.enum(['Cash', 'UPI', 'UPI / Online', 'Bank Transfer']).transform(
    (mode) => mode === 'UPI' ? 'UPI / Online' : mode,
  ),
  payment_date: dateStr,
  invoice_id: z.preprocess(
    (value) => value === '' || value === null ? undefined : value,
    z.string().uuid().optional(),
  ),
  note: optText,
});

export const list = asyncHandler(async (req, res) => {
  const search = z.preprocess(
    (value) => value == null ? '' : value,
    z.string().trim().max(120),
  ).parse(req.query.search);
  const { page, limit, offset } = parsePagination({
    ...req.query,
    limit: 10,
  });
  const result = await svc.listCustomers(
    req.ownerId,
    search,
    limit,
    offset,
  );
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  okPaginated(
    res,
    result.data,
    paginationMetadata(result.total, page, limit, offset),
  );
});

export const ledger = asyncHandler(async (req, res) => {
  const id = idParam(req.params.customerId);
  const { page, limit, offset } = parsePagination({
    ...req.query,
    limit: 10,
  });
  const period = z.enum(['all', 'daily', 'weekly', 'monthly'])
    .default('all').parse(req.query.filter ?? req.query.period ?? 'all');
  const today = new Date().toISOString().slice(0, 10);
  let sinceDate: string | null = null;
  if (period === 'daily') sinceDate = today;
  if (period === 'weekly') {
    const from = new Date(`${today}T00:00:00.000Z`);
    from.setUTCDate(from.getUTCDate() - 6);
    sinceDate = from.toISOString().slice(0, 10);
  }
  if (period === 'monthly') sinceDate = `${today.slice(0, 7)}-01`;
  const result = await svc.customerLedger(
    req.ownerId,
    id,
    sinceDate,
    limit,
    offset,
  );
  const { total, ...data } = result;
  okPaginated(res, data, paginationMetadata(total, page, limit, offset));
});

export const receivePayment = asyncHandler(async (req, res) => {
  const parsed = paymentSchema.safeParse(req.body);
  if (!parsed.success) throw new HttpError(400, 'Invalid customer payment');
  ok(res, await svc.receiveCustomerPayment(
    req.ownerId,
    idParam(req.params.customerId),
    parsed.data,
  ), 201);
});

export const removePayment = asyncHandler(async (req, res) =>
  ok(res, await svc.removeCustomerPayment(
    req.ownerId,
    idParam(req.params.customerId),
    idParam(req.params.paymentId),
  )));
