import { createHmac, timingSafeEqual } from 'crypto';
import Razorpay = require('razorpay');
import { PoolClient } from 'pg';
import { env } from '../config/env';
import { pool, query, withTx } from '../config/db';
import { HttpError } from '../utils/httpError';

const PLAN_AMOUNT_PAISE = 89900;
const PLAN_CURRENCY = 'INR';
const PLAN_DAYS = 365;

type PaymentEvent = Record<string, unknown>;

function razorpay() {
  if (!env.razorpayKeyId || !env.razorpayKeySecret) {
    throw new HttpError(503, 'Subscription payments are not configured');
  }
  return new Razorpay({
    key_id: env.razorpayKeyId,
    key_secret: env.razorpayKeySecret,
  });
}

function verifyHmac(message: string | Buffer, signature: string, secret: string) {
  if (!secret || !signature || !/^[a-f0-9]{64}$/i.test(signature)) {
    return false;
  }
  const expected = createHmac('sha256', secret).update(message).digest();
  const actual = Buffer.from(signature, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function lockOwner(client: PoolClient, userId: string) {
  await client.query(
    'SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))',
    [`subscription:${userId}`],
  );
}

async function appendPaymentEvent(
  client: PoolClient,
  paymentId: string,
  event: PaymentEvent,
  status?: string,
  razorpayPaymentId?: string | null,
  signature?: string | null,
) {
  await client.query(
    `UPDATE subscription_payments
     SET status=COALESCE($2,status),
         razorpay_payment_id=COALESCE($3,razorpay_payment_id),
         razorpay_signature=COALESCE($4,razorpay_signature),
         raw_event=(CASE WHEN jsonb_typeof(raw_event)='array'
                         THEN raw_event ELSE jsonb_build_array(raw_event) END)
                   || CASE
                        WHEN $5::jsonb ? 'id' AND EXISTS (
                          SELECT 1
                          FROM jsonb_array_elements(
                            CASE WHEN jsonb_typeof(raw_event)='array'
                                 THEN raw_event
                                 ELSE jsonb_build_array(raw_event) END
                          ) AS saved_event(value)
                          WHERE saved_event.value->>'id'=$5::jsonb->>'id'
                        ) THEN '[]'::jsonb
                        ELSE jsonb_build_array($5::jsonb)
                      END,
         updated_at=NOW()
     WHERE id=$1`,
    [
      paymentId,
      status ?? null,
      razorpayPaymentId ?? null,
      signature ?? null,
      JSON.stringify(event),
    ],
  );
}

async function findPaymentOwner(orderId: string): Promise<string> {
  const rows = await query<{ user_id: string }>(
    'SELECT user_id FROM subscription_payments WHERE razorpay_order_id=$1',
    [orderId],
  );
  if (!rows.length) throw new HttpError(404, 'Payment order not found');
  return rows[0].user_id;
}

async function activateCapturedPayment(
  orderId: string,
  paymentId: string,
  event: PaymentEvent,
  signature?: string,
) {
  const ownerId = await findPaymentOwner(orderId);
  return withTx(async (client) => {
    await lockOwner(client, ownerId);
    const rows = await client.query(
      `SELECT * FROM subscription_payments
       WHERE user_id=$1 AND razorpay_order_id=$2 FOR UPDATE`,
      [ownerId, orderId],
    );
    if (!rows.rows.length) throw new HttpError(404, 'Payment order not found');
    const payment = rows.rows[0];
    if (payment.status === 'REFUNDED' || payment.status === 'DISPUTED') {
      await appendPaymentEvent(
        client,
        payment.id,
        event,
        undefined,
        paymentId,
        signature,
      );
      return { status: payment.status };
    }

    await appendPaymentEvent(
      client,
      payment.id,
      event,
      'CAPTURED',
      paymentId,
      signature,
    );
    if (payment.status !== 'CAPTURED') {
      await client.query(
        `UPDATE users SET subscription_status='ACTIVE',
           subscription_plan='ANNUAL_PRO',
           subscription_starts_at=NOW(),
           subscription_expires_at=NOW() + INTERVAL '365 days',
           subscription_cancelled_at=NULL,
           subscription_payment_id=$2
         WHERE id=$1`,
        [ownerId, payment.id],
      );
    }
    return { status: 'ACTIVE' };
  });
}

async function recordPaymentFailure(
  orderId: string,
  paymentId: string | null,
  event: PaymentEvent,
) {
  const ownerId = await findPaymentOwner(orderId);
  return withTx(async (client) => {
    await lockOwner(client, ownerId);
    const rows = await client.query(
      `SELECT * FROM subscription_payments
       WHERE user_id=$1 AND razorpay_order_id=$2 FOR UPDATE`,
      [ownerId, orderId],
    );
    if (!rows.rows.length) return;
    const payment = rows.rows[0];
    const status =
      payment.status === 'CAPTURED' ||
      payment.status === 'REFUNDED' ||
      payment.status === 'DISPUTED'
        ? undefined
        : 'FAILED';
    await appendPaymentEvent(
      client,
      payment.id,
      event,
      status,
      paymentId,
    );
    if (status === 'FAILED') {
      const events = Array.isArray(payment.raw_event)
        ? payment.raw_event
        : [];
      const orderEvent = events.find(
        (savedEvent: PaymentEvent) => savedEvent.type === 'order.created',
      );
      const previousStatus = [
        'TRIAL',
        'ACTIVE',
        'CANCELLED',
        'EXPIRED',
        'REFUNDED',
      ].includes(String(orderEvent?.previous_subscription_status))
        ? String(orderEvent.previous_subscription_status)
        : 'TRIAL';
      await client.query(
        `UPDATE users SET subscription_status=$2
         WHERE id=$1 AND subscription_status='PENDING'
           AND NOT EXISTS (
             SELECT 1 FROM subscription_payments
             WHERE user_id=$1 AND status='PENDING' AND id<>$3
           )`,
        [ownerId, previousStatus, payment.id],
      );
    }
  });
}

async function revokePayment(
  paymentId: string,
  event: PaymentEvent,
  status: 'REFUNDED' | 'DISPUTED',
) {
  return withTx(async (client) => {
    const owner = await client.query(
      `SELECT user_id FROM subscription_payments
       WHERE razorpay_payment_id=$1`,
      [paymentId],
    );
    if (!owner.rows.length) return;
    await lockOwner(client, owner.rows[0].user_id);
    const matches = await client.query(
      `SELECT id,user_id FROM subscription_payments
       WHERE razorpay_payment_id=$1 FOR UPDATE`,
      [paymentId],
    );
    if (!matches.rows.length) return;
    const payment = matches.rows[0];
    await appendPaymentEvent(client, payment.id, event, status, paymentId);
    await client.query(
      `UPDATE users SET subscription_status='REFUNDED',
         subscription_expires_at=NOW()
       WHERE id=$1 AND subscription_payment_id=$2`,
      [payment.user_id, payment.id],
    );
  });
}

function currentEntitlement(status: string, expiresAt: Date | string | null) {
  return (
    (status === 'ACTIVE' || status === 'CANCELLED') &&
    expiresAt != null &&
    new Date(expiresAt).getTime() > Date.now()
  );
}

export async function assertCanCreateInvoice(
  client: PoolClient,
  userId: string,
) {
  const rows = await client.query(
    `SELECT subscription_status,subscription_expires_at,free_invoices_limit
     FROM users WHERE id=$1::uuid FOR UPDATE`,
    [userId],
  );
  if (!rows.rows.length) throw new HttpError(404, 'Account not found');
  const user = rows.rows[0];
  if (user.subscription_status === 'PENDING') {
    throw new HttpError(
      402,
      'Your payment is awaiting bank or UPI confirmation. Invoices will remain locked until Razorpay confirms payment.',
      { code: 'PAYMENT_PENDING' },
    );
  }
  if (
    currentEntitlement(
      user.subscription_status,
      user.subscription_expires_at,
    )
  ) {
    return;
  }
  const count = await client.query(
    'SELECT COUNT(*)::int AS used FROM invoices WHERE owner_id=$1',
    [userId],
  );
  const used = Number(count.rows[0].used);
  const limit = Number(user.free_invoices_limit);
  if (used >= limit) {
    throw new HttpError(
      402,
      'Your 3 free invoices have been used. Subscribe to continue creating invoices.',
      {
        code: 'SUBSCRIPTION_REQUIRED',
        free_used: used,
        free_limit: limit,
      },
    );
  }
}

export async function status(userId: string) {
  const rows = await query(
    `SELECT u.subscription_status,u.subscription_plan,
       u.subscription_starts_at,u.subscription_expires_at,
       u.subscription_cancelled_at,u.free_invoices_limit,
       (SELECT COUNT(*)::int FROM invoices i WHERE i.owner_id=u.id) AS invoices_used,
       p.razorpay_order_id AS pending_order_id,p.status AS payment_status
     FROM users u
     LEFT JOIN LATERAL (
       SELECT razorpay_order_id,status FROM subscription_payments
       WHERE user_id=u.id AND status='PENDING'
       ORDER BY created_at DESC LIMIT 1
     ) p ON TRUE
     WHERE u.id=$1::uuid`,
    [userId],
  );
  if (!rows.length) throw new HttpError(404, 'Account not found');
  const row = rows[0];
  const expiresAt = row.subscription_expires_at
    ? new Date(row.subscription_expires_at)
    : null;
  let state = String(row.subscription_status);
  if (
    (state === 'ACTIVE' || state === 'CANCELLED') &&
    expiresAt != null &&
    expiresAt.getTime() <= Date.now()
  ) {
    state = 'EXPIRED';
  }
  const daysRemaining = expiresAt
    ? Math.max(
        0,
        Math.ceil((expiresAt.getTime() - Date.now()) / 86400000),
      )
    : null;
  const freeLimit = Number(row.free_invoices_limit);
  const invoicesUsed = Number(row.invoices_used);
  return {
    status: state,
    plan: row.subscription_plan,
    invoices_used: invoicesUsed,
    free_limit: freeLimit,
    remaining_free: Math.max(0, freeLimit - invoicesUsed),
    starts_at: row.subscription_starts_at,
    expires_at: row.subscription_expires_at,
    cancelled_at: row.subscription_cancelled_at,
    days_remaining: daysRemaining,
    show_renewal_warning:
      daysRemaining != null &&
      daysRemaining <= 7 &&
      (state === 'ACTIVE' || state === 'CANCELLED' || state === 'EXPIRED'),
    payment_status: row.payment_status ?? null,
    pending_order_id: row.pending_order_id ?? null,
    razorpay_key_id: env.razorpayKeyId || null,
  };
}

export async function createOrder(userId: string, termsAccepted: boolean) {
  if (!termsAccepted) {
    throw new HttpError(400, 'Accept the subscription terms before payment');
  }
  const gateway = razorpay();
  return withTx(async (client) => {
    await lockOwner(client, userId);
    const users = await client.query(
      `SELECT id,owner_name,mobile,subscription_status,subscription_expires_at
       FROM users WHERE id=$1::uuid FOR UPDATE`,
      [userId],
    );
    if (!users.rows.length) throw new HttpError(404, 'Account not found');
    const user = users.rows[0];
    const pending = await client.query(
      `SELECT razorpay_order_id,amount_paise,currency
       FROM subscription_payments
       WHERE user_id=$1 AND status='PENDING'
       ORDER BY created_at DESC LIMIT 1`,
      [userId],
    );
    if (pending.rows.length) {
      const order = pending.rows[0];
      return {
        order_id: order.razorpay_order_id,
        amount: Number(order.amount_paise),
        currency: order.currency,
        key_id: env.razorpayKeyId,
      };
    }

    const timestamp = Date.now();
    const compactUserId = String(userId).replace(/-/g, '').slice(0, 12);
    const receipt = `sub_${compactUserId}_${timestamp}`.slice(0, 40);
    let order: any;
    try {
      order = await gateway.orders.create({
        amount: PLAN_AMOUNT_PAISE,
        currency: PLAN_CURRENCY,
        receipt,
        notes: {
          user_id: userId,
          plan: 'ANNUAL_PRO',
          plan_days: String(PLAN_DAYS),
        },
      });
    } catch (error) {
      console.error('Razorpay order creation failed:', error);
      throw new HttpError(502, 'Could not start payment. Please try again.');
    }
    await client.query(
      `INSERT INTO subscription_payments
       (user_id,razorpay_order_id,amount_paise,currency,status,raw_event)
       VALUES($1,$2,$3,$4,'PENDING',jsonb_build_array($5::jsonb))`,
      [
        userId,
        order.id,
        PLAN_AMOUNT_PAISE,
        PLAN_CURRENCY,
        JSON.stringify({
          type: 'order.created',
          order,
          terms_accepted: true,
          terms_version: 'subscription-v1-2027',
          terms_accepted_at: new Date().toISOString(),
          previous_subscription_status: user.subscription_status,
        }),
      ],
    );
    if (
      !currentEntitlement(
        user.subscription_status,
        user.subscription_expires_at,
      )
    ) {
      await client.query(
        `UPDATE users SET subscription_status='PENDING' WHERE id=$1`,
        [userId],
      );
    }
    return {
      order_id: order.id,
      amount: PLAN_AMOUNT_PAISE,
      currency: PLAN_CURRENCY,
      key_id: env.razorpayKeyId,
    };
  });
}

export async function verifyPayment(
  userId: string,
  orderId: string,
  paymentId: string,
  signature: string,
) {
  if (
    !verifyHmac(
      `${orderId}|${paymentId}`,
      signature,
      env.razorpayKeySecret,
    )
  ) {
    throw new HttpError(400, 'Invalid Razorpay payment signature');
  }
  const ownerId = await findPaymentOwner(orderId);
  if (ownerId !== userId) throw new HttpError(404, 'Payment order not found');
  let payment: any;
  try {
    payment = await razorpay().payments.fetch(paymentId);
  } catch (error) {
    console.error('Razorpay payment verification fetch failed:', error);
    throw new HttpError(502, 'Could not confirm payment status. Please retry.');
  }
  if (payment.order_id !== orderId) {
    throw new HttpError(400, 'Payment does not match this order');
  }
  const event = { type: 'client.verify', payment };
  if (payment.status === 'captured') {
    await activateCapturedPayment(orderId, paymentId, event, signature);
    return { status: 'ACTIVE' };
  }
  if (payment.status === 'failed') {
    await recordPaymentFailure(orderId, paymentId, event);
    return { status: 'FAILED' };
  }
  if (payment.status === 'refunded') {
    await revokePayment(paymentId, event, 'REFUNDED');
    return { status: 'REFUNDED' };
  }
  const result = await withTx(async (client) => {
    await lockOwner(client, userId);
    const rows = await client.query(
      `SELECT * FROM subscription_payments
       WHERE user_id=$1 AND razorpay_order_id=$2 FOR UPDATE`,
      [userId, orderId],
    );
    if (!rows.rows.length) throw new HttpError(404, 'Payment order not found');
    const row = rows.rows[0];
    if (row.status === 'REFUNDED' || row.status === 'DISPUTED') {
      return { status: row.status };
    }
    await appendPaymentEvent(
      client,
      row.id,
      event,
      'PENDING',
      paymentId,
      signature,
    );
    return { status: 'PENDING' };
  });
  return result;
}

export async function refreshPendingPayment(userId: string) {
  const rows = await query(
    `SELECT razorpay_order_id FROM subscription_payments
     WHERE user_id=$1 AND status='PENDING'
     ORDER BY created_at DESC LIMIT 1`,
    [userId],
  );
  if (!rows.length) return status(userId);
  const orderId = String(rows[0].razorpay_order_id);
  let response: any;
  try {
    response = await razorpay().orders.fetchPayments(orderId);
  } catch (error) {
    console.error('Razorpay pending payment refresh failed:', error);
    throw new HttpError(502, 'Could not refresh payment status. Please retry.');
  }
  const payments = Array.isArray(response.items) ? response.items : [];
  const payment =
    payments.find((item: any) => item.status === 'captured') ??
    payments.find((item: any) =>
      ['authorized', 'created'].includes(item.status),
    ) ??
    payments.find((item: any) => item.status === 'failed');
  if (payment?.status === 'captured') {
    await activateCapturedPayment(orderId, payment.id, {
      type: 'client.refresh',
      payment,
    });
  } else if (payment?.status === 'failed') {
    await recordPaymentFailure(orderId, payment.id, {
      type: 'client.refresh',
      payment,
    });
  } else if (payment) {
    const ownerId = await findPaymentOwner(orderId);
    await withTx(async (client) => {
      await lockOwner(client, ownerId);
      const record = await client.query(
        `SELECT id FROM subscription_payments
         WHERE user_id=$1 AND razorpay_order_id=$2 FOR UPDATE`,
        [ownerId, orderId],
      );
      if (record.rows.length) {
        await appendPaymentEvent(
          client,
          record.rows[0].id,
          { type: 'client.refresh', payment },
          'PENDING',
          payment.id,
        );
      }
    });
  }
  return status(userId);
}

export async function cancel(userId: string) {
  return withTx(async (client) => {
    await lockOwner(client, userId);
    const rows = await client.query(
      `SELECT subscription_status,subscription_expires_at,subscription_payment_id
       FROM users WHERE id=$1::uuid FOR UPDATE`,
      [userId],
    );
    if (!rows.rows.length) throw new HttpError(404, 'Account not found');
    const user = rows.rows[0];
    if (
      !currentEntitlement(
        user.subscription_status,
        user.subscription_expires_at,
      )
    ) {
      throw new HttpError(409, 'There is no active subscription to cancel');
    }
    await client.query(
      `UPDATE users SET subscription_status='CANCELLED',
         subscription_cancelled_at=NOW() WHERE id=$1`,
      [userId],
    );
    if (user.subscription_payment_id) {
      await client.query(
        `UPDATE subscription_payments
         SET raw_event=(CASE WHEN jsonb_typeof(raw_event)='array'
                             THEN raw_event ELSE jsonb_build_array(raw_event) END)
                       || jsonb_build_array($2::jsonb),
             updated_at=NOW()
         WHERE id=$1`,
        [
          user.subscription_payment_id,
          JSON.stringify({
            type: 'subscription.cancelled',
            at: new Date().toISOString(),
            refund_issued: false,
          }),
        ],
      );
    }
    return {
      status: 'CANCELLED',
      expires_at: user.subscription_expires_at,
      refund_issued: false,
    };
  });
}

export function verifyWebhookSignature(body: Buffer, signature: string) {
  return verifyHmac(body, signature, env.razorpayWebhookSecret);
}

export async function handleWebhook(eventName: string, event: any) {
  const payload = event?.payload ?? {};
  if (eventName === 'payment.captured') {
    const payment = payload.payment?.entity;
    if (payment?.order_id && payment?.id) {
      await activateCapturedPayment(payment.order_id, payment.id, event);
    }
    return;
  }
  if (eventName === 'payment.failed') {
    const payment = payload.payment?.entity;
    if (payment?.order_id) {
      await recordPaymentFailure(
        payment.order_id,
        payment.id ?? null,
        event,
      );
    }
    return;
  }
  if (eventName === 'refund.processed') {
    const refund = payload.refund?.entity;
    if (refund?.payment_id) {
      await revokePayment(refund.payment_id, event, 'REFUNDED');
    }
    return;
  }
  if (eventName === 'payment.disputed') {
    const paymentId =
      payload.payment?.entity?.id ??
      payload.dispute?.entity?.payment_id ??
      payload.dispute?.entity?.payment?.id;
    if (paymentId) {
      await revokePayment(paymentId, event, 'DISPUTED');
    }
  }
}
