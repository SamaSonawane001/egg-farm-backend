import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { HttpError } from '../utils/httpError';
import { pool } from '../config/db';
import { runWithFarmContext } from '../config/farmContext';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      ownerId: string;
      farmId: string | 'all';
      farmIds: string[];
    }

  }
}

/** Validates the JWT and exposes the tenant id as req.ownerId. Every query is filtered by it. */
export function auth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    throw new HttpError(401, 'Missing authentication token', {
      code: 'AUTH_REQUIRED',
    });
  }
  try {
    const payload = jwt.verify(header.slice(7), env.jwtSecret) as { ownerId: string };
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.ownerId)) {
      throw new Error('Invalid owner id');
    }
    req.ownerId = payload.ownerId;
  } catch {
    throw new HttpError(401, 'Invalid or expired token', {
      code: 'AUTH_INVALID',
    });
  }
  next();
}

export async function farmContext(req: Request, res: Response, next: NextFunction) {
  try {
    const requested = req.header('X-Farm-Id')?.trim();
    const farms = await pool.query<{ id: string }>(
      'SELECT id FROM farms WHERE owner_user_id=$1::uuid ORDER BY is_primary DESC, created_at, id',
      [req.ownerId],
    );
    if (!farms.rows.length) throw new HttpError(404, 'No farms are associated with this account');

    let farmId: string | 'all';
    let farmIds: string[];
    if (requested?.toLowerCase() === 'all') {
      farmId = 'all';
      farmIds = farms.rows.map((farm) => farm.id);
    } else {
      const selected = (requested ?? farms.rows[0].id).toLowerCase();
      if (!UUID.test(selected)) throw new HttpError(400, 'Invalid farm id');
      const ownedFarm = await pool.query<{ id: string }>(
        'SELECT id FROM farms WHERE id=$1::uuid AND owner_user_id=$2::uuid',
        [selected, req.ownerId],
      );
      if (!ownedFarm.rows.length) {
        throw new HttpError(404, 'Farm not found for this account');
      }
      farmId = ownedFarm.rows[0].id;
      farmIds = [farmId];
    }

    req.farmId = farmId;
    req.farmIds = farmIds;
    const path = req.path.replace(/\/+$/, '');
    const profileManagementPaths = new Set([
      '/profile',
      '/farm/profile',
      '/profile/upload-avatar',
      '/farm/signature',
      '/farm/payment-qr',
      '/profile/assets/signature',
      '/profile/assets/payment_qr',
      '/farm/profile/assets/signature',
      '/farm/profile/assets/payment_qr',
    ]);
    const unitManagementPath = /^\/farms(?:\/[0-9a-fA-F-]{36})?$/.test(path);
    const primaryIdentityWrite = profileManagementPaths.has(path) || unitManagementPath;
    if (
      farmId === 'all' &&
      ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) &&
      !primaryIdentityWrite
    ) {
      res.status(409).json({
        success: false,
        code: 'FARM_REQUIRED',
        message: 'Select an individual farm to make changes',
      });
      return;
    }

    runWithFarmContext(
      { ownerId: req.ownerId, farmId: farmId === 'all' ? null : farmId, farmIds },
      next,
    );
  } catch (error) {
    next(error);
  }
}
