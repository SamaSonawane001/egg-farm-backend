import { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { HttpError } from '../utils/httpError';

export function notFound(_req: Request, res: Response) {
  res.status(404).json({ error: 'Route not found' });
}

export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    const message = err.issues.map((i) => `${i.path.join('.') || 'value'}: ${i.message}`).join('; ');
    return res.status(400).json({ success: false, message, error: message });
  }
  if (err instanceof HttpError) return res.status(err.status).json({ success: false, message: err.message, error: err.message });
  if (err?.code === '23505') return res.status(409).json({ success: false, message: 'Duplicate record', error: 'Duplicate record' });
  if (err?.code === '23503') return res.status(409).json({ success: false, message: 'Record is referenced by other data', error: 'Record is referenced by other data' });
  if (err?.name === 'MulterError') {
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    const message = err.message || `Multer upload failed (${err.code || 'unknown error'})`;
    return res.status(status).json({ success: false, message, error: message });
  }
  console.error(err);
  res.status(500).json({ success: false, message: 'Internal server error', error: 'Internal server error' });
}
