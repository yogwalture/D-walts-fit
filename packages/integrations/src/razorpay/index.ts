import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Razorpay.
 *
 * One rule governs this whole file: **a payment exists only after a
 * signature verifies on our server.** The browser telling us it succeeded is
 * a claim by an untrusted party, and treating it as money is how a gym gets
 * robbed by anyone who can open developer tools.
 *
 * So the order is always: create an order server-side → the member pays →
 * either the checkout handoff or the webhook arrives → verify the HMAC →
 * only then write a captured payment.
 */

export interface RazorpayConfig {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
}

export function getRazorpayConfig(): RazorpayConfig | null {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!keyId || !keySecret || !webhookSecret) return null;
  return { keyId, keySecret, webhookSecret };
}

export function isTestMode(config: RazorpayConfig): boolean {
  return config.keyId.startsWith('rzp_test_');
}

// ----------------------------------------------------------- signatures ---

function safeCompare(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * The checkout handoff signature: HMAC-SHA256 of "orderId|paymentId" with
 * the key secret. This is what the browser hands back after a successful
 * payment — useful for showing a receipt immediately, but the webhook is
 * what the ledger trusts.
 */
export function verifyCheckoutSignature(
  config: RazorpayConfig,
  input: { orderId: string; paymentId: string; signature: string },
): boolean {
  const expected = createHmac('sha256', config.keySecret)
    .update(`${input.orderId}|${input.paymentId}`)
    .digest('hex');
  return safeCompare(expected, input.signature);
}

/**
 * The webhook signature: HMAC-SHA256 of the RAW request body.
 *
 * Raw, not re-serialised JSON — key order and whitespace both change the
 * hash, so the body must be captured before parsing.
 */
export function verifyWebhookSignature(
  config: RazorpayConfig,
  rawBody: string,
  signature: string,
): boolean {
  const expected = createHmac('sha256', config.webhookSecret).update(rawBody).digest('hex');
  return safeCompare(expected, signature);
}

// --------------------------------------------------------------- orders ---

export interface CreateOrderInput {
  /** In paise, as Razorpay expects. */
  amount: number;
  currency?: string;
  receipt: string;
  notes?: Record<string, string>;
}

export interface RazorpayOrder {
  id: string;
  amount: number;
  currency: string;
  receipt: string;
  status: string;
}

export class RazorpayError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'RazorpayError';
  }
}

async function call<T>(
  config: RazorpayConfig,
  path: string,
  init: { method: string; body?: unknown },
): Promise<T> {
  const auth = Buffer.from(`${config.keyId}:${config.keySecret}`).toString('base64');

  const response = await fetch(`https://api.razorpay.com/v1${path}`, {
    method: init.method,
    headers: {
      authorization: `Basic ${auth}`,
      'content-type': 'application/json',
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
    // The hosting plan caps a request at 120 seconds. A hung gateway must
    // not take the whole request down with it.
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new RazorpayError(
      `Razorpay responded ${response.status}: ${detail.slice(0, 300)}`,
      response.status,
    );
  }

  return (await response.json()) as T;
}

export async function createOrder(
  config: RazorpayConfig,
  input: CreateOrderInput,
): Promise<RazorpayOrder> {
  return call<RazorpayOrder>(config, '/orders', {
    method: 'POST',
    body: {
      amount: input.amount,
      currency: input.currency ?? 'INR',
      receipt: input.receipt,
      notes: input.notes,
      payment_capture: 1,
    },
  });
}

export async function fetchPayment(
  config: RazorpayConfig,
  paymentId: string,
): Promise<{ id: string; status: string; amount: number; order_id: string; method: string }> {
  return call(config, `/payments/${paymentId}`, { method: 'GET' });
}

export async function refundPayment(
  config: RazorpayConfig,
  input: { paymentId: string; amount: number; notes?: Record<string, string> },
): Promise<{ id: string; status: string; amount: number }> {
  return call(config, `/payments/${input.paymentId}/refund`, {
    method: 'POST',
    body: { amount: input.amount, notes: input.notes },
  });
}

// -------------------------------------------------------------- webhook ---

export type RazorpayEventName =
  | 'payment.captured'
  | 'payment.failed'
  | 'order.paid'
  | 'refund.processed'
  | 'subscription.charged'
  | 'subscription.halted';

export interface RazorpayWebhookEvent {
  event: RazorpayEventName | string;
  /** Razorpay's own event id, used for replay protection. */
  id?: string;
  payload: {
    payment?: { entity: Record<string, unknown> };
    order?: { entity: Record<string, unknown> };
    refund?: { entity: Record<string, unknown> };
    subscription?: { entity: Record<string, unknown> };
  };
  created_at?: number;
}

export interface ParsedWebhook {
  event: string;
  eventId: string;
  paymentId?: string;
  orderId?: string;
  refundId?: string;
  /** Paise. */
  amount?: number;
  status?: string;
  method?: string;
  errorDescription?: string;
  raw: RazorpayWebhookEvent;
}

/**
 * Verifies and parses in one step, so there is no code path that reads the
 * body before checking the signature.
 */
export function parseWebhook(
  config: RazorpayConfig,
  rawBody: string,
  signature: string | null,
): ParsedWebhook {
  if (!signature) throw new RazorpayError('Webhook is missing its signature header', 400);
  if (!verifyWebhookSignature(config, rawBody, signature)) {
    throw new RazorpayError('Webhook signature does not verify', 401);
  }

  const event = JSON.parse(rawBody) as RazorpayWebhookEvent;
  const payment = event.payload?.payment?.entity as Record<string, unknown> | undefined;
  const order = event.payload?.order?.entity as Record<string, unknown> | undefined;
  const refund = event.payload?.refund?.entity as Record<string, unknown> | undefined;

  return {
    event: event.event,
    // Falls back to a derived id so replay protection still has a key when
    // Razorpay omits one.
    eventId:
      event.id ??
      `${event.event}:${(payment?.id ?? order?.id ?? refund?.id ?? 'unknown') as string}`,
    paymentId: payment?.id as string | undefined,
    orderId: (payment?.order_id ?? order?.id) as string | undefined,
    refundId: refund?.id as string | undefined,
    amount: (payment?.amount ?? refund?.amount ?? order?.amount) as number | undefined,
    status: payment?.status as string | undefined,
    method: payment?.method as string | undefined,
    errorDescription: payment?.error_description as string | undefined,
    raw: event,
  };
}

/**
 * A read that proves a key pair works without moving money.
 *
 * Used when a gym connects their account: listing one order authenticates
 * against Razorpay and tells us the credentials are real. Verifying by
 * taking a payment would be absurd, and verifying by not checking at all
 * means the first person to find out is a member tapping Pay.
 */
export async function fetchOrders(config: RazorpayConfig): Promise<void> {
  await call<{ count: number }>(config, '/orders?count=1', { method: 'GET' });
}
