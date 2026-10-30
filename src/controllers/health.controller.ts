import { query } from '../config/db';
import { asyncHandler } from '../utils/http';

export const health = asyncHandler(async (_req, res) => {
  await query('SELECT 1');
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    db: 'connected',
  });
});