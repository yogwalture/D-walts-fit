import { getJobsClient, withTenant } from '@gym/db';
import { AppError } from '../errors';
import { writeAudit } from '../audit/log';
import { requireAnyPermission, type ResolvedPermissions } from '../rbac/engine';
import { toPaise, toRupees } from '../shared/money';
import { gatewayCredentialsFor, type GatewayCredentials } from './gateway';
import { applyVerifiedGatewayPayment } from './payments';

/**
 * Paying an invoice online.
 *
 * The rule the user set, and the reason this file is shaped the way it is:
 * **a frontend payment success message is never proof of payment.** So the
 * browser is given exactly one power — to open checkout against an order we
 * created — and no power at all to tell us what happened afterwards.
 *
 * The sequence:
 *
 *   1. We create the order against the gym's own Razorpay account, and write
 *      a PENDING payment row carrying the order id. That row is the only
 *      link between a browser session and the ledger.
 *   2. The member pays. Razorpay hands the browser an order id, a payment id
 *      and a signature.
 *   3. The browser posts those back. We check the signature — which an
 *      attacker cannot forge without the gym's key secret — and then,
 *      because a valid signature still only proves the handoff came from
 *      Razorpay and not what it says, **we ask Razorpay's own API what the
 *      payment's status and amount actually are** and settle from that
 *      answer, not from the body we were posted.
 *   4. The webhook does the same thing independently. Whichever arrives
 *      first settles; the other is a no-op, because settlement is idempotent
 *      on the order id.
 *
 * Step 3 could be skipped — the webhook alone is correct. It exists because
 * a member standing at the desk having just paid should see it settled, not
 * be told to wait for a callback that may be a minute away.
 */

export interface OnlineContext {
  organizationId: string;
  userId?: string;
  branchIds?: string[];
}

export interface StartOnlinePaymentResult {
  /** For Razorpay Checkout, which needs all four. */
  orderId: string;
  keyId: string;
  amountPaise: number;
  currency: string;
  /** So the browser can show what is being paid for. */
  description: string;
  isLiveMode: boolean;
  /** Our own pending row, for the confirmation call. */
  paymentId: string;
}

/** Injected so tests do not reach the internet. Production passes the real pair. */
export interface GatewayPort {
  createOrder: (
    config: GatewayCredentials,
    input: { amount: number; currency?: string; receipt: string; notes?: Record<string, string> },
  ) => Promise<{ id: string; amount: number; currency: string; status: string }>;
  fetchPayment: (
    config: GatewayCredentials,
    paymentId: string,
  ) => Promise<{ id: string; status: string; amount: number; order_id: string; method: string }>;
  verifyCheckoutSignature: (
    config: GatewayCredentials,
    input: { orderId: string; paymentId: string; signature: string },
  ) => boolean;
}

function notConnected(): AppError {
  return new AppError(
    'INTEGRATION_NOT_CONFIGURED',
    'This gym has not connected online payments yet.',
  );
}

/**
 * Creates the order and the pending row that will be settled against it.
 *
 * Callable by the desk (for a member) and by the member themselves, so it
 * takes the invoice and derives everything else: an amount sent from a
 * browser is an amount a browser chose.
 */
export async function startOnlinePayment(
  ctx: OnlineContext,
  input: { invoiceId: string; memberId?: string },
  port: GatewayPort,
): Promise<StartOnlinePaymentResult> {
  const credentials = await gatewayCredentialsFor(ctx.organizationId);
  if (!credentials) throw notConnected();

  return withTenant(ctx, async (tx) => {
    const invoice = await tx.invoice.findFirst({
      where: { id: input.invoiceId },
      select: {
        id: true,
        invoiceCode: true,
        memberId: true,
        branchId: true,
        total: true,
        amountPaid: true,
        amountDue: true,
        status: true,
      },
    });
    if (!invoice) throw new AppError('NOT_FOUND', 'That invoice was not found.');

    // A member may only ever pay their own. Checked against the invoice
    // rather than against anything the caller sent.
    if (input.memberId && invoice.memberId !== input.memberId) {
      throw new AppError('NOT_FOUND', 'That invoice was not found.');
    }

    if (invoice.status === 'PAID') {
      throw new AppError('INVOICE_ALREADY_PAID', 'That invoice is already settled.');
    }
    if (invoice.status === 'CANCELLED') {
      throw new AppError('CONFLICT', 'That invoice has been cancelled.');
    }

    const duePaise = toPaise(invoice.amountDue.toString());
    if (duePaise <= 0) {
      throw new AppError('INVOICE_ALREADY_PAID', 'There is nothing left to pay on that invoice.');
    }

    // An order already open on this invoice is reused rather than stacked.
    // Two live orders for one invoice is how an invoice gets paid twice.
    const existing = await tx.payment.findFirst({
      where: {
        invoiceId: invoice.id,
        status: 'PENDING',
        method: 'RAZORPAY',
        razorpayOrderId: { not: null },
      },
      select: { id: true, razorpayOrderId: true, amount: true },
      orderBy: { createdAt: 'desc' },
    });

    if (existing && toPaise(existing.amount.toString()) === duePaise) {
      return {
        orderId: existing.razorpayOrderId!,
        keyId: credentials.keyId,
        amountPaise: duePaise,
        currency: 'INR',
        description: `Invoice ${invoice.invoiceCode}`,
        isLiveMode: credentials.isLiveMode,
        paymentId: existing.id,
      };
    }

    const order = await port.createOrder(credentials, {
      amount: duePaise,
      currency: 'INR',
      receipt: invoice.invoiceCode,
      // Razorpay echoes notes back on the webhook. Useful for support, and
      // deliberately not trusted for anything: the tenant still comes from
      // our own row.
      notes: { invoiceCode: invoice.invoiceCode, organizationId: ctx.organizationId },
    });

    if (order.amount !== duePaise) {
      // The gateway created an order for a different amount than we asked
      // for. Never seen, and never to be settled against.
      throw new AppError(
        'INTEGRATION_UNAVAILABLE',
        'The payment gateway created an order for the wrong amount, so it was abandoned.',
      );
    }

    const payment = await tx.payment.create({
      data: {
        organizationId: ctx.organizationId,
        branchId: invoice.branchId,
        memberId: invoice.memberId,
        invoiceId: invoice.id,
        amount: toRupees(duePaise),
        currency: 'INR',
        method: 'RAZORPAY',
        // PENDING, and it stays PENDING until a signature verifies on our
        // server. No receipt code yet either: a receipt is for money that
        // has arrived.
        status: 'PENDING',
        razorpayOrderId: order.id,
      },
      select: { id: true },
    });

    await writeAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId ?? null,
      action: 'payment.online.requested',
      entityType: 'Payment',
      entityId: payment.id,
      summary: `Online payment of ₹${toRupees(duePaise)} requested for ${invoice.invoiceCode}`,
      ipAddress: undefined,
    });

    return {
      orderId: order.id,
      keyId: credentials.keyId,
      amountPaise: duePaise,
      currency: 'INR',
      description: `Invoice ${invoice.invoiceCode}`,
      isLiveMode: credentials.isLiveMode,
      paymentId: payment.id,
    };
  });
}

export interface ConfirmResult {
  /** 'captured' | 'pending' | 'failed' */
  state: string;
  /** Present once settled. */
  receiptCode?: string | null;
  message: string;
}

/**
 * Settles what the browser came back with — by asking Razorpay, not the
 * browser.
 *
 * Returns 'pending' rather than throwing when the payment is genuinely not
 * captured yet: that is a normal state for a few seconds, and the honest
 * answer to a member staring at a screen is "we are waiting on your bank",
 * not an error page.
 */
export async function confirmOnlinePayment(
  ctx: OnlineContext,
  input: { orderId: string; razorpayPaymentId: string; signature: string; memberId?: string },
  port: GatewayPort,
): Promise<ConfirmResult> {
  const credentials = await gatewayCredentialsFor(ctx.organizationId);
  if (!credentials) throw notConnected();

  // Our own row first: it decides the tenant, the amount and whose invoice
  // this is. Nothing in the request body gets a say in any of that.
  const jobs = getJobsClient();
  const pending = await jobs.payment.findFirst({
    where: { razorpayOrderId: input.orderId, organizationId: ctx.organizationId },
    select: { id: true, status: true, receiptCode: true, memberId: true },
  });
  if (!pending) throw new AppError('NOT_FOUND', 'That payment was not found.');

  if (input.memberId && pending.memberId !== input.memberId) {
    throw new AppError('NOT_FOUND', 'That payment was not found.');
  }

  if (pending.status === 'CAPTURED') {
    // The webhook got here first, which is the expected case about as often
    // as not.
    return {
      state: 'captured',
      receiptCode: pending.receiptCode,
      message: 'Paid. Your receipt is ready.',
    };
  }

  // The handoff signature proves the browser is relaying something Razorpay
  // produced with this gym's key. It does NOT prove the payment succeeded,
  // which is why it is a gate and not the evidence.
  const signatureValid = port.verifyCheckoutSignature(credentials, {
    orderId: input.orderId,
    paymentId: input.razorpayPaymentId,
    signature: input.signature,
  });
  if (!signatureValid) {
    await writeOnlineAudit(ctx.organizationId, pending.id, 'payment.online.forged', {
      summary: `A checkout handoff for order ${input.orderId} failed signature verification`,
    });
    throw new AppError('FORBIDDEN', 'That payment confirmation could not be verified.');
  }

  // The evidence. Asked of Razorpay directly, server to server.
  const actual = await port.fetchPayment(credentials, input.razorpayPaymentId);

  if (actual.order_id !== input.orderId) {
    // A real payment, correctly signed, belonging to a different order.
    throw new AppError('FORBIDDEN', 'That payment belongs to a different order.');
  }

  if (actual.status !== 'captured' && actual.status !== 'authorized') {
    return {
      state: actual.status === 'failed' ? 'failed' : 'pending',
      message:
        actual.status === 'failed'
          ? 'Your bank declined that payment. Nothing has been taken.'
          : 'Your bank has not confirmed that payment yet. It will appear here once it does.',
    };
  }

  const result = await applyVerifiedGatewayPayment(jobs, {
    organizationId: ctx.organizationId,
    razorpayPaymentId: actual.id,
    razorpayOrderId: input.orderId,
    amountPaise: actual.amount,
    method: actual.method,
    payload: actual,
  });

  if (!result.applied) {
    throw new AppError(
      'INTEGRATION_UNAVAILABLE',
      'That payment was verified but could not be applied. The gym has been notified.',
      [{ field: 'reason', issue: result.reason ?? 'unknown' }],
    );
  }

  const settled = await jobs.payment.findUnique({
    where: { id: result.paymentId! },
    select: { receiptCode: true },
  });

  return {
    state: 'captured',
    receiptCode: settled?.receiptCode ?? null,
    message: 'Paid. Your receipt is ready.',
  };
}

async function writeOnlineAudit(
  organizationId: string,
  paymentId: string,
  action: string,
  input: { summary: string },
): Promise<void> {
  await getJobsClient().auditLog.create({
    data: {
      organizationId,
      actorUserId: null,
      action,
      entityType: 'Payment',
      entityId: paymentId,
      summary: input.summary,
    },
  });
}

/**
 * What a screen needs to know before offering to pay online.
 *
 * Readable from the desk and by a member, because both screens ask it: the
 * receptionist needs to know whether to offer a link, and the member needs
 * to know whether there is a button. "Does this gym take cards" is not a
 * confidence, and the two permissions are the two sides of the same
 * question — a member holds `self.payment.create`, staff hold
 * `finance.payment.read`, and either is enough to be told.
 */
export async function onlinePaymentAvailability(
  ctx: OnlineContext,
  permissions: ResolvedPermissions,
): Promise<{ available: boolean; isLiveMode: boolean; reason: string | null }> {
  requireAnyPermission(permissions, ['finance.payment.read', 'self.payment.create']);

  const credentials = await gatewayCredentialsFor(ctx.organizationId);
  if (!credentials) {
    return {
      available: false,
      isLiveMode: false,
      reason: 'This gym has not connected a payment gateway yet.',
    };
  }
  return { available: true, isLiveMode: credentials.isLiveMode, reason: null };
}
