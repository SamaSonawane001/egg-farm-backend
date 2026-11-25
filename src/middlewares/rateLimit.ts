import { Request, Response } from 'express';
import { rateLimit } from 'express-rate-limit';

function rateLimitHandler(windowMs: number, message: string) {
  return (req: Request, res: Response) => {
    const resetTime = (
      req as Request & { rateLimit?: { resetTime?: Date } }
    ).rateLimit?.resetTime;
    const retryAfterSeconds = resetTime
      ? Math.ceil((resetTime.getTime() - Date.now()) / 1000)
      : Number(res.getHeader('Retry-After'));
    const retryAfter =
      Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? Math.ceil(retryAfterSeconds)
        : Math.ceil(windowMs / 1000);
    res.status(429).json({
      success: false,
      message,
      retry_after_seconds: retryAfter,
    });
  };
}

const commonOptions = {
  standardHeaders: true as const,
  legacyHeaders: false as const,
};

export const generalApiLimiter = rateLimit({
  ...commonOptions,
  windowMs: 60 * 1000,
  limit: 200,
  message: 'Too many requests. Please try again shortly.',
  handler: rateLimitHandler(
    60 * 1000,
    'Too many requests. Please try again shortly.',
  ),
});

export const loginLimiter = rateLimit({
  ...commonOptions,
  windowMs: 15 * 60 * 1000,
  limit: 10,
  message: 'Too many login requests. Please try again later.',
  handler: rateLimitHandler(
    15 * 60 * 1000,
    'Too many login requests. Please try again later.',
  ),
});

const otpWindowMs = 30 * 60 * 1000;

export const otpIpLimiter = rateLimit({
  ...commonOptions,
  windowMs: otpWindowMs,
  limit: 5,
  message: 'Too many OTP requests. Please try again later.',
  handler: rateLimitHandler(
    otpWindowMs,
    'Too many OTP requests. Please try again later.',
  ),
});

export const otpPhoneLimiter = rateLimit({
  ...commonOptions,
  windowMs: otpWindowMs,
  limit: 5,
  keyGenerator: (req) => {
    const phone = String(req.body?.phone ?? '').replace(/\D/g, '');
    return `phone:${phone || 'invalid'}`;
  },
  message: 'Too many OTP requests for this mobile number. Please try again later.',
  handler: rateLimitHandler(
    otpWindowMs,
    'Too many OTP requests for this mobile number. Please try again later.',
  ),
});
