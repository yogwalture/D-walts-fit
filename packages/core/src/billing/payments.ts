import { Prisma, withTenant } from '@gym/db';
import { AppError } from '../errors';
import { writeAudit } from '../audit/log';
import {
  requirePermission,
  assertBranchAllowed,
  type ResolvedPermissions,
} from '../rbac/engine';
import { allocateReceiptNumber } from '../shared/sequences';
import { today } from '../shared/dates';
import { toPaise, toRupees } from '../shared/money';

/**
 * Payments.
 *
 * Two rules decide everything here:
 *
 *   1. A gateway payment is CAPTURED only by its verified webhook. Cash and
 *      UPI handed over at the desk are captured on the spot, because a
 *      person watched it happen.
 *   2. Nothing is ever edited. A correction is a new row plus a reversal, so
 *      the ledger shows what really happened rather than what someone wishes
 *      had happened.
 */

export interface BillingContext {
  organizationId: string;
  userId: string;
  branchIds?: string[];
}

export interface RecordPaymentInput {
  memberId: string;
  invoiceId?: string;
  subscriptionId?: string;
  amount: string;
  method: 'CASH' | 'UPI' | 'CARD' | 'BANK_TRANSFER' | 'CHEQUE' | 'WALLET' | 'OTHER';
  referenceNumber?: string;
  receivedAt?: string;
  branchId?: string;
  notes?: string;
}

export async function recordPayment(
  ctx: BillingContext,
  permissions: ResolvedPermissions,
  input: RecordPaymentInput,
  meta: { ipAddress?: string } = {},
): Promise<{ paymentId: string; receiptCode: string; invoiceStatus: string | null }> {
  requirePermission(permissions, 'finance.payment.create');
  if (input.branchId) assertBranchAllowed(permissions, input.branchId);

  const amountPaise = toPaise(input.amount);
  if (amountPaise <= 0) {
    throw new AppError('VALIDATION_FAILED', 'Enter an amount greater than zero.', [
      { field: 'amount', issue: 'Must be positive' },
    ]);
  }

  return withTenant(ctx, async (tx) => {
    const member = await tx.member.findFirst({
      where: { id: input.memberId, deletedAt: null },
      select: { id: true, firstName: true, branchId: true, outstandingAmount: true },
    });
    if (!member) throw new AppError('NOT_FOUND', 'Member not found.');

    let invoice = null;
    if (input.invoiceId) {
      invoice = await tx.invoice.findFirst({
        where: { id: input.invoiceId },
        select: { id: true, total: true, amountPaid: true, amountDue: true, status: true },
      });
      if (!invoice) throw new AppError('NOT_FOUND', 'Invoice not found.');
      if (invoice.status === 'CANCELLED') {
        throw new AppError('CONFLICT', 'That invoice has been cancelled.');
      }

      const duePaise = toPaise(invoice.amountDue.toString());
      if (duePaise <= 0) {
        throw new AppError('INVOICE_ALREADY_PAID', 'That invoice is already settled.');
      }
      if (amountPaise > duePaise) {
        throw new AppError(
          'VALIDATION_FAILED',
          'That is more than the invoice still owes.',
          [{ field: 'amount', issue: `Outstanding is ${toRupees(duePaise)}` }],
        );
      }
    }

    const receipt = await allocateReceiptNumber(tx, ctx.organizationId);

    const payment = await tx.payment.create({
      data: {
        organizationId: ctx.organizationId,
        branchId: input.branchId ?? member.branchId ?? null,
        memberId: member.id,
        invoiceId: invoice?.id ?? null,
        subscriptionId: input.subscriptionId ?? null,
        receiptCode: receipt.code,
        amount: toRupees(amountPaise),
        method: input.method,
        status: 'CAPTURED',
        referenceNumber: input.referenceNumber || null,
        receivedAt: input.receivedAt ? new Date(input.receivedAt) : new Date(),
        notes: input.notes || null,
        recordedByUserId: ctx.userId,
      },
      select: { id: true, receiptCode: true },
    });

    let invoiceStatus: 'PAID' | 'PARTIALLY_PAID' | null = null;

    if (invoice) {
      const paid = toPaise(invoice.amountPaid.toString()) + amountPaise;
      const due = toPaise(invoice.total.toString()) - paid;
      invoiceStatus = due <= 0 ? 'PAID' : 'PARTIALLY_PAID';

      await tx.invoice.update({
        where: { id: invoice.id },
        data: {
          amountPaid: toRupees(paid),
          amountDue: toRupees(Math.max(0, due)),
          status: invoiceStatus,
        },
      });
    }

    if (input.subscriptionId) {
      const subscription = await tx.subscription.findFirst({
        where: { id: input.subscriptionId },
        select: { paidAmount: true },
      });
      if (subscription) {
        await tx.subscription.update({
          where: { id: input.subscriptionId },
          data: {
            paidAmount: toRupees(toPaise(subscription.paidAmount.toString()) + amountPaise),
          },
        });
      }
    }

    const outstanding = Math.max(
      0,
      toPaise(member.outstandingAmount.toString()) - amountPaise,
    );

    await tx.member.update({
      where: { id: member.id },
      data: { outstandingAmount: toRupees(outstanding) },
    });

    await tx.memberTimelineEntry.create({
      data: {
        organizationId: ctx.organizationId,
        memberId: member.id,
        entryType: 'PAYMENT',
        title: `Paid ${toRupees(amountPaise)} by ${input.method.toLowerCase()}`,
        sourceType: 'Payment',
        sourceId: payment.id,
        actorUserId: ctx.userId,
      },
    });

    await writeAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'payment.recorded',
      entityType: 'Payment',
      entityId: payment.id,
      summary: `${toRupees(amountPaise)} from ${member.firstName} by ${input.method}`,
      after: {
        amount: toRupees(amountPaise),
        method: input.method,
        receipt: payment.receiptCode,
      },
      ipAddress: meta.ipAddress,
    });

    return { paymentId: payment.id, receiptCode: payment.receiptCode!, invoiceStatus };
  });
}

/**
 * Applies a verified gateway payment.
 *
 * Called ONLY from the webhook handler, after the HMAC has verified. It is
 * idempotent on the gateway's payment id, because Razorpay retries webhooks
 * and a double-credited membership is worse than a missed one.
 */
export async function applyVerifiedGatewayPayment(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  input: {
    organizationId: string;
    razorpayPaymentId: string;
    razorpayOrderId: string;
    amountPaise: number;
    method?: string;
    payload?: unknown;
  },
): Promise<{ applied: boolean; reason?: string; paymentId?: string }> {
  // The pending payment was created when the order was, so the order id is
  // the link between a browser session and our ledger.
  const pending = await db.payment.findFirst({
    where: { razorpayOrderId: input.razorpayOrderId },
    select: {
      id: true,
      status: true,
      amount: true,
      memberId: true,
      invoiceId: true,
      subscriptionId: true,
      organizationId: true,
    },
  });

  if (!pending) {
    return { applied: false, reason: 'no_matching_order' };
  }
  if (pending.organizationId !== input.organizationId) {
    return { applied: false, reason: 'tenant_mismatch' };
  }
  if (pending.status === 'CAPTURED') {
    // A retried webhook. Already done, and doing it again would double-count.
    return { applied: true, paymentId: pending.id, reason: 'already_captured' };
  }

  const expected = toPaise(pending.amount.toString());
  if (input.amountPaise !== expected) {
    return { applied: false, reason: 'amount_mismatch' };
  }

  await db.$transaction(async (tx: any) => {
    await tx.payment.update({
      where: { id: pending.id },
      data: {
        status: 'CAPTURED',
        razorpayPaymentId: input.razorpayPaymentId,
        gatewayPayload: (input.payload ?? null) as object,
        settledAt: new Date(),
      },
    });

    if (pending.invoiceId) {
      const invoice = await tx.invoice.findUnique({
        where: { id: pending.invoiceId },
        select: { total: true, amountPaid: true },
      });
      if (invoice) {
        const paid = toPaise(invoice.amountPaid.toString()) + input.amountPaise;
        const due = toPaise(invoice.total.toString()) - paid;
        await tx.invoice.update({
          where: { id: pending.invoiceId },
          data: {
            amountPaid: toRupees(paid),
            amountDue: toRupees(Math.max(0, due)),
            status: due <= 0 ? 'PAID' : 'PARTIALLY_PAID',
          },
        });
      }
    }

    if (pending.subscriptionId) {
      const subscription = await tx.subscription.findUnique({
        where: { id: pending.subscriptionId },
        select: { paidAmount: true },
      });
      if (subscription) {
        await tx.subscription.update({
          where: { id: pending.subscriptionId },
          data: {
            paidAmount: toRupees(
              toPaise(subscription.paidAmount.toString()) + input.amountPaise,
            ),
          },
        });
      }
    }

    if (pending.memberId) {
      const member = await tx.member.findUnique({
        where: { id: pending.memberId },
        select: { outstandingAmount: true },
      });
      if (member) {
        await tx.member.update({
          where: { id: pending.memberId },
          data: {
            outstandingAmount: toRupees(
              Math.max(0, toPaise(member.outstandingAmount.toString()) - input.amountPaise),
            ),
          },
        });
      }
    }

    await tx.auditLog.create({
      data: {
        organizationId: input.organizationId,
        actorUserId: null,
        action: 'payment.gateway.captured',
        entityType: 'Payment',
        entityId: pending.id,
        summary: `Razorpay ${input.razorpayPaymentId} verified and captured`,
        afterData: {
          razorpayPaymentId: input.razorpayPaymentId,
          amount: toRupees(input.amountPaise),
          method: input.method,
        },
      },
    });
  });

  return { applied: true, paymentId: pending.id };
}

export async function markGatewayPaymentFailed(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  input: { razorpayOrderId: string; reason?: string },
): Promise<void> {
  await db.payment.updateMany({
    where: { razorpayOrderId: input.razorpayOrderId, status: 'PENDING' },
    data: { status: 'FAILED', failureReason: input.reason?.slice(0, 300) },
  });
}

// ------------------------------------------------------------- reporting ---

export async function listPayments(
  ctx: BillingContext,
  permissions: ResolvedPermissions,
  options: {
    page?: number;
    pageSize?: number;
    fromDate?: string;
    toDate?: string;
    method?: string;
    memberId?: string;
  } = {},
) {
  requirePermission(permissions, 'finance.payment.read');

  const page = Math.max(1, options.page ?? 1);
  const pageSize = Math.min(options.pageSize ?? 25, 100);

  return withTenant(ctx, async (tx) => {
    const where: Prisma.PaymentWhereInput = {
      status: { in: ['CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED'] },
      ...(options.memberId ? { memberId: options.memberId } : {}),
      ...(options.method ? { method: options.method as never } : {}),
      ...(options.fromDate || options.toDate
        ? {
            receivedAt: {
              ...(options.fromDate ? { gte: new Date(`${options.fromDate}T00:00:00Z`) } : {}),
              ...(options.toDate ? { lte: new Date(`${options.toDate}T23:59:59Z`) } : {}),
            },
          }
        : {}),
    };

    const [rows, total, sum] = await Promise.all([
      tx.payment.findMany({
        where,
        orderBy: { receivedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          receiptCode: true,
          amount: true,
          method: true,
          status: true,
          receivedAt: true,
          referenceNumber: true,
          member: { select: { id: true, memberCode: true, firstName: true, lastName: true } },
          invoice: { select: { invoiceCode: true } },
        },
      }),
      tx.payment.count({ where }),
      tx.payment.aggregate({ where, _sum: { amount: true } }),
    ]);

    return {
      total,
      totalAmount: (sum._sum?.amount ?? 0).toString(),
      rows: rows.map((row: any) => ({
        id: row.id,
        receiptCode: row.receiptCode,
        amount: row.amount.toString(),
        method: row.method,
        status: row.status,
        receivedAt: row.receivedAt,
        referenceNumber: row.referenceNumber,
        memberId: row.member?.id ?? null,
        memberName: row.member
          ? [row.member.firstName, row.member.lastName].filter(Boolean).join(' ')
          : null,
        memberCode: row.member?.memberCode ?? null,
        invoiceCode: row.invoice?.invoiceCode ?? null,
      })),
    };
  });
}

/** The figure a gym owner actually asks for: what came in today. */
export async function dailyCollection(
  ctx: BillingContext,
  permissions: ResolvedPermissions,
  options: { date?: string; branchId?: string } = {},
): Promise<{ date: string; byMethod: Array<{ method: string; amount: string; count: number }>; total: string }> {
  requirePermission(permissions, 'finance.payment.read');

  const date = options.date ? new Date(`${options.date}T00:00:00Z`) : today();
  const end = new Date(date.getTime() + 86_400_000);

  return withTenant(ctx, async (tx) => {
    const grouped = await tx.payment.groupBy({
      by: ['method'],
      where: {
        status: 'CAPTURED',
        receivedAt: { gte: date, lt: end },
        ...(options.branchId ? { branchId: options.branchId } : {}),
      },
      _sum: { amount: true },
      _count: true,
    });

    let totalPaise = 0;
    const byMethod = grouped.map((row: any) => {
      const amount = (row._sum.amount ?? 0).toString();
      totalPaise += toPaise(amount);
      return { method: row.method, amount, count: row._count };
    });

    return {
      date: date.toISOString().slice(0, 10),
      byMethod,
      total: toRupees(totalPaise),
    };
  });
}
