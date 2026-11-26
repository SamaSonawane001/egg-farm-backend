import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { PoolClient } from 'pg';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { query, setFarmSettings, withTx } from '../config/db';
import { env } from '../config/env';
import { HttpError } from '../utils/httpError';
import { User } from '../models/types';

const INDIAN_MOBILE = /^[6-9]\d{9}$/;
export const CONSENT_VERSION = 'v1.0-2027';
const NORMALIZED_MOBILE_SQL = `CASE
  WHEN length(regexp_replace(mobile, '[^0-9]', '', 'g')) = 12
    AND left(regexp_replace(mobile, '[^0-9]', '', 'g'), 2) = '91'
    THEN right(regexp_replace(mobile, '[^0-9]', '', 'g'), 10)
  WHEN length(regexp_replace(mobile, '[^0-9]', '', 'g')) = 11
    AND left(regexp_replace(mobile, '[^0-9]', '', 'g'), 1) = '0'
    THEN right(regexp_replace(mobile, '[^0-9]', '', 'g'), 10)
  ELSE regexp_replace(mobile, '[^0-9]', '', 'g')
END`;
const DEV_BYPASS_OTP = '000000';
let signupOtpClient: SupabaseClient | undefined;

const USER_COLS = `
  u.id, u.mobile, u.owner_name, f.name AS farm_name, f.id AS farm_id,
  f.is_primary, f.avatar_url, f.signature_url, f.payment_qr_url, f.address,
  f.low_stock_threshold, f.kg_per_bag, f.default_tax_percent, f.eggs_per_tray,
  u.shared_inventory_enabled`;

const sign = (ownerId: string) => jwt.sign({ ownerId }, env.jwtSecret, { expiresIn: env.jwtExpires as any });

function getSignupOtpClient(): SupabaseClient {
  if (!env.supabaseUrl || !env.supabaseAnonKey) {
    throw new HttpError(503, 'Phone verification is not configured');
  }
  if (!signupOtpClient) {
    signupOtpClient = createClient(env.supabaseUrl, env.supabaseAnonKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });
  }
  return signupOtpClient;
}

async function ensurePhoneAvailable(phone: string): Promise<void> {
  const existing = await query(
    `SELECT 1 FROM users WHERE (${NORMALIZED_MOBILE_SQL})=$1 LIMIT 1`,
    [phone],
  );
  if (existing.length) {
    throw new HttpError(409, 'Mobile number already registered. Please login.');
  }
}

async function findUserByPhone<T extends { id?: string } = { id: string }>(
  phone: string,
): Promise<T | undefined> {
  const rows = await query<T>(
    `SELECT id FROM users WHERE (${NORMALIZED_MOBILE_SQL})=$1 LIMIT 1`,
    [phone],
  );
  return rows[0];
}

export async function sendSignupOtp(phone: string): Promise<{ sent: true }> {
  if (!INDIAN_MOBILE.test(phone)) throw new HttpError(400, 'Enter a valid 10-digit mobile number');
  await ensurePhoneAvailable(phone);
  if (env.otpDevBypass) return { sent: true };

  const { error } = await getSignupOtpClient().auth.signInWithOtp({
    phone: `+91${phone}`,
  });
  if (error) throw new HttpError(502, 'Unable to send OTP. Please try again later.');
  return { sent: true };
}

export async function sendResetOtp(phone: string): Promise<{ sent: true }> {
  if (!INDIAN_MOBILE.test(phone)) throw new HttpError(400, 'Enter a valid 10-digit mobile number');
  if (!(await findUserByPhone(phone))) {
    throw new HttpError(404, 'No account found with this mobile number');
  }
  if (env.otpDevBypass) return { sent: true };

  const { error } = await getSignupOtpClient().auth.signInWithOtp({
    phone: `+91${phone}`,
  });
  if (error) throw new HttpError(502, 'Unable to send OTP. Please try again later.');
  return { sent: true };
}

export async function resetPassword(
  phone: string,
  otp: string,
  newPassword: string,
): Promise<void> {
  if (!INDIAN_MOBILE.test(phone)) throw new HttpError(400, 'Enter a valid 10-digit mobile number');
  if (!/^\d{6}$/.test(otp)) throw new HttpError(400, 'Enter a valid 6-digit OTP');
  if (
    newPassword.length < 8 ||
    newPassword.length > 100 ||
    !/[A-Za-z]/.test(newPassword) ||
    !/\d/.test(newPassword)
  ) {
    throw new HttpError(
      400,
      'Password must be 8-100 characters and include at least one letter and one number',
    );
  }

  const user = await findUserByPhone(phone);
  if (!user) throw new HttpError(404, 'No account found with this mobile number');

  if (!env.otpDevBypass) {
    const { error } = await getSignupOtpClient().auth.verifyOtp({
      phone: `+91${phone}`,
      token: otp,
      type: 'sms',
    });
    if (error) throw new HttpError(401, 'Invalid or expired OTP');
  } else if (otp !== DEV_BYPASS_OTP) {
    throw new HttpError(401, 'Invalid or expired OTP');
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await query(
    `UPDATE users
     SET password_hash=$2, failed_login_attempts=0, locked_until=NULL
     WHERE id=$1`,
    [
    user.id,
    passwordHash,
    ],
  );
}

export async function verifySignupOtp(phone: string, otp: string): Promise<{ phone_verification_token: string }> {
  if (!INDIAN_MOBILE.test(phone)) throw new HttpError(400, 'Enter a valid 10-digit mobile number');
  if (!/^\d{6}$/.test(otp)) throw new HttpError(400, 'Enter a valid 6-digit OTP');
  await ensurePhoneAvailable(phone);

  if (!env.otpDevBypass) {
    const { error } = await getSignupOtpClient().auth.verifyOtp({
      phone: `+91${phone}`,
      token: otp,
      type: 'sms',
    });
    if (error) throw new HttpError(401, 'Invalid or expired OTP');
  } else if (otp !== DEV_BYPASS_OTP) {
    throw new HttpError(401, 'Invalid or expired OTP');
  }

  return {
    phone_verification_token: jwt.sign(
      { phone, purpose: 'signup_phone_verification' },
      env.jwtSecret,
      { expiresIn: '10m' },
    ),
  };
}

function assertPhoneVerificationToken(phone: string, token: string): void {
  if (!INDIAN_MOBILE.test(phone)) throw new HttpError(400, 'Enter a valid 10-digit mobile number');
  try {
    const claims = jwt.verify(token, env.jwtSecret);
    if (
      typeof claims === 'string' ||
      claims.phone !== phone ||
      claims.purpose !== 'signup_phone_verification'
    ) {
      throw new HttpError(401, 'Phone number has not been verified');
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(401, 'Phone verification is missing, invalid, or expired');
  }
}

export async function register(i: {
  mobile: string;
  password: string;
  owner_name: string;
  farm_name: string;
  avatar_url: string | null;
  phone_verification_token: string;
  consent_version: typeof CONSENT_VERSION;
}) {
  assertPhoneVerificationToken(i.mobile, i.phone_verification_token);
  const hash = await bcrypt.hash(i.password, 10);
  const created = await withTx(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [i.mobile]);
    const exists = await client.query(
      `SELECT 1 FROM users WHERE (${NORMALIZED_MOBILE_SQL})=$1 LIMIT 1`,
      [i.mobile],
    );
    if (exists.rowCount) {
      throw new HttpError(409, 'Mobile number already registered. Please login.');
    }
    const user = await client.query<{ id: string }>(
      `INSERT INTO users (
         mobile, password_hash, owner_name, farm_name, avatar_url,
         consent_accepted, consent_version, consent_accepted_at
       )
       VALUES ($1,$2,$3,$4,$5,TRUE,$6,NOW()) RETURNING id`,
      [i.mobile, hash, i.owner_name, i.farm_name, i.avatar_url, i.consent_version],
    );
    const ownerId = user.rows[0].id;
    const farm = await client.query<{ id: string }>(
      `INSERT INTO farms (owner_user_id,name,is_primary,avatar_url)
       VALUES ($1,$2,TRUE,$3) RETURNING id`,
      [ownerId, i.farm_name, i.avatar_url],
    );
    const farmId = farm.rows[0].id;
    await setFarmSettings(client, { ownerId, farmId, farmIds: [farmId] });
    await client.query(
      'INSERT INTO feed_products(owner_id,farm_id,name) VALUES($1,$2,$3)',
      [ownerId, farmId, 'Ready Feed'],
    );
    return { ownerId, farmId };
  });
  return { token: sign(created.ownerId), user: await getUser(created.ownerId, created.farmId) };
}

export async function login(mobile: string, password: string) {
  const rows = await query<{
    id: string;
    password_hash: string;
    failed_login_attempts: number;
    locked_until: Date | null;
    retry_after_seconds: number;
  }>(
    `SELECT id, password_hash, failed_login_attempts, locked_until,
       CASE WHEN locked_until > NOW()
         THEN GREATEST(1, CEIL(EXTRACT(EPOCH FROM (locked_until - NOW()))))::int
         ELSE 0
       END AS retry_after_seconds
     FROM users WHERE mobile=$1`,
    [mobile],
  );
  if (!rows.length) {
    throw new HttpError(401, 'Invalid mobile number or password');
  }
  const account = rows[0];
  if (account.retry_after_seconds > 0 && account.locked_until) {
    throw new HttpError(
      423,
      `Too many failed attempts. Account locked for ${Math.ceil(account.retry_after_seconds / 60)} minutes.`,
      {
        retry_after_seconds: account.retry_after_seconds,
        locked_until: account.locked_until.toISOString(),
      },
    );
  }
  if (!(await bcrypt.compare(password, account.password_hash))) {
    const updated = await query<{
      failed_login_attempts: number;
      locked_until: Date | null;
      retry_after_seconds: number;
    }>(
      `UPDATE users
       SET failed_login_attempts = CASE
             WHEN locked_until IS NOT NULL AND locked_until <= NOW() THEN 1
             ELSE failed_login_attempts + 1
           END,
           locked_until = CASE
             WHEN CASE
               WHEN locked_until IS NOT NULL AND locked_until <= NOW() THEN 1
               ELSE failed_login_attempts + 1
             END >= 5
               THEN NOW() + INTERVAL '15 minutes'
             ELSE NULL
           END
       WHERE id=$1
       RETURNING failed_login_attempts, locked_until,
         CASE WHEN locked_until > NOW()
           THEN GREATEST(1, CEIL(EXTRACT(EPOCH FROM (locked_until - NOW()))))::int
           ELSE 0
         END AS retry_after_seconds`,
      [account.id],
    );
    const attempts = updated[0];
    if (attempts.failed_login_attempts >= 5 && attempts.locked_until) {
      throw new HttpError(
        423,
        'Account locked for 15 minutes due to 5 failed login attempts. Use Forgot Password to reset.',
        {
          retry_after_seconds: attempts.retry_after_seconds,
          locked_until: attempts.locked_until.toISOString(),
        },
      );
    }
    const remaining = Math.max(0, 5 - attempts.failed_login_attempts);
    throw new HttpError(
      401,
      `Invalid password. ${remaining} attempts remaining before temporary lock.`,
    );
  }
  await query(
    'UPDATE users SET failed_login_attempts=0, locked_until=NULL WHERE id=$1',
    [account.id],
  );
  const user = await getUser(account.id);
  return { token: sign(user.id), user };
}

export async function getUser(ownerId: string, farmId?: string): Promise<User> {
  const rows = await query<User>(
    `SELECT ${USER_COLS}
     FROM users u
     JOIN farms f ON f.owner_user_id=u.id
     WHERE u.id=$1 AND (($2::uuid IS NULL AND f.is_primary) OR f.id=$2::uuid)
     ORDER BY f.is_primary DESC LIMIT 1`,
    [ownerId, farmId ?? null],
  );
  if (!rows.length) throw new HttpError(404, 'Account or farm not found');
  return rows[0];
}

async function consolidateSharedInventory(
  client: PoolClient,
  ownerId: string,
  primaryFarmId: string,
) {
  const rawGroups = await client.query<{ canonical_id: string; ids: string[] }>(
    `SELECT (array_agg(id ORDER BY (farm_id=$2) DESC,created_at,id))[1] AS canonical_id,
            array_agg(id) AS ids
     FROM raw_materials
     WHERE owner_id=$1
     GROUP BY lower(trim(name))`,
    [ownerId, primaryFarmId],
  );
  for (const { canonical_id: canonicalId, ids } of rawGroups.rows) {
    await client.query(
      `UPDATE raw_material_logs SET material_id=$2
       WHERE owner_id=$1 AND material_id=ANY($3::uuid[])`,
      [ownerId, canonicalId, ids],
    );
    await client.query(
      `UPDATE feed_preparation_items SET raw_material_id=$2
       WHERE owner_id=$1 AND raw_material_id=ANY($3::uuid[])`,
      [ownerId, canonicalId, ids],
    );
    await client.query(
      'UPDATE raw_material_logs SET is_shared_pool=TRUE WHERE owner_id=$1 AND material_id=$2',
      [ownerId, canonicalId],
    );
    await client.query(
      `DELETE FROM raw_materials
       WHERE owner_id=$1 AND id=ANY($3::uuid[]) AND id<>$2`,
      [ownerId, canonicalId, ids],
    );
    await client.query(
      `UPDATE raw_materials SET farm_id=$3,is_shared_pool=TRUE
       WHERE owner_id=$1 AND id=$2`,
      [ownerId, canonicalId, primaryFarmId],
    );
  }
  await client.query(
    `WITH weighted_cost AS (
       SELECT material_id,
              SUM(total_amount)/NULLIF(SUM(quantity),0) AS rate
       FROM raw_material_logs
       WHERE owner_id=$1 AND is_shared_pool=TRUE AND transaction_type='INWARD'
       GROUP BY material_id
     )
     UPDATE raw_material_logs l
     SET rate_per_unit=ROUND(w.rate,3),
         total_amount=ROUND(l.quantity*w.rate,2)
     FROM weighted_cost w
     WHERE l.owner_id=$1 AND l.material_id=w.material_id
       AND l.transaction_type='OUTWARD_PROCESSING'
       AND l.total_amount IS NULL`,
    [ownerId],
  );

  const incompatibleMedicines = await client.query(
    `SELECT lower(trim(name)) AS name
     FROM medicines WHERE owner_id=$1
     GROUP BY lower(trim(name))
     HAVING COUNT(DISTINCT category || ':' || unit)>1
     LIMIT 1`,
    [ownerId],
  );
  if (incompatibleMedicines.rows.length) {
    throw new HttpError(
      409,
      `Cannot enable shared inventory: medicine "${incompatibleMedicines.rows[0].name}" has different categories or units across farms`,
    );
  }
  const medicineGroups = await client.query<{ canonical_id: string; ids: string[] }>(
    `SELECT (array_agg(id ORDER BY (farm_id=$2) DESC,created_at,id))[1] AS canonical_id,
            array_agg(id) AS ids
     FROM medicines
     WHERE owner_id=$1
     GROUP BY lower(trim(name))`,
    [ownerId, primaryFarmId],
  );
  for (const { canonical_id: canonicalId, ids } of medicineGroups.rows) {
    await client.query(
      `UPDATE medicine_batches SET medicine_id=$2
       WHERE owner_id=$1 AND medicine_id=ANY($3::uuid[])`,
      [ownerId, canonicalId, ids],
    );
    await client.query(
      `UPDATE medicine_usage SET medicine_id=$2
       WHERE owner_id=$1 AND medicine_id=ANY($3::uuid[])`,
      [ownerId, canonicalId, ids],
    );
    await client.query(
      `UPDATE medicine_logs SET medicine_id=$2
       WHERE owner_id=$1 AND medicine_id=ANY($3::uuid[])`,
      [ownerId, canonicalId, ids],
    );
    await client.query(
      'UPDATE medicine_batches SET is_shared_pool=TRUE WHERE owner_id=$1 AND medicine_id=$2',
      [ownerId, canonicalId],
    );
    await client.query(
      'UPDATE medicine_usage SET is_shared_pool=TRUE WHERE owner_id=$1 AND medicine_id=$2',
      [ownerId, canonicalId],
    );
    await client.query(
      'UPDATE medicine_logs SET is_shared_pool=TRUE WHERE owner_id=$1 AND medicine_id=$2',
      [ownerId, canonicalId],
    );
    await client.query(
      `UPDATE medicine_usage_allocations SET is_shared_pool=TRUE
       WHERE owner_id=$1
         AND (usage_id IN (SELECT id FROM medicine_usage WHERE owner_id=$1 AND medicine_id=$2)
           OR batch_id IN (SELECT id FROM medicine_batches WHERE owner_id=$1 AND medicine_id=$2))`,
      [ownerId, canonicalId],
    );
    await client.query(
      `DELETE FROM medicines
       WHERE owner_id=$1 AND id=ANY($3::uuid[]) AND id<>$2`,
      [ownerId, canonicalId, ids],
    );
    await client.query(
      `UPDATE medicines SET farm_id=$3,is_shared_pool=TRUE
       WHERE owner_id=$1 AND id=$2`,
      [ownerId, canonicalId, primaryFarmId],
    );
  }
}

export async function updateProfile(
  ownerId: string,
  activeFarmId: string | 'all',
  i: {
    owner_name?: string;
    farm_name?: string;
    address?: string;
    low_stock_threshold?: number;
    kg_per_bag?: number;
    default_tax_percent?: number;
    eggs_per_tray?: number;
    avatar_url?: string;
    shared_inventory_enabled?: boolean;
  },
) {
  const updatedFarmId = await withTx(async (client) => {
    const primary = await client.query<{ id: string }>(
      `SELECT id FROM farms
       WHERE owner_user_id=$1 AND is_primary=TRUE
       ORDER BY created_at,id LIMIT 1 FOR UPDATE`,
      [ownerId],
    );
    if (!primary.rows.length) throw new HttpError(404, 'Primary farm not found');
    if (i.shared_inventory_enabled !== undefined) {
      const current = await client.query<{ shared_inventory_enabled: boolean }>(
        'SELECT shared_inventory_enabled FROM users WHERE id=$1 FOR UPDATE',
        [ownerId],
      );
      if (i.shared_inventory_enabled && !current.rows[0]?.shared_inventory_enabled) {
        const farms = await client.query<{ id: string }>(
          'SELECT id FROM farms WHERE owner_user_id=$1 ORDER BY is_primary DESC,created_at,id',
          [ownerId],
        );
        if (farms.rows.length < 2) {
          throw new HttpError(400, 'Central Godown requires at least two farms');
        }
        await client.query(
          'UPDATE users SET shared_inventory_enabled=TRUE WHERE id=$1',
          [ownerId],
        );
        await setFarmSettings(client, {
          ownerId,
          farmId: primary.rows[0].id,
          farmIds: farms.rows.map((farm) => farm.id),
        });
        await consolidateSharedInventory(client, ownerId, primary.rows[0].id);
      } else if (
        !i.shared_inventory_enabled &&
        current.rows[0]?.shared_inventory_enabled
      ) {
        const farms = await client.query<{ id: string }>(
          'SELECT id FROM farms WHERE owner_user_id=$1 ORDER BY is_primary DESC,created_at,id',
          [ownerId],
        );
        await setFarmSettings(client, {
          ownerId,
          farmId: primary.rows[0].id,
          farmIds: farms.rows.map((farm) => farm.id),
        });
        await client.query(
          'UPDATE raw_materials SET is_shared_pool=FALSE WHERE owner_id=$1',
          [ownerId],
        );
        await client.query(
          'UPDATE medicines SET is_shared_pool=FALSE WHERE owner_id=$1',
          [ownerId],
        );
        await client.query(
          'UPDATE users SET shared_inventory_enabled=FALSE WHERE id=$1',
          [ownerId],
        );
      } else {
        await client.query(
          'UPDATE users SET shared_inventory_enabled=$2 WHERE id=$1',
          [ownerId, i.shared_inventory_enabled],
        );
      }
    }
    if (i.owner_name !== undefined) {
      await client.query('UPDATE users SET owner_name=$2 WHERE id=$1', [ownerId, i.owner_name]);
    }
    const identity = await client.query(
      `UPDATE farms SET
         name=COALESCE($3,name), address=COALESCE($4,address),
         avatar_url=COALESCE($5,avatar_url)
       WHERE owner_user_id=$1 AND id=$2 RETURNING id`,
      [ownerId, primary.rows[0].id, i.farm_name ?? null, i.address ?? null, i.avatar_url ?? null],
    );
    if (!identity.rowCount) throw new HttpError(404, 'Primary farm not found');

    const settingsFarmId =
      activeFarmId === 'all' ? primary.rows[0].id : activeFarmId;
    const settings = await client.query(
      `UPDATE farms SET
         low_stock_threshold=COALESCE($3,low_stock_threshold),
         kg_per_bag=COALESCE($4,kg_per_bag),
         default_tax_percent=COALESCE($5,default_tax_percent),
         eggs_per_tray=COALESCE($6,eggs_per_tray)
       WHERE owner_user_id=$1 AND id=$2 RETURNING id`,
      [ownerId, settingsFarmId, i.low_stock_threshold ?? null,
        i.kg_per_bag ?? null, i.default_tax_percent ?? null, i.eggs_per_tray ?? null],
    );
    if (!settings.rowCount) throw new HttpError(404, 'Farm not found for this account');
    return activeFarmId === 'all' ? primary.rows[0].id : activeFarmId;
  });
  return getUser(ownerId, updatedFarmId);
}

export async function updateFarmAsset(
  ownerId: string,
  asset: 'signature' | 'payment_qr',
  url: string | null,
) {
  const column = asset === 'signature' ? 'signature_url' : 'payment_qr_url';
  const farm = await query<{ id: string }>(
    `SELECT id FROM farms WHERE owner_user_id=$1 AND is_primary=TRUE
     ORDER BY created_at,id LIMIT 1`,
    [ownerId],
  );
  if (!farm.length) throw new HttpError(404, 'Primary farm not found');
  const rows = await query(
    `UPDATE farms SET ${column}=$2 WHERE owner_user_id=$1 AND id=$3 RETURNING id`,
    [ownerId, url, farm[0].id],
  );
  if (!rows.length) throw new HttpError(404, 'Farm profile not found');
  return getUser(ownerId, farm[0].id);
}

export async function changePassword(ownerId: string, current: string, next: string) {
  const rows = await query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id=$1', [ownerId]);
  if (!rows.length || !(await bcrypt.compare(current, rows[0].password_hash))) throw new HttpError(400, 'Current password is incorrect');
  await query('UPDATE users SET password_hash=$2 WHERE id=$1', [ownerId, await bcrypt.hash(next, 10)]);
}
