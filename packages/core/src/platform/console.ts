import { getJobsClient, withPlatform, withTenant } from '@gym/db';
import { AppError } from '../errors';
import { writeAudit, auditPlatformAccess } from '../audit/log';

/**
 * The Super Admin console: the business of selling the software.
 *
 * Platform figures are read through withPlatform, which opens the
 * platform-owned tables — SaaS plans, tenant subscriptions, platform billing,
 * support — and nothing operational. Reading a gym's members or payments
 * still means entering that gym explicitly, and that writes an audit row the
 * gym owner can see.
 */

export interface PlatformStats {
  gyms: { total: number; trial: number; active: number; pastDue: number; suspended: number };
  revenue: { mrr: string; arr: string; collectedThisMonth: string; outstanding: string };
  growth: { newThisMonth: number; churnedThisMonth: number };
}

export async function getPlatformStats(actorUserId: string): Promise<PlatformStats> {
  const startOfMonth = new Date();
  startOfMonth.setUTCDate(1);
  startOfMonth.setUTCHours(0, 0, 0, 0);

  return withPlatform(actorUserId, async (tx: any) => {
    const [byStatus, subscriptions, collected, outstanding, newThisMonth, churned] =
      await Promise.all([
        tx.tenantSubscription.groupBy({ by: ['status'], _count: true }),
        tx.tenantSubscription.findMany({
          where: { status: { in: ['ACTIVE', 'PAST_DUE'] } },
          select: {
            billingCycle: true,
            platformPlan: { select: { monthlyPrice: true, annualPrice: true } },
          },
          take: 5000,
        }),
        tx.tenantPayment.aggregate({
          where: { status: 'CAPTURED', paidAt: { gte: startOfMonth } },
          _sum: { amount: true },
        }),
        tx.tenantInvoice.aggregate({
          where: { status: { in: ['ISSUED', 'PARTIALLY_PAID'] } },
          _sum: { total: true, amountPaid: true },
        }),
        tx.tenantSubscription.count({ where: { createdAt: { gte: startOfMonth } } }),
        tx.tenantSubscription.count({
          where: { status: 'CANCELLED', cancelledAt: { gte: startOfMonth } },
        }),
      ]);

    const count = (status: string) =>
      byStatus.find((row: any) => row.status === status)?._count ?? 0;

    // MRR normalises annual plans to a monthly figure, which is the only way
    // the number means anything when both cycles are sold.
    const mrr = subscriptions.reduce((total: number, sub: any) => {
      const monthly =
        sub.billingCycle === 'ANNUAL'
          ? Number(sub.platformPlan.annualPrice) / 12
          : Number(sub.platformPlan.monthlyPrice);
      return total + monthly;
    }, 0);

    const due =
      Number(outstanding._sum.total ?? 0) - Number(outstanding._sum.amountPaid ?? 0);

    return {
      gyms: {
        total: byStatus.reduce((sum: number, row: any) => sum + row._count, 0),
        trial: count('TRIAL'),
        active: count('ACTIVE'),
        pastDue: count('PAST_DUE'),
        suspended: count('SUSPENDED'),
      },
      revenue: {
        mrr: mrr.toFixed(2),
        arr: (mrr * 12).toFixed(2),
        collectedThisMonth: Number(collected._sum.amount ?? 0).toFixed(2),
        outstanding: Math.max(0, due).toFixed(2),
      },
      growth: { newThisMonth, churnedThisMonth: churned },
    };
  });
}

export interface GymListRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  planName: string | null;
  subscriptionStatus: string | null;
  memberCount: number;
  createdAt: Date;
  ownerEmail: string | null;
}

export async function listGyms(
  actorUserId: string,
  options: { page?: number; pageSize?: number; search?: string; status?: string } = {},
): Promise<{ rows: GymListRow[]; total: number }> {
  const page = options.page ?? 1;
  const pageSize = Math.min(options.pageSize ?? 25, 100);
  const db = getJobsClient();

  // Counting members per gym is inherently cross-tenant, so it runs under the
  // job role rather than pretending a tenant context exists. No member data
  // is read — only how many there are.
  const where = {
    deletedAt: null,
    ...(options.status ? { status: options.status as never } : {}),
    ...(options.search
      ? {
          OR: [
            { name: { contains: options.search, mode: 'insensitive' as const } },
            { slug: { contains: options.search, mode: 'insensitive' as const } },
            { ownerEmail: { contains: options.search, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  };

  const [organizations, total] = await Promise.all([
    db.organization.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        name: true,
        slug: true,
        status: true,
        ownerEmail: true,
        createdAt: true,
        tenantSubscription: {
          select: { status: true, platformPlan: { select: { name: true } } },
        },
        _count: { select: { members: true } },
      },
    }),
    db.organization.count({ where }),
  ]);

  return {
    total,
    rows: organizations.map((org: any) => ({
      id: org.id,
      name: org.name,
      slug: org.slug,
      status: org.status,
      planName: org.tenantSubscription?.platformPlan.name ?? null,
      subscriptionStatus: org.tenantSubscription?.status ?? null,
      memberCount: org._count.members,
      createdAt: org.createdAt,
      ownerEmail: org.ownerEmail,
    })),
  };
}

/**
 * Suspending a gym closes access. It does NOT delete anything: the data stays
 * and the owner can still export it, which is both the decent thing and the
 * legally safe one.
 */
export async function setGymStatus(input: {
  actorUserId: string;
  organizationId: string;
  status: 'ACTIVE' | 'SUSPENDED';
  reason?: string;
  ipAddress?: string;
}): Promise<void> {
  const db = getJobsClient();

  const organization = await db.organization.findUnique({
    where: { id: input.organizationId },
    select: { id: true, status: true, name: true },
  });
  if (!organization) throw new AppError('NOT_FOUND', 'That gym does not exist.');

  await db.$transaction(async (tx: any) => {
    await tx.organization.update({
      where: { id: input.organizationId },
      data: { status: input.status },
    });

    await tx.tenantSubscription.updateMany({
      where: { organizationId: input.organizationId },
      data: {
        status: input.status === 'SUSPENDED' ? 'SUSPENDED' : 'ACTIVE',
        isReadOnly: input.status === 'SUSPENDED',
      },
    });

    if (input.status === 'SUSPENDED') {
      // Sessions are cut immediately; a suspension that leaves people signed
      // in for another month is not a suspension.
      await tx.session.updateMany({
        where: { organizationId: input.organizationId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
  });

  await withTenant(
    { organizationId: input.organizationId, userId: input.actorUserId, isPlatform: true },
    async (tx) =>
      writeAudit(tx, {
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        isPlatformActor: true,
        action: input.status === 'SUSPENDED' ? 'platform.gym.suspended' : 'platform.gym.activated',
        entityType: 'Organization',
        entityId: input.organizationId,
        summary: input.reason ?? `Status changed to ${input.status}`,
        before: { status: organization.status },
        after: { status: input.status },
        ipAddress: input.ipAddress,
      }),
  );
}

/**
 * Platform support entering a tenant.
 *
 * Deliberately noisy: it writes an audit row the gym owner can see in their
 * own audit log. Support access that leaves no trace is indistinguishable
 * from a breach.
 */
export async function enterTenantForSupport(input: {
  actorUserId: string;
  organizationId: string;
  reason: string;
  ipAddress?: string;
}): Promise<void> {
  if (!input.reason || input.reason.trim().length < 8) {
    throw new AppError('VALIDATION_FAILED', 'Record why you are entering this gym.', [
      { field: 'reason', issue: 'Give a reason of at least 8 characters' },
    ]);
  }

  await withTenant(
    { organizationId: input.organizationId, userId: input.actorUserId, isPlatform: true },
    async (tx) =>
      auditPlatformAccess(tx, {
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        reason: input.reason,
        ipAddress: input.ipAddress,
      }),
  );
}

// ------------------------------------------------------ who needs a call ---

export interface AttentionItem {
  organizationId: string;
  name: string;
  slug: string;
  ownerEmail: string | null;
  ownerPhone: string | null;
  planName: string;
  /** 'trial_ending' | 'past_due' | 'read_only' | 'over_limit' */
  reason: string;
  detail: string;
  /** Lower sorts first: the most urgent thing at the top. */
  urgency: number;
}

/**
 * The gyms somebody should ring today.
 *
 * Counts on a dashboard are not actionable — "three gyms past due" cannot be
 * phoned. This is the list with names and numbers, ordered by how soon it
 * stops being recoverable: a trial ending tomorrow is a sale about to be
 * lost; a gym read-only for a week has probably already gone.
 */
export async function gymsNeedingAttention(
  actorUserId: string,
  options: { limit?: number } = {},
): Promise<AttentionItem[]> {
  // Narrowed in SQL, not after the fact. A `take` over every trial in the
  // database would drop whichever gyms the planner happened to return last,
  // and a call list that silently omits people is worse than no call list.
  const horizon = new Date(Date.now() + 7 * 86_400_000);

  return withPlatform(actorUserId, async (tx: any) => {
    const subscriptions = await tx.tenantSubscription.findMany({
      where: {
        // Suspended gyms are our own decision, not a sale to rescue.
        status: { not: 'SUSPENDED' },
        OR: [
          { status: 'TRIAL', trialEndsAt: { lte: horizon } },
          { status: 'PAST_DUE' },
          { isReadOnly: true },
        ],
      },
      orderBy: [{ trialEndsAt: 'asc' }, { graceUntil: 'asc' }],
      take: Math.min(options.limit ?? 50, 200),
      select: {
        organizationId: true,
        status: true,
        trialEndsAt: true,
        graceUntil: true,
        isReadOnly: true,
        platformPlan: { select: { name: true, maxMembers: true } },
        organization: { select: { name: true, slug: true, ownerEmail: true } },
      },
    });

    // The contact number lives in org_settings, which platform context
    // cannot read: its RLS policy has no platform escape, and a nested
    // select there would come back null rather than refusing. Read through
    // the job role instead, one column, for the gyms already in hand.
    const phones = await contactPhonesFor(
      subscriptions.map((row: any) => row.organizationId),
    );

    const items: AttentionItem[] = [];

    for (const subscription of subscriptions) {
      const base = {
        organizationId: subscription.organizationId,
        name: subscription.organization.name,
        slug: subscription.organization.slug,
        ownerEmail: subscription.organization.ownerEmail,
        ownerPhone: phones.get(subscription.organizationId) ?? null,
        planName: subscription.platformPlan.name,
      };

      if (subscription.isReadOnly) {
        const since = subscription.graceUntil ?? subscription.trialEndsAt;
        const days = since
          ? Math.floor((Date.now() - since.getTime()) / 86_400_000)
          : 0;
        items.push({
          ...base,
          reason: 'read_only',
          detail:
            days > 0
              ? `Read-only for ${days} ${days === 1 ? 'day' : 'days'}. They still have everything.`
              : 'Read-only. They still have everything.',
          // Urgent, but less recoverable than a trial about to lapse.
          urgency: 20 + Math.min(days, 30),
        });
        continue;
      }

      if (subscription.status === 'PAST_DUE' && subscription.graceUntil) {
        const days = Math.ceil((subscription.graceUntil.getTime() - Date.now()) / 86_400_000);
        items.push({
          ...base,
          reason: 'past_due',
          detail: `Invoice unpaid. Goes read-only in ${days} ${days === 1 ? 'day' : 'days'}.`,
          urgency: 10 + Math.max(0, days),
        });
        continue;
      }

      if (subscription.status === 'TRIAL' && subscription.trialEndsAt) {
        const days = Math.ceil((subscription.trialEndsAt.getTime() - Date.now()) / 86_400_000);
        items.push({
          ...base,
          reason: 'trial_ending',
          detail:
            days <= 0
              ? 'Trial has ended.'
              : `Trial ends in ${days} ${days === 1 ? 'day' : 'days'}.`,
          // A trial ending tomorrow is the most recoverable thing here.
          urgency: Math.max(0, days),
        });
      }
    }

    return items.sort((a, b) => a.urgency - b.urgency);
  });
}

export interface GymDetail {
  id: string;
  name: string;
  slug: string;
  status: string;
  createdAt: string;
  ownerEmail: string | null;
  ownerPhone: string | null;
  city: string | null;
  subscription: {
    planKey: string;
    planName: string;
    status: string;
    billingCycle: string;
    trialEndsAt: string | null;
    currentPeriodEnd: string;
    graceUntil: string | null;
    isReadOnly: boolean;
    monthlyPrice: string;
    limitOverrides: Record<string, number | null> | null;
  };
  /** Counts only. Reading a gym's actual records means entering the tenant. */
  usage: { members: number; branches: number; staff: number; classes: number };
  invoices: Array<{
    code: string;
    period: string;
    total: string;
    status: string;
    issuedOn: string;
  }>;
  lifetimeValue: string;
}

/**
 * One gym, as the business sees it.
 *
 * Deliberately commercial: what they pay, what they use, what they owe. No
 * member names, no member payments, no messages. Reading a gym's actual
 * records is a separate, explicit act that writes an audit row the gym
 * owner can see.
 */
export async function getGymDetail(
  actorUserId: string,
  organizationId: string,
): Promise<GymDetail> {
  const [contact, usage] = await Promise.all([
    contactFor(organizationId),
    usageCountsFor(organizationId),
  ]);

  return withPlatform(actorUserId, async (tx: any) => {
    const organization = await tx.organization.findUnique({
      where: { id: organizationId },
      select: {
        id: true,
        name: true,
        slug: true,
        status: true,
        createdAt: true,
        ownerEmail: true,
        tenantSubscription: {
          select: {
            status: true,
            billingCycle: true,
            trialEndsAt: true,
            currentPeriodEnd: true,
            graceUntil: true,
            isReadOnly: true,
            limitOverrides: true,
            platformPlan: { select: { key: true, name: true, monthlyPrice: true } },
          },
        },
      },
    });
    if (!organization) throw new AppError('NOT_FOUND', 'That gym was not found.');

    const [invoices, paid] = await Promise.all([
      tx.tenantInvoice.findMany({
        where: { organizationId },
        orderBy: { issueDate: 'desc' },
        take: 12,
        select: {
          invoiceCode: true,
          periodStart: true,
          periodEnd: true,
          total: true,
          status: true,
          issueDate: true,
        },
      }),
      tx.tenantPayment.aggregate({
        where: { organizationId, status: 'CAPTURED' },
        _sum: { amount: true },
      }),
    ]);

    const subscription = organization.tenantSubscription;
    if (!subscription) throw new AppError('NOT_FOUND', 'That gym has no subscription.');

    return {
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      status: organization.status,
      createdAt: organization.createdAt.toISOString().slice(0, 10),
      ownerEmail: organization.ownerEmail,
      ownerPhone: contact.phone,
      city: contact.city,
      subscription: {
        planKey: subscription.platformPlan.key,
        planName: subscription.platformPlan.name,
        status: subscription.status,
        billingCycle: subscription.billingCycle,
        trialEndsAt: subscription.trialEndsAt
          ? subscription.trialEndsAt.toISOString().slice(0, 10)
          : null,
        currentPeriodEnd: subscription.currentPeriodEnd.toISOString().slice(0, 10),
        graceUntil: subscription.graceUntil
          ? subscription.graceUntil.toISOString().slice(0, 10)
          : null,
        isReadOnly: subscription.isReadOnly,
        monthlyPrice: Number(subscription.platformPlan.monthlyPrice).toFixed(2),
        limitOverrides: (subscription.limitOverrides ?? null) as Record<
          string,
          number | null
        > | null,
      },
      usage,
      invoices: invoices.map((invoice: any) => ({
        code: invoice.invoiceCode,
        period: `${invoice.periodStart.toISOString().slice(0, 10)} to ${invoice.periodEnd
          .toISOString()
          .slice(0, 10)}`,
        total: Number(invoice.total).toFixed(2),
        status: invoice.status,
        issuedOn: invoice.issueDate.toISOString().slice(0, 10),
      })),
      lifetimeValue: Number(paid._sum.amount ?? 0).toFixed(2),
    };
  });
}

/**
 * Extends a gym's trial.
 *
 * The commonest sales action there is, and the console had no way to do it:
 * somebody asks for another week to decide, and the answer should not be
 * "I will ask an engineer". Capped, because an unlimited extension is a
 * free account nobody ever revisits.
 */
export async function extendTrial(input: {
  actorUserId: string;
  organizationId: string;
  days: number;
  reason: string;
  ipAddress?: string;
}): Promise<{ trialEndsAt: string }> {
  if (input.days < 1 || input.days > 60) {
    throw new AppError('VALIDATION_FAILED', 'A trial is extended by 1 to 60 days.', [
      { field: 'days', issue: 'Between 1 and 60' },
    ]);
  }
  if (!input.reason || input.reason.trim().length < 4) {
    throw new AppError('VALIDATION_FAILED', 'Record why the trial is being extended.', [
      { field: 'reason', issue: 'Give a reason' },
    ]);
  }

  const result = await withPlatform(input.actorUserId, async (tx: any) => {
    const subscription = await tx.tenantSubscription.findFirst({
      where: { organizationId: input.organizationId },
      select: { id: true, trialEndsAt: true, status: true },
    });
    if (!subscription) throw new AppError('NOT_FOUND', 'That gym has no subscription.');

    // Extended from today where the trial already lapsed, rather than from
    // the old date — "another week" means a week from now.
    const from =
      subscription.trialEndsAt && subscription.trialEndsAt.getTime() > Date.now()
        ? subscription.trialEndsAt
        : new Date();
    const trialEndsAt = new Date(from.getTime() + input.days * 86_400_000);

    await tx.tenantSubscription.update({
      where: { id: subscription.id },
      data: {
        trialEndsAt,
        status: 'TRIAL',
        // Back to work while they decide: a gym on an extended trial that
        // stayed read-only would be evaluating a product it cannot use.
        isReadOnly: false,
        graceUntil: null,
      },
    });

    return { subscriptionId: subscription.id, trialEndsAt };
  });

  // Audited inside the gym's own log, not ours: an extension granted on
  // their behalf is something they are entitled to see. Written through
  // withTenant because the platform client refuses writes to their tables.
  await writeTenantAuditRow({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    action: 'platform.trial.extended',
    entityId: result.subscriptionId,
    summary: `Trial extended by ${input.days} days — ${input.reason.trim()}`,
    ipAddress: input.ipAddress,
  });

  return { trialEndsAt: result.trialEndsAt.toISOString().slice(0, 10) };
}

/** One audit row in a gym's own log, written by platform staff. */
async function writeTenantAuditRow(input: {
  organizationId: string;
  actorUserId: string;
  action: string;
  entityId: string;
  summary: string;
  ipAddress?: string;
}): Promise<void> {
  await withTenant(
    { organizationId: input.organizationId, userId: input.actorUserId, isPlatform: true },
    async (tx) =>
      writeAudit(tx, {
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        isPlatformActor: true,
        action: input.action,
        entityType: 'TenantSubscription',
        entityId: input.entityId,
        summary: input.summary,
        ipAddress: input.ipAddress,
      }),
  );
}

/**
 * Sets negotiated limits for one gym.
 *
 * A deal struck with a single customer should not need a new plan tier that
 * everybody else can then see and buy. Written to the subscription and read
 * by `effectiveLimits`, and audited inside that gym's own log — they can
 * see what was agreed on their behalf.
 */
export async function setLimitOverrides(input: {
  actorUserId: string;
  organizationId: string;
  overrides: Record<string, number | null>;
  reason: string;
  ipAddress?: string;
}): Promise<void> {
  const allowed = new Set(['maxMembers', 'maxBranches', 'maxStaff']);
  for (const key of Object.keys(input.overrides)) {
    if (!allowed.has(key)) {
      throw new AppError('VALIDATION_FAILED', `${key} is not a limit that can be overridden.`);
    }
  }
  if (!input.reason || input.reason.trim().length < 4) {
    throw new AppError('VALIDATION_FAILED', 'Record why these limits were agreed.', [
      { field: 'reason', issue: 'Give a reason' },
    ]);
  }

  const subscriptionId = await withPlatform(input.actorUserId, async (tx: any) => {
    const subscription = await tx.tenantSubscription.findFirst({
      where: { organizationId: input.organizationId },
      select: { id: true },
    });
    if (!subscription) throw new AppError('NOT_FOUND', 'That gym has no subscription.');

    await tx.tenantSubscription.update({
      where: { id: subscription.id },
      data: {
        limitOverrides: Object.keys(input.overrides).length > 0 ? input.overrides : null,
      },
    });

    return subscription.id as string;
  });

  await writeTenantAuditRow({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    action: 'platform.limits.overridden',
    entityId: subscriptionId,
    summary: `Limits agreed: ${
      Object.entries(input.overrides)
        .map(([key, value]) => `${key} ${value ?? 'unlimited'}`)
        .join(', ') || 'back to the plan'
    } — ${input.reason.trim()}`,
    ipAddress: input.ipAddress,
  });
}

// ------------------------------------------- what the job role reads for us ---
//
// Three things the console needs sit behind policies with no platform escape:
// a gym's contact number, their town, and how much of their plan they are
// using. All three are facts about the account we bill, not about anybody who
// trains there, so they are read under the job role — the same role and the
// same reasoning as the member count on the gym list.
//
// The rule these helpers keep: counts and the account holder's own contact
// details. Never a member, a payment, a message or an attendance row. If a
// future column does not fit that sentence, it does not belong in here.

/** The account holder's phone and town, for the gyms already in hand. */
async function contactPhonesFor(organizationIds: string[]): Promise<Map<string, string>> {
  if (organizationIds.length === 0) return new Map();

  const rows = await getJobsClient().orgSetting.findMany({
    where: { organizationId: { in: organizationIds } },
    select: { organizationId: true, contactPhone: true },
    // Bounded by the ids handed in, which come from an already-capped read.
    take: organizationIds.length,
  });

  return new Map(
    rows
      .filter((row: any) => row.contactPhone)
      .map((row: any) => [row.organizationId, row.contactPhone as string]),
  );
}

async function contactFor(
  organizationId: string,
): Promise<{ phone: string | null; city: string | null }> {
  const settings = await getJobsClient().orgSetting.findFirst({
    where: { organizationId },
    select: { contactPhone: true, legalAddress: true },
  });

  const address = (settings?.legalAddress ?? {}) as { city?: string };
  return { phone: settings?.contactPhone ?? null, city: address.city ?? null };
}

/** How much of the plan they are using. Counts only: these name nobody. */
async function usageCountsFor(organizationId: string): Promise<GymDetail['usage']> {
  const db = getJobsClient();

  const [members, branches, staff, classes] = await Promise.all([
    db.member.count({ where: { organizationId, deletedAt: null } }),
    db.branch.count({ where: { organizationId, deletedAt: null } }),
    db.orgUser.count({ where: { organizationId, deletedAt: null, status: 'ACTIVE' } }),
    db.gymClass.count({ where: { organizationId, cancelledAt: null } }),
  ]);

  return { members, branches, staff, classes };
}
