import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { HttpError } from '../utils/httpError';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      ownerId: string;
    }
  }
}

/** Validates the JWT and exposes the tenant id as req.ownerId. Every query is filtered by it. */
export function auth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) throw new HttpError(401, 'Missing authentication token');
  try {
    const payload = jwt.verify(header.slice(7), env.jwtSecret) as { ownerId: string };
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.ownerId)) {
      throw new Error('Invalid owner id');
    }
    req.ownerId = payload.ownerId;
  } catch {
    throw new HttpError(401, 'Invalid or expired token');
  }
  next();
}
