import { Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler, ok } from '../utils/http';
import { HttpError } from '../utils/httpError';
import * as svc from '../services/subscription.service';

const createOrderBody = z.object({
  terms_accepted: z.literal(true),
});

const verifyBody = z.object({
  razorpay_order_id: z.string().min(1).max(64),
  razorpay_payment_id: z.string().min(1).max(64),
  razorpay_signature: z.string().regex(/^[a-f0-9]{64}$/i),
});

export const status = asyncHandler(async (req, res) =>
  ok(res, await svc.status(req.ownerId)),
);

export const createOrder = asyncHandler(async (req, res) => {
  const body = createOrderBody.parse(req.body);
  ok(res, await svc.createOrder(req.ownerId, body.terms_accepted), 201);
});

export const verifyPayment = asyncHandler(async (req, res) => {
  const body = verifyBody.parse(req.body);
  ok(
    res,
    await svc.verifyPayment(
      req.ownerId,
      body.razorpay_order_id,
      body.razorpay_payment_id,
      body.razorpay_signature,
    ),
  );
});

export const refreshPayment = asyncHandler(async (req, res) =>
  ok(res, await svc.refreshPendingPayment(req.ownerId)),
);

export const cancel = asyncHandler(async (req, res) =>
  ok(res, await svc.cancel(req.ownerId)),
);

export const webhook = asyncHandler(async (req: Request, res: Response) => {
  if (!Buffer.isBuffer(req.body)) {
    throw new HttpError(400, 'Razorpay webhook requires a raw request body');
  }
  const signature = req.header('X-Razorpay-Signature') ?? '';
  if (!svc.verifyWebhookSignature(req.body, signature)) {
    throw new HttpError(400, 'Invalid Razorpay webhook signature');
  }
  let event: any;
  try {
    event = JSON.parse(req.body.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid Razorpay webhook JSON');
  }
  await svc.handleWebhook(String(event.event ?? ''), event);
  res.status(200).json({ received: true });
});
