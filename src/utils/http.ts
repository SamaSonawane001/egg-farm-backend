import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { HttpError } from './httpError';

export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<any>) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };

export const ok = (res: Response, data: any, status = 200) => res.status(status).json({ data });

export const idParam = (v: string): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'Invalid id');
  return n;
};

export const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');
export const optId = z.preprocess(
  (v) => (v === '' || v === undefined || v === null ? null : v),
  z.coerce.number().int().positive().nullable()
);
export const optText = z.preprocess(
  (v) => (v === '' || v === undefined ? null : v),
  z.string().trim().max(2000).nullable()
);
export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
