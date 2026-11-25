import { Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler, ok } from '../utils/http';
import * as svc from '../services/auth.service';
import { normalizeFarmImage, uploadProfileAvatar } from '../services/storage.service';
import { HttpError } from '../utils/httpError';

const mobile = z.string().trim().regex(/^[0-9]{10,13}$/, 'Enter a valid mobile number (10-13 digits, no spaces)');
const indianMobile = z.string().trim().regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit mobile number');
const password = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(100, 'Password must be at most 100 characters')
  .regex(/[A-Za-z]/, 'Password must include at least one letter')
  .regex(/\d/, 'Password must include at least one number');

export const sendSignupOtp = asyncHandler(async (req, res) => {
  const b = z.object({ phone: indianMobile }).parse(req.body);
  ok(res, await svc.sendSignupOtp(b.phone));
});

export const sendResetOtp = asyncHandler(async (req, res) => {
  const b = z.object({ phone: indianMobile }).parse(req.body);
  ok(res, await svc.sendResetOtp(b.phone));
});

export const resetPassword = asyncHandler(async (req, res) => {
  const b = z.object({
    phone: indianMobile,
    otp: z.string().regex(/^\d{6}$/, 'Enter a valid 6-digit OTP'),
    new_password: password,
  }).parse(req.body);
  await svc.resetPassword(b.phone, b.otp, b.new_password);
  ok(res, { changed: true });
});

export const verifySignupOtp = asyncHandler(async (req, res) => {
  const b = z.object({
    phone: indianMobile,
    otp: z.string().regex(/^\d{6}$/, 'Enter a valid 6-digit OTP'),
  }).parse(req.body);
  ok(res, await svc.verifySignupOtp(b.phone, b.otp));
});

export const register = asyncHandler(async (req, res) => {
  if (
    req.body?.consent_accepted !== true &&
    req.body?.consent_accepted !== 'true'
  ) {
    throw new HttpError(
      400,
      'You must confirm 18+ age and accept Terms & Privacy Policy',
    );
  }
  const b = z
    .object({
      mobile: indianMobile,
      password,
      phone_verification_token: z.string().min(1),
      consent_accepted: z.preprocess(
        (value) => (value === 'true' ? true : value),
        z.boolean().optional(),
      ),
      consent_version: z.literal(svc.CONSENT_VERSION),
      owner_name: z.string().trim().min(1).max(120),
      farm_name: z.string().trim().min(1).max(160),
    })
    .parse(req.body);
  if (b.consent_accepted !== true) {
    throw new HttpError(
      400,
      'You must confirm 18+ age and accept Terms & Privacy Policy',
    );
  }
  const avatar_url = req.file ? `/uploads/${req.file.filename}` : null;
  ok(res, await svc.register({ ...b, avatar_url }), 201);
});

export const login = asyncHandler(async (req, res) => {
  const b = z.object({ mobile, password: z.string().min(1) }).parse(req.body);
  ok(res, await svc.login(b.mobile, b.password));
});

export const me = asyncHandler(async (req, res) => ok(res, await svc.getUser(
  req.ownerId,
  req.farmId === 'all' ? undefined : req.farmId,
)));

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
      shared_inventory_enabled: z.preprocess(
        (value) => value === 'true' ? true : value === 'false' ? false : value,
        z.boolean().optional(),
      ),
    })
    .parse(req.body);
  const avatar_url = req.file ? await uploadProfileAvatar(req.ownerId, req.file) : undefined;
  ok(res, await svc.updateProfile(req.ownerId, req.farmId, { ...b, avatar_url }));
});

export const updateInventoryMode = asyncHandler(async (req, res) => {
  const b = z.object({ shared_inventory_enabled: z.boolean() }).parse(req.body);
  ok(
    res,
    await svc.updateProfile(req.ownerId, req.farmId, {
      shared_inventory_enabled: b.shared_inventory_enabled,
    }),
  );
});

const farmAssetType = z.enum(['signature', 'payment_qr']);

async function storeFarmAssetImage(
  asset: z.infer<typeof farmAssetType>,
  req: Request,
  res: Response,
) {
  if (!req.file?.buffer?.length) throw new HttpError(400, 'Please select an image');
  const image = await normalizeFarmImage(req.file.buffer);
  const dataUri = `data:image/png;base64,${image.toString('base64')}`;
  const user = await svc.updateFarmAsset(req.ownerId, asset, dataUri);
  ok(res, { asset, url: dataUri, user });
}

export const uploadFarmAssetImage = asyncHandler(async (req, res) =>
  storeFarmAssetImage(farmAssetType.parse(req.params.asset), req, res));
export const uploadFarmSignature = asyncHandler(async (req, res) =>
  storeFarmAssetImage('signature', req, res));
export const uploadFarmPaymentQr = asyncHandler(async (req, res) =>
  storeFarmAssetImage('payment_qr', req, res));

async function removeFarmAssetImage(asset: z.infer<typeof farmAssetType>, req: Request, res: Response) {
  const user = await svc.updateFarmAsset(req.ownerId, asset, null);
  ok(res, { asset, user });
}

export const removeFarmAsset = asyncHandler(async (req, res) =>
  removeFarmAssetImage(farmAssetType.parse(req.params.asset), req, res));
export const removeFarmSignature = asyncHandler(async (req, res) =>
  removeFarmAssetImage('signature', req, res));
export const removeFarmPaymentQr = asyncHandler(async (req, res) =>
  removeFarmAssetImage('payment_qr', req, res));

export const changePassword = asyncHandler(async (req, res) => {
  const b = z.object({ current_password: z.string().min(1), new_password: password }).parse(req.body);
  await svc.changePassword(req.ownerId, b.current_password, b.new_password);
  ok(res, { changed: true });
});
