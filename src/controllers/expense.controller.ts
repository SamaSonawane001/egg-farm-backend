import { z } from 'zod';
import { asyncHandler, ok } from '../utils/http';
import { HttpError } from '../utils/httpError';
import { monthlyBreakdown } from '../services/expense.service';

const query = z.object({
  month: z.coerce.number().int().min(1).max(12),
  year: z.coerce.number().int().min(2000).max(2100),
  limit: z.coerce.number().int().min(1).max(20).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export const monthlyBreakdownController = asyncHandler(async (req, res) => {
  const parsed = query.safeParse(req.query);
  if (!parsed.success) {
    throw new HttpError(400, 'Invalid month, year, or pagination parameters');
  }
  ok(res, await monthlyBreakdown(
    req.ownerId,
    parsed.data.month,
    parsed.data.year,
    parsed.data.limit,
    parsed.data.offset
  ));
});
