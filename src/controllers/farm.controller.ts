import { z } from 'zod';
import { asyncHandler, idParam, ok } from '../utils/http';
import * as svc from '../services/farm.service';

export const list = asyncHandler(async (req, res) =>
  ok(res, await svc.listFarms(req.ownerId)));

export const create = asyncHandler(async (req, res) => {
  const body = z.object({
    name: z.string().trim().min(1).max(160),
    copy_branding: z.coerce.boolean().default(true),
  }).parse(req.body);
  ok(res, await svc.createFarm(req.ownerId, body.name, body.copy_branding), 201);
});

export const renameUnit = asyncHandler(async (req, res) => {
  const body = z.object({
    name: z.string().trim().min(1).max(160),
  }).parse(req.body);
  ok(res, await svc.renameUnit(
    req.ownerId,
    idParam(req.params.farmId),
    body.name,
  ));
});
