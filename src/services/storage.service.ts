import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { randomBytes } from 'crypto';
import path from 'path';
import { env } from '../config/env';
import { HttpError } from '../utils/httpError';

let client: SupabaseClient | undefined;

function getStorageClient(): SupabaseClient {
  if (!env.supabaseUrl || !env.supabaseServiceRoleKey) {
    throw new HttpError(503, 'Bill uploads are not configured');
  }
  if (!client) {
    try {
      client = createClient(env.supabaseUrl, env.supabaseServiceRoleKey);
    } catch {
      throw new HttpError(503, 'Bill upload storage configuration is invalid');
    }
  }
  return client;
}

function sanitizeFilename(originalname: string): string {
  const extension = path.extname(originalname).toLowerCase();
  const base = path.basename(originalname, path.extname(originalname))
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 100);
  return `${base || 'bill'}${extension}`;
}

export async function uploadBillFile(
  ownerId: number,
  category: 'medicines' | 'raw_materials',
  file: Express.Multer.File
): Promise<string> {
  const storage = getStorageClient();
  assertFileSignature(file);
  const objectPath = `bills/farm_${ownerId}/${category}/${Date.now()}_${randomBytes(4).toString('hex')}_${sanitizeFilename(file.originalname)}`;
  try {
    const { error } = await storage.storage.from('farm-receipts').upload(objectPath, file.buffer, {
      contentType: file.mimetype,
      upsert: false,
    });
    if (error) throw error;
    return storage.storage.from('farm-receipts').getPublicUrl(objectPath).data.publicUrl;
  } catch {
    throw new HttpError(502, 'Bill upload failed; please try again');
  }
}

function assertFileSignature(file: Express.Multer.File): void {
  const bytes = file.buffer;
  const valid = file.mimetype === 'image/jpeg'
    ? bytes.length >= 3 && bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
    : file.mimetype === 'image/png'
      ? bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      : file.mimetype === 'image/webp'
        ? bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
        : file.mimetype === 'application/pdf'
          ? bytes.subarray(0, 5).toString('ascii') === '%PDF-'
          : false;
  if (!valid) throw new HttpError(400, 'Bill file contents do not match the selected file type');
}

export function assertTenantBillUrl(
  ownerId: number,
  category: 'medicines' | 'raw_materials',
  fileUrl: string | null | undefined
): void {
  if (!fileUrl) return;
  if (!env.supabaseUrl) {
    throw new HttpError(503, 'Bill uploads are not configured');
  }
  try {
    const url = new URL(fileUrl);
    const base = new URL(env.supabaseUrl);
    const prefix = `${base.pathname.replace(/\/$/, '')}/storage/v1/object/public/farm-receipts/bills/farm_${ownerId}/${category}/`;
    const objectName = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : '';
    if (
      url.origin !== base.origin ||
      !objectName ||
      objectName.includes('/') ||
      /%2f/i.test(objectName) ||
      url.search ||
      url.hash
    ) {
      throw new HttpError(400, "Bill URL must reference this farm's uploaded receipt");
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'Bill URL is invalid');
  }
}
