import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { query } from '../config/db';
import { env } from '../config/env';
import { HttpError } from '../utils/httpError';
import { User } from '../models/types';

export const USER_COLS =
  'id, mobile, owner_name, farm_name, avatar_url, address, low_stock_threshold, kg_per_bag, default_tax_percent, eggs_per_tray';

const sign = (ownerId: number) => jwt.sign({ ownerId }, env.jwtSecret, { expiresIn: env.jwtExpires as any });

export async function register(i: { mobile: string; password: string; owner_name: string; farm_name: string; avatar_url: string | null }) {
  const exists = await query('SELECT 1 FROM users WHERE mobile=$1', [i.mobile]);
  if (exists.length) throw new HttpError(409, 'This mobile number is already registered');
  const hash = await bcrypt.hash(i.password, 10);
  const rows = await query<User>(
    `INSERT INTO users (mobile, password_hash, owner_name, farm_name, avatar_url)
     VALUES ($1,$2,$3,$4,$5) RETURNING ${USER_COLS}`,
    [i.mobile, hash, i.owner_name, i.farm_name, i.avatar_url]
  );
  return { token: sign(rows[0].id), user: rows[0] };
}

export async function login(mobile: string, password: string) {
  const rows = await query<User & { password_hash: string }>('SELECT *, password_hash FROM users WHERE mobile=$1', [mobile]);
  if (!rows.length || !(await bcrypt.compare(password, rows[0].password_hash)))
    throw new HttpError(401, 'Invalid mobile number or password');
  const { password_hash, ...user } = rows[0];
  const pick = await getUser(user.id);
  return { token: sign(user.id), user: pick };
}

export async function getUser(ownerId: number): Promise<User> {
  const rows = await query<User>(`SELECT ${USER_COLS} FROM users WHERE id=$1`, [ownerId]);
  if (!rows.length) throw new HttpError(401, 'Account not found');
  return rows[0];
}

export async function updateProfile(
  ownerId: number,
  i: { owner_name?: string; farm_name?: string; address?: string; low_stock_threshold?: number; kg_per_bag?: number; default_tax_percent?: number; eggs_per_tray?: number; avatar_url?: string }
) {
  const rows = await query<User>(
    `UPDATE users SET
       owner_name=COALESCE($2,owner_name), farm_name=COALESCE($3,farm_name), address=COALESCE($4,address),
       low_stock_threshold=COALESCE($5,low_stock_threshold), kg_per_bag=COALESCE($6,kg_per_bag),
       default_tax_percent=COALESCE($7,default_tax_percent), avatar_url=COALESCE($8,avatar_url),
       eggs_per_tray=COALESCE($9,eggs_per_tray)
     WHERE id=$1 RETURNING ${USER_COLS}`,
    [ownerId, i.owner_name ?? null, i.farm_name ?? null, i.address ?? null, i.low_stock_threshold ?? null,
     i.kg_per_bag ?? null, i.default_tax_percent ?? null, i.avatar_url ?? null, i.eggs_per_tray ?? null]
  );
  return rows[0];
}

export async function changePassword(ownerId: number, current: string, next: string) {
  const rows = await query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id=$1', [ownerId]);
  if (!rows.length || !(await bcrypt.compare(current, rows[0].password_hash))) throw new HttpError(400, 'Current password is incorrect');
  await query('UPDATE users SET password_hash=$2 WHERE id=$1', [ownerId, await bcrypt.hash(next, 10)]);
}
