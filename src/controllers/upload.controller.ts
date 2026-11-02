import { asyncHandler } from '../utils/http';
import { HttpError } from '../utils/httpError';
import { uploadBillFile, uploadProfileAvatar } from '../services/storage.service';
import * as authService from '../services/auth.service';

export const bill = asyncHandler(async (req, res) => {
  const category = req.body.category;
  if (category !== 'medicines' && category !== 'raw_materials') {
    throw new HttpError(400, 'category must be medicines or raw_materials');
  }
  if (!req.file) throw new HttpError(400, 'Bill file is required');

  const fileUrl = await uploadBillFile(req.ownerId, category, req.file);
  res.json({ success: true, fileUrl });
});

export const avatar = asyncHandler(async (req, res) => {
  try {
    if (!req.file?.buffer?.length) {
      throw new HttpError(400, 'Avatar image is required');
    }

    const avatarUrl = await uploadProfileAvatar(req.ownerId, req.file);
    const user = await authService.updateProfile(req.ownerId, { avatar_url: avatarUrl });
    res.json({ success: true, avatarUrl, user });
  } catch (error) {
    console.error('Avatar route failed:', error);
    const message = error instanceof Error
      ? error.message
      : error && typeof error === 'object' && 'message' in error
        ? String(error.message)
        : 'Avatar upload failed';
    res.status(500).json({ success: false, error: message });
  }
});
