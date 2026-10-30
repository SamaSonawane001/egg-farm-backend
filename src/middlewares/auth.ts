import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { HttpError } from '../utils/httpError';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      ownerId: number;
    }
  }
}

/** Validates the JWT and exposes the tenant id as req.ownerId. Every query is filtered by it. */
export function auth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) throw new HttpError(401, 'Missing authentication token');
  try {
    const payload = jwt.verify(header.slice(7), env.jwtSecret) as { ownerId: number };
    req.ownerId = payload.ownerId;
  } catch {
    throw new HttpError(401, 'Invalid or expired token');
  }
  next();
}
