import { asyncHandler } from '../utils/http';
import { HttpError } from '../utils/httpError';
import { uploadBillFile } from '../services/storage.service';

export const bill = asyncHandler(async (req, res) => {
  const category = req.body.category;
  if (category !== 'medicines' && category !== 'raw_materials') {
    throw new HttpError(400, 'category must be medicines or raw_materials');
  }
  if (!req.file) throw new HttpError(400, 'Bill file is required');

  const fileUrl = await uploadBillFile(req.ownerId, category, req.file);
  res.json({ success: true, fileUrl });
});
