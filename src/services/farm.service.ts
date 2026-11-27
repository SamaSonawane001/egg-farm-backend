import { query, setFarmSettings, withTx } from '../config/db';
import { HttpError } from '../utils/httpError';
import { ensurePrimaryFarm } from './primaryFarm.service';

export async function listFarms(ownerId: string) {
  await ensurePrimaryFarm(ownerId);
  return query<{
    farm_id: string;
    farm_name: string;
    is_primary: boolean;
    avatar_url: string | null;
    signature_url: string | null;
    payment_qr_url: string | null;
    address: string | null;
    low_stock_threshold: number;
    kg_per_bag: number;
    default_tax_percent: number;
    eggs_per_tray: number;
  }>(
    `SELECT id AS farm_id,name AS farm_name,is_primary,avatar_url,signature_url,
            payment_qr_url,address,low_stock_threshold,kg_per_bag,
            default_tax_percent,eggs_per_tray
     FROM farms f
     WHERE f.owner_user_id=$1::uuid
        OR to_jsonb(f)->>'user_id'=$1::text
        OR to_jsonb(f)->>'owner_id'=$1::text
     ORDER BY f.is_primary DESC,f.created_at,f.id`,
    [ownerId],
  );
}

export async function createFarm(
  ownerId: string,
  name: string,
  copyBranding: boolean,
) {
  const farmId = await withTx(async (client) => {
    await ensurePrimaryFarm(ownerId, client);
    const source = await client.query(
      `SELECT avatar_url,signature_url,payment_qr_url,address,low_stock_threshold,
              kg_per_bag,default_tax_percent,eggs_per_tray
       FROM farms f
       WHERE f.owner_user_id=$1::uuid
          OR to_jsonb(f)->>'user_id'=$1::text
          OR to_jsonb(f)->>'owner_id'=$1::text
       ORDER BY f.is_primary DESC,f.created_at,f.id LIMIT 1`,
      [ownerId],
    );
    if (!source.rows.length) throw new HttpError(404, 'Primary farm not found');
    const profile = source.rows[0];
    const created = await client.query<{ id: string }>(
      `INSERT INTO farms (
         owner_user_id,name,is_primary,avatar_url,signature_url,payment_qr_url,address,
         low_stock_threshold,kg_per_bag,default_tax_percent,eggs_per_tray
       ) VALUES ($1,$2,FALSE,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [
        ownerId,
        name,
        copyBranding ? profile.avatar_url : null,
        copyBranding ? profile.signature_url : null,
        copyBranding ? profile.payment_qr_url : null,
        copyBranding ? profile.address : null,
        copyBranding ? profile.low_stock_threshold : 10,
        copyBranding ? profile.kg_per_bag : 50,
        copyBranding ? profile.default_tax_percent : 0,
        copyBranding ? profile.eggs_per_tray : 30,
      ],
    );
    const id = created.rows[0].id;
    await setFarmSettings(client, { ownerId, farmId: id, farmIds: [id] });
    await client.query(
      'INSERT INTO feed_products(owner_id,farm_id,name) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
      [ownerId, id, 'Ready Feed'],
    );
    return id;
  });
  const farms = await listFarms(ownerId);
  const farm = farms.find((item) => item.farm_id === farmId);
  if (!farm) throw new HttpError(500, 'Created farm could not be loaded');
  return farm;
}

export async function renameUnit(ownerId: string, farmId: string, name: string) {
  const rows = await query(
    `UPDATE farms f SET name=$3
     WHERE f.id=$2::uuid
       AND (f.owner_user_id=$1::uuid
         OR to_jsonb(f)->>'user_id'=$1::text
         OR to_jsonb(f)->>'owner_id'=$1::text)
       AND f.is_primary=FALSE
     RETURNING id AS farm_id,name AS farm_name,is_primary`,
    [ownerId, farmId, name],
  );
  if (!rows.length) {
    const farms = await query(
      `SELECT is_primary FROM farms f
       WHERE f.id=$2::uuid
         AND (f.owner_user_id=$1::uuid
           OR to_jsonb(f)->>'user_id'=$1::text
           OR to_jsonb(f)->>'owner_id'=$1::text)`,
      [ownerId, farmId],
    );
    if (farms[0]?.is_primary) {
      throw new HttpError(400, 'Rename the primary farm in Farm Profile');
    }
    throw new HttpError(404, 'Farm not found for this account');
  }
  return rows[0];
}
