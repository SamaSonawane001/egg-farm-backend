import fs from 'fs';
import multer from 'multer';
import path from 'path';
import crypto from 'crypto';
import { HttpError } from '../utils/httpError';

const dir = path.join(process.cwd(), 'uploads');
fs.mkdirSync(dir, { recursive: true });

const ALLOWED = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];

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
