import fs from 'fs';
import { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import crypto from 'crypto';
import { HttpError } from '../utils/httpError';

const dir = path.join(process.cwd(), 'uploads');
fs.mkdirSync(dir, { recursive: true });

const ALLOWED = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
const PROFILE_AVATAR_MIME_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/x-png',
  'image/webp',
  'image/pjpeg',
]);
const PROFILE_AVATAR_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
export const uploadAvatar = multer({
  storage: multer.diskStorage({
    destination: dir,
    filename: (_req, file, cb) =>
      cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED.includes(path.extname(file.originalname).toLowerCase())) cb(null, true);
    else cb(new HttpError(400, 'Only jpg, png, webp or gif images are allowed') as any);
  },
}).single('avatar');

const profileAvatarParser = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 3 * 1024 * 1024,
    files: 1,
    fields: 16,
    parts: 17,
  },
  fileFilter: (_req, file, cb) => {
    const mimeType = (file.mimetype || '').toLowerCase();
    const extension = path.extname(file.originalname).toLowerCase();
    if (PROFILE_AVATAR_MIME_TYPES.has(mimeType) || PROFILE_AVATAR_EXTENSIONS.has(extension)) {
      cb(null, true);
    } else {
      cb(new HttpError(400, 'Avatar must be a JPEG, PNG or WebP image') as any);
    }
  },
}).single('avatar');

const profileAssetExtensions = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif', '.bmp',
  '.gif', '.tif', '.tiff', '.avif',
]);
const profileAssetParser = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024, files: 1, fields: 4, parts: 5 },
  fileFilter: (_req, file, cb) => {
    const mimeType = (file.mimetype || '').toLowerCase();
    const extension = path.extname(file.originalname).toLowerCase();
    if (
      mimeType.startsWith('image/') ||
      mimeType === 'application/octet-stream' ||
      profileAssetExtensions.has(extension)
    ) {
      cb(null, true);
    } else {
      cb(new HttpError(400, 'Please select an image file') as any);
    }
  },
}).single('image');

function respondUploadError(
  res: Response,
  error: unknown,
  fallbackMessage: string,
): void {
  const isMulterError = error instanceof multer.MulterError;
  const status = error instanceof HttpError
    ? error.status
    : isMulterError && error.code === 'LIMIT_FILE_SIZE'
      ? 413
      : isMulterError
        ? 400
        : 500;
  const message = error instanceof HttpError
    ? error.message
    : isMulterError && error.code === 'LIMIT_FILE_SIZE'
      ? 'Uploaded file is too large'
      : isMulterError
        ? 'Invalid upload request'
        : fallbackMessage;
  res.status(status).json({ success: false, error: message, message });
}

export const uploadProfileAsset = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  profileAssetParser(req, res, (error) => {
    if (!error) {
      next();
      return;
    }

    console.error('Farm image upload failed:', error);
    respondUploadError(res, error, 'Farm image upload failed');
  });
};

export const uploadProfileAvatar = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  profileAvatarParser(req, res, (error) => {
    if (!error) {
      next();
      return;
    }

    console.error('Avatar multipart upload failed:', error);
    respondUploadError(res, error, 'Avatar upload failed');
  });
};
