import { getJobsClient, withPlatform, withTenant } from '@gym/db';
import { AppError } from '../errors';
import { writeAudit } from '../audit/log';
import { requirePermission, type ResolvedPermissions } from '../rbac/engine';
import { allocateInvoiceNumber } from '../shared/sequences';
import { splitTax, toPaise, toRupees } from '../shared/money';
import { startOfDay, today } from '../shared/dates';

/**
 * What a gym's own subscription does over time.
 *
 * The commercial decisions here are the ones that matter most, because they
 * decide what happens to somebody's business when they stop paying us:
 *
 * A trial that ends does not lock a gym out. It goes read-only: they keep
 * every member, every invoice and every attendance record, they can read
 * and export all of it, and they cannot take new money until they pay. A
 * product that holds a gym's records hostage is one no gym should buy.
 *
 * Nothing is ever deleted for non-payment. Not after the grace period, not
 * after a cancellation. Deleting a paying customer's data because they
 * stopped paying is a thing to be incapable of, not a thing to have a
 * policy about.
 *
 * And a downgrade that would break a gym is refused with the reason, not
 * applied and then enforced: a gym with 400 members moved onto a 200-member
 * plan must not discover it when the 201st member cannot be registered.
 */

export type SubscriptionStatus =
  | 'TRIAL'
  | 'ACTIVE'
  | 'PAST_DUE'
  | 'SUSPENDED'
  | 'CANCELLED'
  | 'EXPIRED';

/** How long after a missed payment before a gym goes read-only. */
export const GRACE_DAYS = 7;

export interface TenantBillingView {
  planKey: string;
  planName: string;
  status: SubscriptionStatus;
  billingCycle: string;
  monthlyPrice: string;
  annualPrice: string;
  trialEndsAt: string | null;
  currentPeriodEnd: string;
  graceUntil: string | null;
  isReadOnly: boolean;
  daysLeft: number;
  /** What this gym is using against what the plan allows. */
  usage: {
    members: { used: number; limit: number | null };
    branches: { used: number; limit: number | null };
    staff: { used: number; limit: number | null };
  };
  invoices: Array<{
    id: string;
    code: string;
    period: string;
    total: string;
    status: string;
    issuedOn: string;
  }>;
}

/** The limits that apply to a gym: its plan, with any negotiated override. */
export function effectiveLimits(
  plan: { maxMembers: number | null; maxBranches: number | null; maxStaff: number | null },
  overrides: unknown,
): { maxMembers: number | null; maxBranches: number | null; maxStaff: number | null } {
  const custom = (overrides ?? {}) as Record<string, number | null | undefined>;
  const pick = (key: string, fallback: number | null): number | null =>
    custom[key] === undefined ? fallback : (custom[key] ?? null);

  return {
    maxMembers: pick('maxMembers', plan.maxMembers),
    maxBranches: pick('maxBranches', plan.maxBranches),
    maxStaff: pick('maxStaff', plan.maxStaff),
  };
}

export async function getTenantBilling(
  ctx: { organizationId: string; userId: string },
  permissions: ResolvedPermissions,
): Promise<TenantBillingView> {
  requirePermission(permissions, 'org.billing.read');

  return withTenant(ctx, async (tx) => {
    const subscription = await tx.tenantSubscription.findFirst({
      select: {
        status: true,
        billingCycle: true,
        trialEndsAt: true,
        currentPeriodEnd: true,
        graceUntil: true,
        isReadOnly: true,
        limitOverrides: true,
        platformPlan: {
          select: {
            key: true,
            name: true,
            monthlyPrice: true,
            annualPrice: true,
            maxMembers: true,
            maxBranches: true,
            maxStaff: true,
          },
        },
      },
    });
    if (!subscription) throw new AppError('NOT_FOUND', 'This gym has no subscription.');

    const [members, branches, staff, invoices] = await Promise.all([
      tx.member.count({ where: { deletedAt: null } }),
      tx.branch.count({ where: { deletedAt: null } }),
      tx.orgUser.count({ where: { deletedAt: null, status: 'ACTIVE' } }),
      tx.tenantInvoice.findMany({
        orderBy: { issueDate: 'desc' },
        take: 12,
        select: {
          id: true,
          invoiceCode: true,
          periodStart: true,
          periodEnd: true,
          total: true,
          status: true,
          issueDate: true,
        },
      }),
    ]);

    const limits = effectiveLimits(subscription.platformPlan, subscription.limitOverrides);
    const until = subscription.trialEndsAt ?? subscription.currentPeriodEnd;

    return {
      planKey: subscription.platformPlan.key,
      planName: subscription.platformPlan.name,
      status: subscription.status as SubscriptionStatus,
      billingCycle: subscription.billingCycle,
      monthlyPrice: Number(subscription.platformPlan.monthlyPrice).toFixed(2),
      annualPrice: Number(subscription.platformPlan.annualPrice).toFixed(2),
      trialEndsAt: subscription.trialEndsAt
        ? subscription.trialEndsAt.toISOString().slice(0, 10)
        : null,
      currentPeriodEnd: subscription.currentPeriodEnd.toISOString().slice(0, 10),
      graceUntil: subscription.graceUntil
        ? subscription.graceUntil.toISOString().slice(0, 10)
        : null,
      isReadOnly: subscription.isReadOnly,
      daysLeft: Math.ceil((until.getTime() - Date.now()) / 86_400_000),
      usage: {
        members: { used: members, limit: limits.maxMembers },
        branches: { used: branches, limit: limits.maxBranches },
        staff: { used: staff, limit: limits.maxStaff },
      },
      invoices: invoices.map((invoice: any) => ({
        id: invoice.id,
        code: invoice.invoiceCode,
        period: `${invoice.periodStart.toISOString().slice(0, 10)} to ${invoice.periodEnd
          .toISOString()
          .slice(0, 10)}`,
        total: Number(invoice.total).toFixed(2),
        status: invoice.status,
        issuedOn: invoice.issueDate.toISOString().slice(0, 10),
      })),
    };
  });
}

export interface PlanChangeAssessment {
  allowed: boolean;
  direction: 'up' | 'down' | 'same';
  blockers: string[];
  losesFeatures: string[];
  priceDifference: string;
}

/**
 * What changing plan would actually do to this gym.
 *
 * Asked before the change, and the refusals are specific: "you have 412
 * members and Starter covers 200" is something a gym can act on. A generic
 * "cannot downgrade" is not.
 */
export async function assessPlanChange(
  ctx: { organizationId: string; userId: string },
  permissions: ResolvedPermissions,
  input: { planKey: string },
): Promise<PlanChangeAssessment> {
  requirePermission(permissions, 'org.billing.read');

  const db = getJobsClient();
  const target = await db.platformPlan.findUnique({ where: { key: input.planKey } });
  if (!target) throw new AppError('NOT_FOUND', 'That plan is not available.');

  return withTenant(ctx, async (tx) => {
    const subscription = await tx.tenantSubscription.findFirst({
      select: {
        limitOverrides: true,
        platformPlan: {
          select: {
            key: true,
            displayOrder: true,
            monthlyPrice: true,
            features: true,
            maxMembers: true,
            maxBranches: true,
            maxStaff: true,
          },
        },
      },
    });
    if (!subscription) throw new AppError('NOT_FOUND', 'This gym has no subscription.');

    const current = subscription.platformPlan;
    const direction =
      target.displayOrder > current.displayOrder
        ? 'up'
        : target.displayOrder < current.displayOrder
          ? 'down'
          : 'same';

    const [members, branches, staff] = await Promise.all([
      tx.member.count({ where: { deletedAt: null } }),
      tx.branch.count({ where: { deletedAt: null } }),
      tx.orgUser.count({ where: { deletedAt: null, status: 'ACTIVE' } }),
    ]);

    const blockers: string[] = [];
    const check = (used: number, limit: number | null, noun: string) => {
      if (limit !== null && used > limit) {
        blockers.push(
          `You have ${used} ${noun}, and ${target.name} covers ${limit}. Remove ${
            used - limit
          } first, or stay on ${current.key === target.key ? 'this plan' : current.key}.`,
        );
      }
    };

    check(members, target.maxMembers, members === 1 ? 'member' : 'members');
    check(branches, target.maxBranches, branches === 1 ? 'branch' : 'branches');
    check(staff, target.maxStaff, staff === 1 ? 'team member' : 'team members');

    // Features are not a blocker — a gym may genuinely want to stop paying
    // for the video library — but losing one silently would be a nasty
    // surprise, so they are named.
    const losesFeatures = (current.features as string[]).filter(
      (feature) => !(target.features as string[]).includes(feature),
    );

    const difference =
      toPaise(target.monthlyPrice.toString()) - toPaise(current.monthlyPrice.toString());

    return {
      allowed: blockers.length === 0,
      direction,
      blockers,
      losesFeatures,
      priceDifference: toRupees(difference),
    };
  });
}

/**
 * Moves a gym onto another plan.
 *
 * An upgrade takes effect immediately, because a gym upgrading is a gym
 * that wants the feature now. A downgrade also takes effect immediately
 * rather than at the period end: deferring it means the interface says one
 * plan and the permission engine enforces another, which nobody can
 * reason about.
 *
 * Money is deliberately not taken here. What a gym owes for a mid-period
 * change is settled on their next invoice, and no card is charged by a
 * button that says "change plan".
 */
export async function changePlan(
  ctx: { organizationId: string; userId: string },
  permissions: ResolvedPermissions,
  input: { planKey: string; reason?: string },
  meta: { ipAddress?: string } = {},
): Promise<{ planKey: string; direction: string }> {
  requirePermission(permissions, 'org.billing.update');

  const assessment = await assessPlanChange(ctx, permissions, { planKey: input.planKey });
  if (!assessment.allowed) {
    throw new AppError('PLAN_LIMIT_REACHED', assessment.blockers[0]!);
  }

  const db = getJobsClient();
  const target = await db.platformPlan.findUniqueOrThrow({ where: { key: input.planKey } });

  await withTenant(ctx, async (tx) => {
    const subscription = await tx.tenantSubscription.findFirst({
      select: { id: true, platformPlan: { select: { name: true } } },
    });
    if (!subscription) throw new AppError('NOT_FOUND', 'This gym has no subscription.');

    await tx.tenantSubscription.update({
      where: { id: subscription.id },
      data: { platformPlanId: target.id },
    });

    await writeAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'platform.subscription.plan_changed',
      entityType: 'TenantSubscription',
      entityId: subscription.id,
      summary: `Moved from ${subscription.platformPlan.name} to ${target.name}`,
      after: {
        direction: assessment.direction,
        losesFeatures: assessment.losesFeatures,
        reason: input.reason ?? null,
      },
      ipAddress: meta.ipAddress,
    });
  });

  return { planKey: target.key, direction: assessment.direction };
}

// ------------------------------------------------------- the billing run ---

export interface BillingRunResult {
  trialsEnded: number;
  invoicesRaised: number;
  wentPastDue: number;
  wentReadOnly: number;
  /** Gyms whose trial ends within the week, for somebody to ring. */
  trialsEndingSoon: Array<{ organizationId: string; name: string; endsOn: string }>;
}

/**
 * The daily run that moves subscriptions along.
 *
 * Four things, in the order a month actually happens: a trial that ran out
 * stops being a trial; a period that ended gets an invoice; an invoice that
 * went unpaid past its grace puts the gym read-only; and a trial ending
 * this week is somebody to call.
 *
 * Read-only is the strongest thing that ever happens here. Nothing is
 * suspended automatically and nothing is deleted, because the data belongs
 * to the gym and not to us.
 */
export async function runBilling(
  options: { organizationId?: string; asOf?: Date } = {},
): Promise<BillingRunResult> {
  const db = getJobsClient();
  const now = options.asOf ?? new Date();

  const result: BillingRunResult = {
    trialsEnded: 0,
    invoicesRaised: 0,
    wentPastDue: 0,
    wentReadOnly: 0,
    trialsEndingSoon: [],
  };

  const subscriptions = await db.tenantSubscription.findMany({
    where: {
      status: { in: ['TRIAL', 'ACTIVE', 'PAST_DUE'] },
      ...(options.organizationId ? { organizationId: options.organizationId } : {}),
    },
    select: {
      id: true,
      organizationId: true,
      status: true,
      billingCycle: true,
      trialEndsAt: true,
      currentPeriodStart: true,
      currentPeriodEnd: true,
      graceUntil: true,
      isReadOnly: true,
      organization: { select: { name: true, status: true } },
      platformPlan: {
        select: { id: true, name: true, monthlyPrice: true, annualPrice: true },
      },
    },
  });

  for (const subscription of subscriptions) {
    // --- a trial that ran out ------------------------------------------
    if (subscription.status === 'TRIAL' && subscription.trialEndsAt) {
      const endsIn = Math.ceil(
        (subscription.trialEndsAt.getTime() - now.getTime()) / 86_400_000,
      );

      if (endsIn > 0 && endsIn <= 7) {
        result.trialsEndingSoon.push({
          organizationId: subscription.organizationId,
          name: subscription.organization.name,
          endsOn: subscription.trialEndsAt.toISOString().slice(0, 10),
        });
        continue;
      }

      if (subscription.trialEndsAt.getTime() <= now.getTime()) {
        // The trial is over and nothing has been paid, so the gym goes
        // read-only: every record still readable and exportable, no new
        // money taken until they subscribe.
        await db.tenantSubscription.update({
          where: { id: subscription.id },
          data: {
            status: 'PAST_DUE',
            isReadOnly: true,
            graceUntil: null,
          },
        });

        await writeTenantAudit(db, subscription.organizationId, {
          action: 'platform.subscription.trial_ended',
          summary: `The trial ended; ${subscription.organization.name} is read-only until a plan is paid for`,
        });

        result.trialsEnded += 1;
        result.wentReadOnly += 1;
      }
      continue;
    }

    // --- a period that ended --------------------------------------------
    if (
      subscription.status === 'ACTIVE' &&
      subscription.currentPeriodEnd.getTime() <= now.getTime()
    ) {
      await raiseTenantInvoice(db, {
        organizationId: subscription.organizationId,
        subscriptionId: subscription.id,
        planName: subscription.platformPlan.name,
        amount:
          subscription.billingCycle === 'ANNUAL'
            ? subscription.platformPlan.annualPrice.toString()
            : subscription.platformPlan.monthlyPrice.toString(),
        periodStart: subscription.currentPeriodEnd,
        billingCycle: subscription.billingCycle,
      });

      const nextEnd = addCycle(subscription.currentPeriodEnd, subscription.billingCycle);

      await db.tenantSubscription.update({
        where: { id: subscription.id },
        data: {
          status: 'PAST_DUE',
          currentPeriodStart: subscription.currentPeriodEnd,
          currentPeriodEnd: nextEnd,
          // A week to pay before anything changes for them.
          graceUntil: new Date(now.getTime() + GRACE_DAYS * 86_400_000),
        },
      });

      result.invoicesRaised += 1;
      result.wentPastDue += 1;
      continue;
    }

    // --- an invoice nobody paid ------------------------------------------
    if (
      subscription.status === 'PAST_DUE' &&
      subscription.graceUntil &&
      subscription.graceUntil.getTime() <= now.getTime() &&
      !subscription.isReadOnly
    ) {
      await db.tenantSubscription.update({
        where: { id: subscription.id },
        data: { isReadOnly: true },
      });

      await writeTenantAudit(db, subscription.organizationId, {
        action: 'platform.subscription.read_only',
        summary: `Grace ran out; ${subscription.organization.name} is read-only until the invoice is paid`,
      });

      result.wentReadOnly += 1;
    }
  }

  return result;
}

function addCycle(from: Date, cycle: string): Date {
  const next = new Date(from);
  if (cycle === 'ANNUAL') next.setUTCFullYear(next.getUTCFullYear() + 1);
  else next.setUTCMonth(next.getUTCMonth() + 1);
  return next;
}

/** Audit rows for platform actions on a tenant, written with the jobs role. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function writeTenantAudit(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  organizationId: string,
  input: { action: string; summary: string },
): Promise<void> {
  await db.auditLog.create({
    data: {
      organizationId,
      actorUserId: null,
      isPlatformActor: true,
      action: input.action,
      entityType: 'TenantSubscription',
      entityId: organizationId,
      summary: input.summary,
    },
  });
}

/**
 * Raises what a gym owes us for a period.
 *
 * GST applies: this is a supply of software by an Indian business, and a
 * gym needs the tax invoice to claim input credit on it. Our own numbering
 * is a separate gapless series from the gym's own invoices to its members.
 */
async function raiseTenantInvoice(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  input: {
    organizationId: string;
    subscriptionId: string;
    planName: string;
    amount: string;
    periodStart: Date;
    billingCycle: string;
  },
): Promise<void> {
  const periodEnd = addCycle(input.periodStart, input.billingCycle);
  const grossPaise = toPaise(input.amount);

  // 18% GST on SaaS in India, exclusive of the listed price.
  const tax = splitTax(grossPaise, { percentage: 18 }, { inclusive: false });

  const existing = await db.tenantInvoice.findFirst({
    where: {
      organizationId: input.organizationId,
      periodStart: startOfDay(input.periodStart),
    },
    select: { id: true },
  });
  // Running the billing job twice must not invoice a gym twice.
  if (existing) return;

  const count = await db.tenantInvoice.count();
  const code = `GC/${new Date().getUTCFullYear()}/${String(count + 1).padStart(6, '0')}`;

  await db.tenantInvoice.create({
    data: {
      organizationId: input.organizationId,
      invoiceCode: code,
      periodStart: startOfDay(input.periodStart),
      periodEnd: startOfDay(periodEnd),
      subtotal: toRupees(tax.taxable),
      taxAmount: toRupees(tax.tax),
      total: toRupees(tax.total),
      status: 'ISSUED',
      issueDate: today(),
      dueDate: new Date(Date.now() + GRACE_DAYS * 86_400_000),
    },
  });
}

/**
 * Records that a gym paid us, and puts them back to work.
 *
 * Called from the platform's own Razorpay webhook, never from a request —
 * a gym marking its own subscription paid would be the obvious hole.
 */
export async function recordTenantPayment(input: {
  organizationId: string;
  amount: string;
  razorpayPaymentId?: string;
  razorpayOrderId?: string;
  method?: string;
}): Promise<{ status: SubscriptionStatus; isReadOnly: boolean }> {
  const db = getJobsClient();

  const subscription = await db.tenantSubscription.findFirst({
    where: { organizationId: input.organizationId },
    select: { id: true, billingCycle: true, currentPeriodEnd: true },
  });
  if (!subscription) throw new AppError('NOT_FOUND', 'That gym has no subscription.');

  if (input.razorpayPaymentId) {
    const already = await db.tenantPayment.findFirst({
      where: { razorpayPaymentId: input.razorpayPaymentId },
      select: { id: true },
    });
    // The gateway retries; a retry must not credit the gym twice.
    if (already) {
      const current = await db.tenantSubscription.findUniqueOrThrow({
        where: { id: subscription.id },
        select: { status: true, isReadOnly: true },
      });
      return { status: current.status as SubscriptionStatus, isReadOnly: current.isReadOnly };
    }
  }

  const outstanding = await db.tenantInvoice.findFirst({
    where: { organizationId: input.organizationId, status: { in: ['ISSUED', 'PARTIALLY_PAID'] } },
    orderBy: { issueDate: 'asc' },
    select: { id: true, total: true, amountPaid: true },
  });

  await db.tenantPayment.create({
    data: {
      organizationId: input.organizationId,
      tenantInvoiceId: outstanding?.id ?? null,
      amount: input.amount,
      method: (input.method ?? 'RAZORPAY') as never,
      status: 'CAPTURED',
      razorpayPaymentId: input.razorpayPaymentId ?? null,
      razorpayOrderId: input.razorpayOrderId ?? null,
      paidAt: new Date(),
    },
  });

  if (outstanding) {
    const paid = toPaise(outstanding.amountPaid.toString()) + toPaise(input.amount);
    const owed = toPaise(outstanding.total.toString());

    await db.tenantInvoice.update({
      where: { id: outstanding.id },
      data: {
        amountPaid: toRupees(paid),
        status: paid >= owed ? 'PAID' : 'PARTIALLY_PAID',
      },
    });
  }

  const settled = await db.tenantInvoice.count({
    where: { organizationId: input.organizationId, status: { in: ['ISSUED', 'PARTIALLY_PAID'] } },
  });

  // Back to work the moment nothing is outstanding — a gym that has paid
  // should not wait for a nightly job to be allowed to take money again.
  const data =
    settled === 0
      ? {
          status: 'ACTIVE' as never,
          isReadOnly: false,
          graceUntil: null,
          trialEndsAt: null,
        }
      : {};

  const updated = await db.tenantSubscription.update({
    where: { id: subscription.id },
    data,
    select: { status: true, isReadOnly: true },
  });

  await writeTenantAudit(db, input.organizationId, {
    action: 'platform.subscription.payment_recorded',
    summary: `Received ${input.amount}${settled === 0 ? '; the account is active again' : ''}`,
  });

  return { status: updated.status as SubscriptionStatus, isReadOnly: updated.isReadOnly };
}
