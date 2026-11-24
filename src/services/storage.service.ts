import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { randomBytes } from 'crypto';
import { env } from '../config/env';
import { HttpError } from '../utils/httpError';
import sharp from 'sharp';

let client: SupabaseClient | undefined;
const heicConvert = require('heic-convert') as (options: {
  buffer: Buffer;
  format: 'PNG';
  quality: number;
}) => Promise<Buffer>;
const bmpDecoder = require('bmp-js') as {
  decode: (buffer: Buffer) => { data: Buffer; width: number; height: number };
};

function getStorageClient(): SupabaseClient {
  if (!env.supabaseUrl || !env.supabaseServiceRoleKey) {
    throw new HttpError(
      503,
      'Supabase Storage is not configured; set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SECRET_KEY'
    );
  }
  if (!client) {
    client = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
  }
  return client;
}

export async function uploadProfileAvatar(ownerId: string, file: Express.Multer.File): Promise<string> {
  console.log('Supabase configured:', {
    url: Boolean(env.supabaseUrl),
    serviceRoleKey: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()),
    secretKey: Boolean(process.env.SUPABASE_SECRET_KEY?.trim()),
  });
  console.log('Avatar upload file:', {
    name: file.originalname,
    size: file.size,
    mimeType: file.mimetype,
  });

  try {
    if (!file.buffer?.length) {
      throw new HttpError(400, 'Avatar image data is missing');
    }

    const imageType = detectProfileImageType(file.buffer);
    if (!imageType) {
      throw new HttpError(400, 'Avatar contents do not match a supported image type');
    }

    const objectPath = `avatars/${ownerId}/profile_photo_${Date.now()}_${randomBytes(4).toString('hex')}.${imageType.extension}`;
    console.log('Avatar upload target:', {
      bucket: env.supabaseStorageBucket,
      filePath: objectPath,
    });

    const storage = getStorageClient();
    const bucket = storage.storage.from(env.supabaseStorageBucket);
    const { error } = await bucket.upload(objectPath, file.buffer, {
      contentType: imageType.contentType,
      upsert: true,
    });
    if (error) {
      console.error('Supabase Upload Error:', error);
      throw error;
    }

    console.log('Avatar upload complete:', { bucket: env.supabaseStorageBucket, filePath: objectPath });
    return bucket.getPublicUrl(objectPath).data.publicUrl;
  } catch (error) {
    console.error('Avatar upload failed:', error);
    throw error;
  }
}

function detectProfileImageType(bytes: Buffer): { contentType: string; extension: string } | null {
  if (bytes.length >= 3 && bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
    return { contentType: 'image/jpeg', extension: 'jpg' };
  }
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { contentType: 'image/png', extension: 'png' };
  }
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    return { contentType: 'image/webp', extension: 'webp' };
  }
  return null;
}

export async function normalizeFarmImage(bytes: Buffer): Promise<Buffer> {
  try {
    let input = bytes;
    if (bytes.length >= 12 && bytes.toString('ascii', 0, 2) === 'BM') {
      if (bytes.length < 26) throw new Error('Invalid BMP header');
      const width = bytes.readInt32LE(18);
      const height = Math.abs(bytes.readInt32LE(22));
      if (width <= 0 || height <= 0 || width * height > 40_000_000) {
        throw new Error('BMP dimensions are invalid or too large');
      }
      const bitmap = bmpDecoder.decode(bytes);
      if (bitmap.data.length !== bitmap.width * bitmap.height * 4) {
        throw new Error('BMP pixel data is invalid');
      }
      const rgba = Buffer.allocUnsafe(bitmap.width * bitmap.height * 4);
      for (let i = 0; i < bitmap.data.length; i += 4) {
        rgba[i] = bitmap.data[i + 3];
        rgba[i + 1] = bitmap.data[i + 2];
        rgba[i + 2] = bitmap.data[i + 1];
        rgba[i + 3] = bitmap.data[i];
      }
      input = await sharp(rgba, {
        raw: { width: bitmap.width, height: bitmap.height, channels: 4 },
      }).png().toBuffer();
    } else {
      const brands = bytes.toString('ascii', 4, 32).toLowerCase();
      const isAvif = brands.includes('avif') || brands.includes('avis');
      if (!isAvif && /(?:heic|heix|hevc|hevx|mif1|msf1)/.test(brands)) {
        input = await heicConvert({ buffer: bytes, format: 'PNG', quality: 1 });
      }
    }
    const normalized = await sharp(input, { limitInputPixels: 40_000_000, failOn: 'error' })
      .rotate()
      .resize(1400, 1400, { fit: 'inside', withoutEnlargement: true })
      .png({ compressionLevel: 9, palette: true, quality: 90 })
      .toBuffer();
    if (normalized.length > 2_900_000) {
      const smaller = await sharp(input, { limitInputPixels: 40_000_000, failOn: 'error' })
        .rotate()
        .resize(900, 900, { fit: 'inside', withoutEnlargement: true })
        .png({ compressionLevel: 9, palette: true, quality: 80 })
        .toBuffer();
      if (smaller.length > 2_900_000) throw new Error('Normalized image exceeds storage limit');
      return smaller;
    }
    return normalized;
  } catch (error) {
    console.error('Farm image normalization failed:', error);
    throw new HttpError(400, 'Could not read this image. Try another image format or a smaller image.');
  }
}
