import fs from 'fs';
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
const BILL_FILE_TYPES: Record<string, string[]> = {
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/png': ['.png'],
  'image/webp': ['.webp'],
  'application/pdf': ['.pdf'],
};

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

export const uploadProfileAvatar = multer({
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

export const uploadBill = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024,
    files: 1,
    fields: 1,
    fieldSize: 32,
    parts: 2,
  },
  fileFilter: (_req, file, cb) => {
    const extension = path.extname(file.originalname).toLowerCase();
    if (BILL_FILE_TYPES[file.mimetype]?.includes(extension)) cb(null, true);
    else cb(new HttpError(400, 'Bill must be a JPEG, PNG, WebP or PDF file with a matching extension') as any);
  },
});
