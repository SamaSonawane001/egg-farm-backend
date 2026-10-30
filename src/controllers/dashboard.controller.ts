import { asyncHandler, dateStr, ok } from '../utils/http';
import { getDashboard } from '../services/dashboard.service';

export const dashboard = asyncHandler(async (req, res) => {
  const today = dateStr.catch(new Date().toISOString().slice(0, 10)).parse(req.query.today);
  ok(res, await getDashboard(req.ownerId, today));
});
