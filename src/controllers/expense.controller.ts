import { z } from 'zod';
import { asyncHandler, ok } from '../utils/http';
import { HttpError } from '../utils/httpError';
import { monthlyBreakdown } from '../services/expense.service';

const query = z.object({
  month: z.coerce.number().int().min(1).max(12),
  year: z.coerce.number().int().min(2000).max(2100),
});

export const monthlyBreakdownController = asyncHandler(async (req, res) => {
  const parsed = query.safeParse(req.query);
  if (!parsed.success) throw new HttpError(400, 'month must be 1-12 and year must be 2000-2100');
  ok(res, await monthlyBreakdown(req.ownerId, parsed.data.month, parsed.data.year));
});
