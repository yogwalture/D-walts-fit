import { withTenant } from '@gym/db';
import { AppError } from '../errors';
import { writeAudit } from '../audit/log';
import {
  requirePermission,
  assertBranchAllowed,
  type ResolvedPermissions,
} from '../rbac/engine';
import { allocateInvoiceNumber, allocateReceiptNumber } from '../shared/sequences';
import {
  addDays,
  endDateFor,
  inclusiveDays,
  isOnOrAfter,
  startOfDay,
  today,
} from '../shared/dates';
import { discountAmount, splitTax, toPaise, toRupees } from '../shared/money';

/**
 * The subscription engine.
 *
 * Every operation here writes the subscription, its event history, the
 * invoice and the payment in ONE transaction. A membership sold without its
 * invoice, or an invoice numbered but never issued, is worse than a failed
 * sale: the first loses money quietly and the second breaks GST numbering.
 *
 * `subscription_events` is append-only and is the real history. The
 * subscription row is the current state; the events are how it got there,
 * and they are what a dispute is settled with.
 */

export interface SubscriptionContext {
  organizationId: string;
  userId: string;
  branchIds?: string[];
}

export type PaymentMethodInput =
  | 'CASH'
  | 'UPI'
  | 'RAZORPAY'
  | 'CARD'
  | 'BANK_TRANSFER'
  | 'CHEQUE'
  | 'WALLET'
  | 'OTHER';

export interface SellMembershipInput {
  memberId: string;
  planId: string;
  branchId?: string;
  startDate?: string;
  /** Negotiated price. Falls back to the plan's list price. */
  overridePrice?: string;
  discountCode?: string;
  /** Collected at the desk now. Omit for "bill now, pay later". */
  payment?: {
    amount: string;
    method: PaymentMethodInput;
    referenceNumber?: string;
    receivedAt?: string;
  };
  notes?: string;
}

export interface SellMembershipResult {
  subscriptionId: string;
  invoiceId: string;
  invoiceCode: string;
  paymentId: string | null;
  receiptCode: string | null;
  startDate: Date;
  endDate: Date;
  total: string;
  paid: string;
  due: string;
  isRenewal: boolean;
}

export async function sellMembership(
  ctx: SubscriptionContext,
  permissions: ResolvedPermissions,
  input: SellMembershipInput,
  meta: { ipAddress?: string; userAgent?: string } = {},
): Promise<SellMembershipResult> {
  requirePermission(permissions, 'memberships.subscription.create');
  if (input.branchId) assertBranchAllowed(permissions, input.branchId);

  return withTenant(ctx, async (tx) => {
    const [member, plan, settings] = await Promise.all([
      tx.member.findFirst({
        where: { id: input.memberId, deletedAt: null },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          branchId: true,
          status: true,
          outstandingAmount: true,
        },
      }),
      tx.membershipPlan.findFirst({
        where: { id: input.planId, deletedAt: null, isActive: true },
        select: {
          id: true,
          name: true,
          durationUnit: true,
          durationValue: true,
          sessionCount: true,
          price: true,
          priceIncludesTax: true,
          graceDays: true,
          discountAllowed: true,
          autoRenew: true,
          taxRateId: true,
          taxRate: { select: { id: true, percentage: true, components: true } },
        },
      }),
      tx.orgSetting.findFirst({ select: { gstin: true } }),
    ]);

    if (!member) throw new AppError('NOT_FOUND', 'Member not found.');
    if (!plan) throw new AppError('NOT_FOUND', 'That plan is not available.');

    // A renewal stacks on the end of a live membership rather than
    // overwriting it: a member who renews early keeps the days they paid for.
    const live = await tx.subscription.findFirst({
      where: {
        memberId: member.id,
        status: { in: ['ACTIVE', 'FROZEN'] },
        deletedAt: null,
      },
      orderBy: { endDate: 'desc' },
      select: { id: true, endDate: true, status: true },
    });

    const isRenewal = Boolean(live);
    const requestedStart = input.startDate ? startOfDay(input.startDate) : null;
    const startDate =
      requestedStart ??
      (live && isOnOrAfter(live.endDate, today()) ? addDays(live.endDate, 1) : today());

    const endDate = endDateFor(startDate, plan.durationUnit, plan.durationValue);
    const graceUntil = addDays(endDate, plan.graceDays);

    // --- money ------------------------------------------------------------
    const listPaise = toPaise(input.overridePrice ?? plan.price.toString());

    let discountPaise = 0;
    let discountId: string | null = null;

    if (input.discountCode) {
      if (!plan.discountAllowed) {
        throw new AppError('VALIDATION_FAILED', 'This plan does not accept discounts.');
      }
      const discount = await tx.discount.findFirst({
        where: { code: input.discountCode, isActive: true },
        select: {
          id: true,
          discountType: true,
          value: true,
          maxDiscountAmount: true,
          validFrom: true,
          validUntil: true,
          maxUses: true,
          usedCount: true,
          applicablePlanIds: true,
        },
      });

      if (!discount) throw new AppError('NOT_FOUND', 'That discount code is not valid.');
      const now = today();
      if (discount.validFrom && now < discount.validFrom) {
        throw new AppError('CONFLICT', 'That discount is not active yet.');
      }
      if (discount.validUntil && now > discount.validUntil) {
        throw new AppError('CONFLICT', 'That discount has expired.');
      }
      if (discount.maxUses !== null && discount.usedCount >= discount.maxUses) {
        throw new AppError('CONFLICT', 'That discount has been fully used.');
      }
      if (
        discount.applicablePlanIds.length > 0 &&
        !discount.applicablePlanIds.includes(plan.id)
      ) {
        throw new AppError('CONFLICT', 'That discount does not apply to this plan.');
      }

      discountPaise = discountAmount(
        listPaise,
        discount.discountType,
        discount.value.toString(),
        discount.maxDiscountAmount?.toString(),
      );
      discountId = discount.id;

      await tx.discount.update({
        where: { id: discount.id },
        data: { usedCount: { increment: 1 } },
      });
    }

    const payable = listPaise - discountPaise;
    const tax = splitTax(payable, plan.taxRate, { inclusive: plan.priceIncludesTax });

    const paidPaise = input.payment ? toPaise(input.payment.amount) : 0;
    if (paidPaise > tax.total) {
      throw new AppError(
        'VALIDATION_FAILED',
        'That payment is more than the amount due. Record the correct amount.',
        [{ field: 'payment.amount', issue: `Due is ${toRupees(tax.total)}` }],
      );
    }

    const branchId = input.branchId ?? member.branchId ?? null;

    // --- subscription ------------------------------------------------------
    const subscription = await tx.subscription.create({
      data: {
        organizationId: ctx.organizationId,
        memberId: member.id,
        planId: plan.id,
        branchId,
        status: 'ACTIVE',
        startDate,
        endDate,
        graceUntil,
        listPrice: toRupees(listPaise),
        discountAmount: toRupees(discountPaise),
        discountId,
        taxableAmount: toRupees(tax.taxable),
        taxAmount: toRupees(tax.tax),
        totalAmount: toRupees(tax.total),
        paidAmount: toRupees(paidPaise),
        sessionsTotal: plan.sessionCount,
        autoRenew: plan.autoRenew,
        previousSubscriptionId: live?.id ?? null,
        createdByUserId: ctx.userId,
        events: {
          create: {
            organizationId: ctx.organizationId,
            eventType: isRenewal ? 'RENEWED' : 'CREATED',
            effectiveDate: startDate,
            daysDelta: inclusiveDays(startDate, endDate),
            amountDelta: toRupees(tax.total),
            toPlanId: plan.id,
            toBranchId: branchId,
            reason: input.notes,
            actorUserId: ctx.userId,
          },
        },
      },
      select: { id: true },
    });

    // --- invoice -----------------------------------------------------------
    const allocated = await allocateInvoiceNumber(tx, {
      organizationId: ctx.organizationId,
      at: startDate,
    });

    const duePaise = tax.total - paidPaise;

    const invoice = await tx.invoice.create({
      data: {
        organizationId: ctx.organizationId,
        branchId,
        memberId: member.id,
        series: allocated.series,
        financialYear: allocated.financialYear,
        invoiceNumber: allocated.number,
        invoiceCode: allocated.code,
        status: duePaise === 0 ? 'PAID' : paidPaise > 0 ? 'PARTIALLY_PAID' : 'ISSUED',
        issueDate: today(),
        dueDate: today(),
        subtotal: toRupees(tax.taxable),
        discountAmount: toRupees(discountPaise),
        taxAmount: toRupees(tax.tax),
        total: toRupees(tax.total),
        amountPaid: toRupees(paidPaise),
        amountDue: toRupees(duePaise),
        customerGstin: null,
        notes: settings?.gstin ? `GSTIN ${settings.gstin}` : null,
        createdByUserId: ctx.userId,
        lines: {
          create: {
            organizationId: ctx.organizationId,
            description: `${plan.name} — ${startDate.toISOString().slice(0, 10)} to ${endDate
              .toISOString()
              .slice(0, 10)}`,
            itemType: 'MEMBERSHIP',
            planId: plan.id,
            subscriptionId: subscription.id,
            quantity: 1,
            unitPrice: toRupees(tax.taxable),
            discountAmount: toRupees(discountPaise),
            taxRateId: plan.taxRateId,
            taxPercentage: tax.ratePercent,
            taxAmount: toRupees(tax.tax),
            lineTotal: toRupees(tax.total),
          },
        },
      },
      select: { id: true, invoiceCode: true },
    });

    // --- payment -----------------------------------------------------------
    let paymentId: string | null = null;
    let receiptCode: string | null = null;

    if (input.payment && paidPaise > 0) {
      const receipt = await allocateReceiptNumber(tx, ctx.organizationId, startDate);
      receiptCode = receipt.code;

      const payment = await tx.payment.create({
        data: {
          organizationId: ctx.organizationId,
          branchId,
          memberId: member.id,
          invoiceId: invoice.id,
          subscriptionId: subscription.id,
          receiptCode: receipt.code,
          amount: toRupees(paidPaise),
          method: input.payment.method,
          // Cash and UPI at the desk are captured on the spot. A gateway
          // payment is only ever CAPTURED by its verified webhook.
          status: input.payment.method === 'RAZORPAY' ? 'PENDING' : 'CAPTURED',
          referenceNumber: input.payment.referenceNumber || null,
          receivedAt: input.payment.receivedAt
            ? new Date(input.payment.receivedAt)
            : new Date(),
          recordedByUserId: ctx.userId,
        },
        select: { id: true },
      });
      paymentId = payment.id;
    }

    // --- member denormalisation -------------------------------------------
    const outstanding = toPaise(member.outstandingAmount.toString()) + duePaise;

    await tx.member.update({
      where: { id: member.id },
      data: {
        activeSubscriptionId: subscription.id,
        membershipExpiresAt: endDate,
        status: 'ACTIVE',
        outstandingAmount: toRupees(outstanding),
      },
    });

    await tx.memberTimelineEntry.create({
      data: {
        organizationId: ctx.organizationId,
        memberId: member.id,
        entryType: isRenewal ? 'MEMBERSHIP_RENEWED' : 'MEMBERSHIP_STARTED',
        title: `${plan.name} — ${isRenewal ? 'renewed' : 'started'}`,
        body: `Valid to ${endDate.toISOString().slice(0, 10)}`,
        sourceType: 'Subscription',
        sourceId: subscription.id,
        actorUserId: ctx.userId,
      },
    });

    await writeAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: isRenewal ? 'subscription.renewed' : 'subscription.created',
      entityType: 'Subscription',
      entityId: subscription.id,
      summary: `${plan.name} for ${member.firstName} — ${toRupees(tax.total)}`,
      after: {
        plan: plan.name,
        startDate: startDate.toISOString().slice(0, 10),
        endDate: endDate.toISOString().slice(0, 10),
        total: toRupees(tax.total),
        paid: toRupees(paidPaise),
      },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    return {
      subscriptionId: subscription.id,
      invoiceId: invoice.id,
      invoiceCode: invoice.invoiceCode,
      paymentId,
      receiptCode,
      startDate,
      endDate,
      total: toRupees(tax.total),
      paid: toRupees(paidPaise),
      due: toRupees(duePaise),
      isRenewal,
    };
  });
}

// ------------------------------------------------------------- freezing ---

/**
 * Freezing.
 *
 * The days a member loses are credited to the end of their membership, so a
 * two-week freeze moves the expiry two weeks later. The plan's freeze
 * allowance is a running total across the subscription, not per freeze —
 * otherwise a member freezes fourteen days at a time, forever.
 */
export async function freezeSubscription(
  ctx: SubscriptionContext,
  permissions: ResolvedPermissions,
  input: { subscriptionId: string; fromDate: string; toDate: string; reason?: string },
  meta: { ipAddress?: string } = {},
): Promise<{ daysCredited: number; newEndDate: Date; freezeDaysRemaining: number }> {
  requirePermission(permissions, 'memberships.subscription.freeze');

  return withTenant(ctx, async (tx) => {
    const subscription = await tx.subscription.findFirst({
      where: { id: input.subscriptionId, deletedAt: null },
      select: {
        id: true,
        status: true,
        endDate: true,
        frozenDaysUsed: true,
        memberId: true,
        plan: { select: { name: true, freezeAllowed: true, freezeMaxDays: true, graceDays: true } },
      },
    });

    if (!subscription) throw new AppError('NOT_FOUND', 'Subscription not found.');
    if (!subscription.plan.freezeAllowed) {
      throw new AppError('CONFLICT', `${subscription.plan.name} cannot be frozen.`);
    }
    if (subscription.status !== 'ACTIVE') {
      throw new AppError('SUBSCRIPTION_NOT_ACTIVE', 'Only an active membership can be frozen.');
    }

    const from = startOfDay(input.fromDate);
    const to = startOfDay(input.toDate);
    if (to < from) {
      throw new AppError('VALIDATION_FAILED', 'The freeze end date is before its start date.');
    }

    const days = inclusiveDays(from, to);
    const used = subscription.frozenDaysUsed + days;

    if (used > subscription.plan.freezeMaxDays) {
      const left = Math.max(0, subscription.plan.freezeMaxDays - subscription.frozenDaysUsed);
      throw new AppError(
        'CONFLICT',
        left === 0
          ? 'This membership has used its whole freeze allowance.'
          : `Only ${left} freeze ${left === 1 ? 'day is' : 'days are'} left on this membership.`,
      );
    }

    const newEndDate = addDays(subscription.endDate, days);
    const newGrace = addDays(newEndDate, subscription.plan.graceDays);

    await tx.subscription.update({
      where: { id: subscription.id },
      data: {
        status: 'FROZEN',
        endDate: newEndDate,
        graceUntil: newGrace,
        frozenDaysUsed: used,
        freezes: {
          create: {
            organizationId: ctx.organizationId,
            fromDate: from,
            toDate: to,
            daysCredited: days,
            reason: input.reason,
            actorUserId: ctx.userId,
          },
        },
        events: {
          create: {
            organizationId: ctx.organizationId,
            eventType: 'FROZEN',
            effectiveDate: from,
            daysDelta: days,
            reason: input.reason,
            actorUserId: ctx.userId,
          },
        },
      },
    });

    await tx.member.update({
      where: { id: subscription.memberId },
      data: { membershipExpiresAt: newEndDate },
    });

    await writeAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'subscription.frozen',
      entityType: 'Subscription',
      entityId: subscription.id,
      summary: `Frozen ${days} ${days === 1 ? 'day' : 'days'}; expiry moved to ${newEndDate
        .toISOString()
        .slice(0, 10)}`,
      ipAddress: meta.ipAddress,
    });

    return {
      daysCredited: days,
      newEndDate,
      freezeDaysRemaining: subscription.plan.freezeMaxDays - used,
    };
  });
}

/** Ends a freeze early, returning the days that were not actually used. */
export async function unfreezeSubscription(
  ctx: SubscriptionContext,
  permissions: ResolvedPermissions,
  input: { subscriptionId: string },
  meta: { ipAddress?: string } = {},
): Promise<{ daysReturned: number; newEndDate: Date }> {
  requirePermission(permissions, 'memberships.subscription.freeze');

  return withTenant(ctx, async (tx) => {
    const subscription = await tx.subscription.findFirst({
      where: { id: input.subscriptionId, status: 'FROZEN', deletedAt: null },
      select: {
        id: true,
        endDate: true,
        memberId: true,
        frozenDaysUsed: true,
        plan: { select: { graceDays: true } },
        freezes: {
          where: { liftedEarlyAt: null },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { id: true, fromDate: true, toDate: true, daysCredited: true },
        },
      },
    });

    if (!subscription) throw new AppError('NOT_FOUND', 'No active freeze on that membership.');

    const freeze = subscription.freezes[0];
    const now = today();

    // Only the unused tail is taken back: days already frozen were really
    // lost to the member and stay credited.
    const unused =
      freeze && now <= freeze.toDate
        ? Math.max(0, inclusiveDays(now, freeze.toDate) - 1)
        : 0;

    const newEndDate = addDays(subscription.endDate, -unused);

    await tx.subscription.update({
      where: { id: subscription.id },
      data: {
        status: 'ACTIVE',
        endDate: newEndDate,
        graceUntil: addDays(newEndDate, subscription.plan.graceDays),
        frozenDaysUsed: Math.max(0, subscription.frozenDaysUsed - unused),
        events: {
          create: {
            organizationId: ctx.organizationId,
            eventType: 'UNFROZEN',
            effectiveDate: now,
            daysDelta: -unused,
            actorUserId: ctx.userId,
          },
        },
      },
    });

    if (freeze) {
      await tx.subscriptionFreeze.update({
        where: { id: freeze.id },
        data: { liftedEarlyAt: new Date(), daysCredited: freeze.daysCredited - unused },
      });
    }

    await tx.member.update({
      where: { id: subscription.memberId },
      data: { membershipExpiresAt: newEndDate },
    });

    await writeAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'subscription.unfrozen',
      entityType: 'Subscription',
      entityId: subscription.id,
      summary: `Unfrozen; ${unused} unused ${unused === 1 ? 'day' : 'days'} returned`,
      ipAddress: meta.ipAddress,
    });

    return { daysReturned: unused, newEndDate };
  });
}

// ------------------------------------------------------------ extending ---

export async function extendSubscription(
  ctx: SubscriptionContext,
  permissions: ResolvedPermissions,
  input: { subscriptionId: string; days: number; reason: string },
  meta: { ipAddress?: string } = {},
): Promise<{ newEndDate: Date }> {
  requirePermission(permissions, 'memberships.subscription.extend');

  if (input.days === 0) {
    throw new AppError('VALIDATION_FAILED', 'Enter a number of days to add or remove.');
  }
  if (!input.reason?.trim()) {
    throw new AppError('VALIDATION_FAILED', 'Record why this membership is being changed.', [
      { field: 'reason', issue: 'Required' },
    ]);
  }

  return withTenant(ctx, async (tx) => {
    const subscription = await tx.subscription.findFirst({
      where: { id: input.subscriptionId, deletedAt: null },
      select: {
        id: true,
        endDate: true,
        memberId: true,
        plan: { select: { graceDays: true } },
      },
    });
    if (!subscription) throw new AppError('NOT_FOUND', 'Subscription not found.');

    const newEndDate = addDays(subscription.endDate, input.days);

    await tx.subscription.update({
      where: { id: subscription.id },
      data: {
        endDate: newEndDate,
        graceUntil: addDays(newEndDate, subscription.plan.graceDays),
        events: {
          create: {
            organizationId: ctx.organizationId,
            eventType: 'EXTENDED',
            effectiveDate: today(),
            daysDelta: input.days,
            reason: input.reason,
            actorUserId: ctx.userId,
          },
        },
      },
    });

    await tx.member.update({
      where: { id: subscription.memberId },
      data: { membershipExpiresAt: newEndDate },
    });

    await writeAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'subscription.extended',
      entityType: 'Subscription',
      entityId: subscription.id,
      summary: `${input.days > 0 ? '+' : ''}${input.days} days — ${input.reason}`,
      ipAddress: meta.ipAddress,
    });

    return { newEndDate };
  });
}

// ---------------------------------------------------------- cancelling ---

export async function cancelSubscription(
  ctx: SubscriptionContext,
  permissions: ResolvedPermissions,
  input: { subscriptionId: string; reason: string; refundAmount?: string },
  meta: { ipAddress?: string } = {},
): Promise<{ refundId: string | null; refundAmount: string }> {
  requirePermission(permissions, 'memberships.subscription.cancel');

  if (!input.reason?.trim()) {
    throw new AppError('VALIDATION_FAILED', 'Record why this membership is being cancelled.', [
      { field: 'reason', issue: 'Required' },
    ]);
  }

  return withTenant(ctx, async (tx) => {
    const subscription = await tx.subscription.findFirst({
      where: { id: input.subscriptionId, deletedAt: null },
      select: {
        id: true,
        status: true,
        memberId: true,
        paidAmount: true,
        totalAmount: true,
        payments: {
          where: { status: 'CAPTURED' },
          orderBy: { receivedAt: 'desc' },
          select: { id: true, amount: true, invoiceId: true },
        },
      },
    });

    if (!subscription) throw new AppError('NOT_FOUND', 'Subscription not found.');
    if (subscription.status === 'CANCELLED') {
      throw new AppError('CONFLICT', 'That membership is already cancelled.');
    }

    const refundPaise = input.refundAmount ? toPaise(input.refundAmount) : 0;
    const paidPaise = toPaise(subscription.paidAmount.toString());

    if (refundPaise > paidPaise) {
      throw new AppError(
        'VALIDATION_FAILED',
        'A refund cannot exceed what the member actually paid.',
        [{ field: 'refundAmount', issue: `Paid was ${toRupees(paidPaise)}` }],
      );
    }

    let refundId: string | null = null;

    if (refundPaise > 0) {
      requirePermission(permissions, 'finance.payment.refund');
      const source = subscription.payments[0];
      if (!source) {
        throw new AppError('CONFLICT', 'There is no captured payment to refund.');
      }

      // A refund is a new record against the original payment, never an edit
      // of it. The money moved twice and the books must show both.
      const refund = await tx.refund.create({
        data: {
          organizationId: ctx.organizationId,
          paymentId: source.id,
          invoiceId: source.invoiceId,
          amount: toRupees(refundPaise),
          status: 'APPROVED',
          reason: input.reason,
          requestedByUserId: ctx.userId,
          approvedByUserId: ctx.userId,
          approvedAt: new Date(),
        },
        select: { id: true },
      });
      refundId = refund.id;

      await tx.payment.update({
        where: { id: source.id },
        data: {
          status: refundPaise >= toPaise(source.amount.toString())
            ? 'REFUNDED'
            : 'PARTIALLY_REFUNDED',
        },
      });
    }

    await tx.subscription.update({
      where: { id: subscription.id },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelReason: input.reason,
        events: {
          create: {
            organizationId: ctx.organizationId,
            eventType: refundPaise > 0 ? 'REFUNDED' : 'CANCELLED',
            effectiveDate: today(),
            amountDelta: toRupees(-refundPaise),
            reason: input.reason,
            actorUserId: ctx.userId,
          },
        },
      },
    });

    // The member falls back to whatever other live membership they hold.
    const fallback = await tx.subscription.findFirst({
      where: {
        memberId: subscription.memberId,
        status: { in: ['ACTIVE', 'FROZEN'] },
        deletedAt: null,
        id: { not: subscription.id },
      },
      orderBy: { endDate: 'desc' },
      select: { id: true, endDate: true },
    });

    await tx.member.update({
      where: { id: subscription.memberId },
      data: {
        activeSubscriptionId: fallback?.id ?? null,
        membershipExpiresAt: fallback?.endDate ?? null,
        ...(fallback ? {} : { status: 'INACTIVE' }),
      },
    });

    await writeAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'subscription.cancelled',
      entityType: 'Subscription',
      entityId: subscription.id,
      summary: `${input.reason}${refundPaise > 0 ? ` — refunded ${toRupees(refundPaise)}` : ''}`,
      ipAddress: meta.ipAddress,
    });

    return { refundId, refundAmount: toRupees(refundPaise) };
  });
}

// ------------------------------------------------------------ transfer ---

export async function transferSubscription(
  ctx: SubscriptionContext,
  permissions: ResolvedPermissions,
  input: { subscriptionId: string; toBranchId: string; reason?: string },
  meta: { ipAddress?: string } = {},
): Promise<void> {
  requirePermission(permissions, 'memberships.subscription.transfer');

  await withTenant(ctx, async (tx) => {
    const subscription = await tx.subscription.findFirst({
      where: { id: input.subscriptionId, deletedAt: null },
      select: {
        id: true,
        branchId: true,
        memberId: true,
        plan: { select: { name: true, transferAllowed: true } },
      },
    });
    if (!subscription) throw new AppError('NOT_FOUND', 'Subscription not found.');
    if (!subscription.plan.transferAllowed) {
      throw new AppError('CONFLICT', `${subscription.plan.name} cannot be transferred.`);
    }

    const branch = await tx.branch.findFirst({
      where: { id: input.toBranchId, isActive: true, deletedAt: null },
      select: { id: true, name: true },
    });
    if (!branch) throw new AppError('NOT_FOUND', 'That branch does not exist.');

    await tx.subscription.update({
      where: { id: subscription.id },
      data: {
        branchId: branch.id,
        events: {
          create: {
            organizationId: ctx.organizationId,
            eventType: 'TRANSFERRED',
            effectiveDate: today(),
            fromBranchId: subscription.branchId,
            toBranchId: branch.id,
            reason: input.reason,
            actorUserId: ctx.userId,
          },
        },
      },
    });

    await tx.member.update({
      where: { id: subscription.memberId },
      data: { branchId: branch.id },
    });

    await writeAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'subscription.transferred',
      entityType: 'Subscription',
      entityId: subscription.id,
      summary: `Moved to ${branch.name}`,
      ipAddress: meta.ipAddress,
    });
  });
}

// ------------------------------------------------------------- expiring ---

/**
 * Marks memberships past their grace period as expired.
 *
 * Idempotent and bounded: the expiry job calls it every hour and it only
 * ever touches rows that are genuinely past their grace date, so running it
 * twice changes nothing the second time.
 */
export async function expireSubscriptions(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  options: { batchSize?: number; asOf?: Date } = {},
): Promise<{ expired: number }> {
  const asOf = options.asOf ?? today();
  const batchSize = options.batchSize ?? 500;

  const due = await db.subscription.findMany({
    where: {
      status: { in: ['ACTIVE', 'FROZEN'] },
      deletedAt: null,
      OR: [
        { graceUntil: { lt: asOf } },
        { graceUntil: null, endDate: { lt: asOf } },
      ],
    },
    select: { id: true, memberId: true, organizationId: true },
    take: batchSize,
  });

  if (due.length === 0) return { expired: 0 };

  await db.subscription.updateMany({
    where: { id: { in: due.map((row: any) => row.id) } },
    data: { status: 'EXPIRED' },
  });

  await db.subscriptionEvent.createMany({
    data: due.map((row: any) => ({
      organizationId: row.organizationId,
      subscriptionId: row.id,
      eventType: 'EXPIRED' as const,
      effectiveDate: asOf,
    })),
  });

  // Only members with no other live membership become inactive.
  for (const row of due) {
    const live = await db.subscription.findFirst({
      where: {
        memberId: row.memberId,
        status: { in: ['ACTIVE', 'FROZEN'] },
        deletedAt: null,
      },
      orderBy: { endDate: 'desc' },
      select: { id: true, endDate: true },
    });

    await db.member.update({
      where: { id: row.memberId },
      data: {
        activeSubscriptionId: live?.id ?? null,
        membershipExpiresAt: live?.endDate ?? undefined,
        ...(live ? {} : { status: 'INACTIVE' }),
      },
    });
  }

  return { expired: due.length };
}
