import { z } from 'zod';
import { asyncHandler, okPaginated } from '../utils/http';
import { HttpError } from '../utils/httpError';
import { monthlyBreakdown } from '../services/expense.service';
import { parsePagination, paginationMetadata } from '../utils/pagination';

const query = z.object({
  month: z.coerce.number().int().min(1).max(12),
  year: z.coerce.number().int().min(2000).max(2100),
});

export const monthlyBreakdownController = asyncHandler(async (req, res) => {
  const parsed = query.safeParse(req.query);
  if (!parsed.success) {
    throw new HttpError(400, 'Invalid month, year, or pagination parameters');
  }
  const { page, limit, offset } = parsePagination(req.query);
  const result = await monthlyBreakdown(
    req.ownerId,
    parsed.data.month,
    parsed.data.year,
    limit,
    offset
  );
  okPaginated(res, result, paginationMetadata(result.total_records, page, limit, offset));
});
