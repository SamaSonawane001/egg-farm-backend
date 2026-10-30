import { z } from 'zod';
import { asyncHandler, ok } from '../utils/http';
import * as svc from '../services/auth.service';

const mobile = z.string().trim().regex(/^[0-9]{10,13}$/, 'Enter a valid mobile number (10-13 digits, no spaces)');
const password = z.string().min(6, 'Password must be at least 6 characters').max(100);

export const register = asyncHandler(async (req, res) => {
  const b = z
    .object({ mobile, password, owner_name: z.string().trim().min(1).max(120), farm_name: z.string().trim().min(1).max(160) })
    .parse(req.body);
  const avatar_url = req.file ? `/uploads/${req.file.filename}` : null;
  ok(res, await svc.register({ ...b, avatar_url }), 201);
});

export const login = asyncHandler(async (req, res) => {
  const b = z.object({ mobile, password: z.string().min(1) }).parse(req.body);
  ok(res, await svc.login(b.mobile, b.password));
});

export const me = asyncHandler(async (req, res) => ok(res, await svc.getUser(req.ownerId)));

export const updateProfile = asyncHandler(async (req, res) => {
  const b = z
    .object({
      owner_name: z.string().trim().min(1).max(120).optional(),
      farm_name: z.string().trim().min(1).max(160).optional(),
      address: z.string().trim().max(500).optional(),
      low_stock_threshold: z.coerce.number().min(0).optional(),
      kg_per_bag: z.coerce.number().positive().optional(),
      default_tax_percent: z.coerce.number().min(0).max(100).optional(),
      eggs_per_tray: z.coerce.number().int().positive().max(2147483647).optional(),
    })
    .parse(req.body);
  const avatar_url = req.file ? `/uploads/${req.file.filename}` : undefined;
  ok(res, await svc.updateProfile(req.ownerId, { ...b, avatar_url }));
});

export const changePassword = asyncHandler(async (req, res) => {
  const b = z.object({ current_password: z.string().min(1), new_password: password }).parse(req.body);
  await svc.changePassword(req.ownerId, b.current_password, b.new_password);
  ok(res, { changed: true });
});
