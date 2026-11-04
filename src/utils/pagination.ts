import { z } from 'zod';
import { HttpError } from './httpError';

export type PaginationParams = {
  page: number;
  limit: number;
  offset: number;
};

const offsetParam = z.coerce.number().int().min(0);

function parseInteger(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(typeof value === 'string' ? value : '', 10);
  return parsed || fallback;
}

export function parsePagination(query: {
  page?: unknown;
  limit?: unknown;
  offset?: unknown;
}): PaginationParams {
  const limit = Math.min(100, Math.max(1, parseInteger(query.limit, 20)));
  const requestedPage = Math.max(1, parseInteger(query.page, 1));
  let offset = (requestedPage - 1) * limit;
  let page = requestedPage;

  if (query.page === undefined && query.offset !== undefined) {
    const parsedOffset = offsetParam.safeParse(query.offset);
    if (!parsedOffset.success) throw new HttpError(400, 'Invalid pagination parameters');
    offset = parsedOffset.data;
    page = Math.floor(offset / limit) + 1;
  }

  return { page, limit, offset };
}

export function paginationMetadata(
  total: number,
  page: number,
  limit: number,
  offset = (page - 1) * limit
) {
  return {
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
    hasMore: offset + limit < total,
  };
}
