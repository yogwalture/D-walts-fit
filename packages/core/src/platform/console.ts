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
