/**
 * The commercial side: what happens to a gym's business when they stop
 * paying us.
 *
 * Three rules are tested harder than anything else here, because they are
 * the ones a gym would judge us on:
 *
 *   Nothing is ever deleted for non-payment.
 *   A gym that has not paid can still read and export everything it has.
 *   A downgrade that would break a gym is refused with the reason, not
 *   applied and then enforced.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { authPrisma } from '@gym/db';
import {
  registerGym,
  createSession,
  resolveSession,
  createMember,
  createPlan,
  sellMembership,
  listMembers,
  getTenantBilling,
  assessPlanChange,
  changePlan,
  runBilling,
  recordTenantPayment,
  effectiveLimits,
  resolvePermissions,
  requirePermission,
  can,
  GRACE_DAYS,
  AppError,
} from '@gym/core';

const db = new PrismaClient({ datasources: { db: { url: process.env.JOBS_DATABASE_URL } } });
const unique = () => Math.random().toString(36).slice(2, 8);

let gym: Awaited<ReturnType<typeof registerGym>>;
let ctx: { organizationId: string; userId: string };
let owner: Awaited<ReturnType<typeof resolveSession>>['actor']['permissions'];
let sessionToken: string;

const createdOrgIds: string[] = [];
const createdEmails: string[] = [];

async function freshGym(planKey: string) {
  const email = `billing.${unique()}@example.com`;
  createdEmails.push(email);

  const created = await registerGym({
    gymName: `Billing Gym ${unique()}`,
    ownerName: 'Billing Owner',
    email,
    phone: '9876730000',
    password: 'correct horse battery staple 47',
    planKey: planKey as never,
    acceptedTerms: true,
  });
  createdOrgIds.push(created.organizationId);

  const session = await createSession(authPrisma, {
    userId: created.userId,
    organizationId: created.organizationId,
    type: 'WEB',
  });

  return {
    gym: created,
    ctx: { organizationId: created.organizationId, userId: created.userId },
    token: session.token,
    permissions: (await resolveSession(authPrisma, session.token)).actor.permissions,
  };
}

beforeAll(async () => {
  const built = await freshGym('GROWTH');
  gym = built.gym;
  ctx = built.ctx;
  owner = built.permissions;
  sessionToken = built.token;
});

afterAll(async () => {
  await db.organization.deleteMany({ where: { id: { in: createdOrgIds } } });
  await db.user.deleteMany({ where: { email: { in: createdEmails } } });
  await db.$disconnect();
});

// =========================================================================

describe('what a gym sees about its own subscription', () => {
  it('shows the plan, the trial and what they are using against it', async () => {
    const billing = await getTenantBilling(ctx, owner);

    expect(billing.planKey).toBe('GROWTH');
    expect(billing.status).toBe('TRIAL');
    expect(billing.trialEndsAt).not.toBeNull();
    expect(billing.daysLeft).toBeGreaterThan(0);
    expect(billing.usage.branches.used).toBe(1);
    expect(billing.usage.branches.limit).toBe(2);
    expect(billing.isReadOnly).toBe(false);
  });

  it('applies a negotiated override over the plan’s own limits', () => {
    const plan = { maxMembers: 200, maxBranches: 1, maxStaff: 5 };

    expect(effectiveLimits(plan, null)).toEqual(plan);
    // A deal struck with one gym must not need a new plan tier.
    expect(effectiveLimits(plan, { maxMembers: 500 }).maxMembers).toBe(500);
    // Explicit null means unlimited, which is different from absent.
    expect(effectiveLimits(plan, { maxMembers: null }).maxMembers).toBeNull();
  });
});

describe('changing plan', () => {
  it('names what a downgrade would cost them, before they do it', async () => {
    const assessment = await assessPlanChange(ctx, owner, { planKey: 'STARTER' });

    expect(assessment.direction).toBe('down');
    expect(assessment.allowed).toBe(true);
    // Losing a feature is not a blocker — a gym may want to stop paying for
    // it — but it is never a surprise.
    expect(assessment.losesFeatures).toContain('crm');
    expect(Number(assessment.priceDifference)).toBeLessThan(0);
  });

  it('refuses a downgrade that would break the gym, with the number', async () => {
    const small = await freshGym('GROWTH');

    // Three members, on a plan that would cover two.
    for (const phone of ['9851000001', '9851000002', '9851000003']) {
      await createMember(small.ctx, small.permissions, {
        firstName: 'Member',
        lastName: phone.slice(-4),
        phone,
      });
    }

    await db.platformPlan.update({
      where: { key: 'STARTER' },
      data: { maxMembers: 2 },
    });

    try {
      const assessment = await assessPlanChange(small.ctx, small.permissions, {
        planKey: 'STARTER',
      });

      expect(assessment.allowed).toBe(false);
      // "You have 3 members and Starter covers 2" is something a gym can
      // act on. "Cannot downgrade" is not.
      expect(assessment.blockers[0]).toMatch(/You have 3 members, and Starter covers 2/);

      await expect(
        changePlan(small.ctx, small.permissions, { planKey: 'STARTER' }),
      ).rejects.toThrow(/covers 2/);

      // And nothing moved.
      const billing = await getTenantBilling(small.ctx, small.permissions);
      expect(billing.planKey).toBe('GROWTH');
    } finally {
      await db.platformPlan.update({ where: { key: 'STARTER' }, data: { maxMembers: 200 } });
    }
  });

  it('upgrades immediately, because a gym upgrading wants the feature now', async () => {
    const result = await changePlan(ctx, owner, { planKey: 'PROFESSIONAL' });
    expect(result.direction).toBe('up');

    const billing = await getTenantBilling(ctx, owner);
    expect(billing.planKey).toBe('PROFESSIONAL');

    // The permission engine follows on the next session resolution, with no
    // deferred state for the interface and the engine to disagree about.
    const resolved = await resolveSession(authPrisma, sessionToken);
    expect(can(resolved.actor.permissions, 'content.video.manage')).toBe(true);
  });

  it('records the change against whoever made it', async () => {
    const audit = await db.auditLog.findFirst({
      where: {
        organizationId: gym.organizationId,
        action: 'platform.subscription.plan_changed',
      },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit).not.toBeNull();
    expect(audit!.actorUserId).toBe(gym.userId);
    expect(audit!.summary).toMatch(/Growth to Professional/i);
  });
});

describe('a trial that runs out', () => {
  it('is reported a week before, so somebody can ring them', async () => {
    const soon = await freshGym('GROWTH');
    await db.tenantSubscription.updateMany({
      where: { organizationId: soon.gym.organizationId },
      data: { trialEndsAt: new Date(Date.now() + 3 * 86_400_000) },
    });

    const run = await runBilling({ organizationId: soon.gym.organizationId });

    expect(run.trialsEndingSoon).toHaveLength(1);
    expect(run.trialsEnded).toBe(0);
    expect(run.trialsEndingSoon[0]!.organizationId).toBe(soon.gym.organizationId);
  });

  it('goes read-only rather than locking the gym out', async () => {
    const expired = await freshGym('GROWTH');
    const member = await createMember(expired.ctx, expired.permissions, {
      firstName: 'Still',
      lastName: 'Here',
      phone: '9852000001',
    });

    await db.tenantSubscription.updateMany({
      where: { organizationId: expired.gym.organizationId },
      data: { trialEndsAt: new Date(Date.now() - 86_400_000) },
    });

    const run = await runBilling({ organizationId: expired.gym.organizationId });
    expect(run.trialsEnded).toBe(1);
    expect(run.wentReadOnly).toBe(1);

    // Everything they entered is still there.
    const stillThere = await db.member.findUnique({ where: { id: member.id } });
    expect(stillThere).not.toBeNull();
    expect(stillThere!.deletedAt).toBeNull();

    const billing = await getTenantBilling(expired.ctx, expired.permissions);
    expect(billing.isReadOnly).toBe(true);
    expect(billing.status).toBe('PAST_DUE');
  });
});

describe('what read-only actually means', () => {
  async function readOnlyOwner() {
    const gymOwnerRole = await db.role.findFirstOrThrow({
      where: { organizationId: null, key: 'GYM_OWNER' },
      include: { permissions: { select: { permissionKey: true, scope: true } } },
    });

    return resolvePermissions({
      roleKey: 'GYM_OWNER',
      rolePermissions: gymOwnerRole.permissions,
      overrides: [],
      branchIds: [],
      planFeatures: ['members', 'memberships', 'billing', 'crm', 'classes'],
      isPlatformAdmin: false,
      isReadOnly: true,
    });
  }

  it('keeps every read, and the export', async () => {
    const permissions = await readOnlyOwner();

    expect(can(permissions, 'members.member.read')).toBe(true);
    expect(can(permissions, 'finance.invoice.read')).toBe(true);
    expect(can(permissions, 'analytics.dashboard.read')).toBe(true);
    // The way out of read-only is to get your data out or to pay, so both
    // of those have to survive it.
    expect(can(permissions, 'org.export.create')).toBe(true);
    expect(can(permissions, 'org.billing.update')).toBe(true);
  });

  it('stops every write', async () => {
    const permissions = await readOnlyOwner();

    expect(can(permissions, 'members.member.create')).toBe(false);
    expect(can(permissions, 'finance.payment.create')).toBe(false);
    expect(can(permissions, 'memberships.subscription.create')).toBe(false);
    expect(can(permissions, 'attendance.checkin.create')).toBe(false);
  });

  it('says it is about the bill, not about their permissions', async () => {
    const permissions = await readOnlyOwner();

    // Telling a gym owner "you do not have permission" sends them hunting
    // through roles for a setting that was never the problem.
    const error = (() => {
      try {
        requirePermission(permissions, 'members.member.create');
        return null;
      } catch (e) {
        return e as AppError;
      }
    })();

    expect(error?.code).toBe('ORGANIZATION_READ_ONLY');
    expect(error?.message).toMatch(/read-only until its subscription is paid/i);
    expect(error?.message).toMatch(/can be exported/i);
  });

  it('is enforced through a real session, not only in theory', async () => {
    const stopped = await freshGym('GROWTH');
    await db.tenantSubscription.updateMany({
      where: { organizationId: stopped.gym.organizationId },
      data: { isReadOnly: true, status: 'PAST_DUE' },
    });

    const session = await createSession(authPrisma, {
      userId: stopped.gym.userId,
      organizationId: stopped.gym.organizationId,
      type: 'WEB',
    });
    const resolved = await resolveSession(authPrisma, session.token);

    expect(resolved.actor.permissions.isReadOnly).toBe(true);
    expect(can(resolved.actor.permissions, 'members.member.create')).toBe(false);

    // And they can still read their own gym.
    const { rows } = await listMembers(stopped.ctx, resolved.actor.permissions, {});
    expect(Array.isArray(rows)).toBe(true);
  });
});

describe('a period that ends', () => {
  it('raises one invoice with GST on it, and only one', async () => {
    const due = await freshGym('GROWTH');

    await db.tenantSubscription.updateMany({
      where: { organizationId: due.gym.organizationId },
      data: {
        status: 'ACTIVE',
        trialEndsAt: null,
        currentPeriodEnd: new Date(Date.now() - 86_400_000),
      },
    });

    const first = await runBilling({ organizationId: due.gym.organizationId });
    expect(first.invoicesRaised).toBe(1);
    expect(first.wentPastDue).toBe(1);

    const invoice = await db.tenantInvoice.findFirstOrThrow({
      where: { organizationId: due.gym.organizationId },
    });
    // Software sold by an Indian business carries GST, and the gym needs
    // the tax invoice to claim input credit on it.
    expect(Number(invoice.subtotal)).toBeCloseTo(2999, 2);
    expect(Number(invoice.taxAmount)).toBeCloseTo(539.82, 2);
    expect(Number(invoice.total)).toBeCloseTo(3538.82, 2);

    // Running the job twice must not invoice a gym twice.
    const second = await runBilling({ organizationId: due.gym.organizationId });
    expect(second.invoicesRaised).toBe(0);
    expect(
      await db.tenantInvoice.count({ where: { organizationId: due.gym.organizationId } }),
    ).toBe(1);
  });

  it('gives them a week before anything changes for them', async () => {
    const due = await db.tenantSubscription.findFirstOrThrow({
      where: { status: 'PAST_DUE', graceUntil: { not: null } },
      select: { graceUntil: true, isReadOnly: true },
    });

    const days = Math.round((due.graceUntil!.getTime() - Date.now()) / 86_400_000);
    expect(days).toBeGreaterThanOrEqual(GRACE_DAYS - 1);
    expect(due.isReadOnly).toBe(false);
  });

  it('goes read-only only once the grace has run out', async () => {
    const lapsed = await freshGym('GROWTH');
    await db.tenantSubscription.updateMany({
      where: { organizationId: lapsed.gym.organizationId },
      data: {
        status: 'PAST_DUE',
        trialEndsAt: null,
        graceUntil: new Date(Date.now() - 86_400_000),
        isReadOnly: false,
      },
    });

    const run = await runBilling({ organizationId: lapsed.gym.organizationId });
    expect(run.wentReadOnly).toBe(1);

    const after = await db.tenantSubscription.findFirstOrThrow({
      where: { organizationId: lapsed.gym.organizationId },
    });
    expect(after.isReadOnly).toBe(true);
    // Never suspended, never deleted, by any automatic process.
    expect(after.status).toBe('PAST_DUE');
  });
});

describe('a gym that pays', () => {
  it('is back at work immediately, not after a nightly job', async () => {
    const paying = await freshGym('GROWTH');

    await db.tenantSubscription.updateMany({
      where: { organizationId: paying.gym.organizationId },
      data: {
        status: 'ACTIVE',
        trialEndsAt: null,
        currentPeriodEnd: new Date(Date.now() - 86_400_000),
      },
    });
    await runBilling({ organizationId: paying.gym.organizationId });

    const invoice = await db.tenantInvoice.findFirstOrThrow({
      where: { organizationId: paying.gym.organizationId },
    });

    const result = await recordTenantPayment({
      organizationId: paying.gym.organizationId,
      amount: invoice.total.toString(),
      razorpayPaymentId: `pay_${unique()}`,
    });

    expect(result.status).toBe('ACTIVE');
    expect(result.isReadOnly).toBe(false);

    const settled = await db.tenantInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(settled.status).toBe('PAID');
  });

  it('is not credited twice when the gateway retries', async () => {
    const paying = await freshGym('GROWTH');
    const paymentId = `pay_${unique()}`;

    await recordTenantPayment({
      organizationId: paying.gym.organizationId,
      amount: '3538.82',
      razorpayPaymentId: paymentId,
    });
    await recordTenantPayment({
      organizationId: paying.gym.organizationId,
      amount: '3538.82',
      razorpayPaymentId: paymentId,
    });

    const payments = await db.tenantPayment.count({
      where: { organizationId: paying.gym.organizationId },
    });
    expect(payments).toBe(1);
  });

  it('leaves a partly paid invoice partly paid', async () => {
    const partial = await freshGym('GROWTH');

    await db.tenantSubscription.updateMany({
      where: { organizationId: partial.gym.organizationId },
      data: {
        status: 'ACTIVE',
        trialEndsAt: null,
        currentPeriodEnd: new Date(Date.now() - 86_400_000),
      },
    });
    await runBilling({ organizationId: partial.gym.organizationId });

    const result = await recordTenantPayment({
      organizationId: partial.gym.organizationId,
      amount: '1000.00',
      razorpayPaymentId: `pay_${unique()}`,
    });

    // Half the money does not buy a whole month.
    expect(result.status).not.toBe('ACTIVE');

    const invoice = await db.tenantInvoice.findFirstOrThrow({
      where: { organizationId: partial.gym.organizationId },
    });
    expect(invoice.status).toBe('PARTIALLY_PAID');
  });
});

describe('nothing is destroyed for non-payment', () => {
  it('keeps every record through a trial ending and the grace running out', async () => {
    const abandoned = await freshGym('GROWTH');

    const plan = await createPlan(abandoned.ctx, abandoned.permissions, {
      name: 'Monthly',
      durationUnit: 'MONTH',
      durationValue: 1,
      price: '1500.00',
    });
    const member = await createMember(abandoned.ctx, abandoned.permissions, {
      firstName: 'Paid',
      lastName: 'Up',
      phone: '9853000001',
    });
    await sellMembership(abandoned.ctx, abandoned.permissions, {
      memberId: member.id,
      planId: plan.id,
      payment: { amount: '1500.00', method: 'CASH' },
    });

    await db.tenantSubscription.updateMany({
      where: { organizationId: abandoned.gym.organizationId },
      data: { trialEndsAt: new Date(Date.now() - 86_400_000) },
    });
    await runBilling({ organizationId: abandoned.gym.organizationId });

    await db.tenantSubscription.updateMany({
      where: { organizationId: abandoned.gym.organizationId },
      data: { graceUntil: new Date(Date.now() - 86_400_000) },
    });
    await runBilling({ organizationId: abandoned.gym.organizationId });

    // Deleting a customer's data because they stopped paying is a thing to
    // be incapable of, not a thing to have a policy about.
    expect(await db.member.count({ where: { organizationId: abandoned.gym.organizationId } })).toBe(1);
    expect(
      await db.invoice.count({ where: { organizationId: abandoned.gym.organizationId } }),
    ).toBe(1);
    expect(
      await db.payment.count({ where: { organizationId: abandoned.gym.organizationId } }),
    ).toBe(1);

    const organization = await db.organization.findUniqueOrThrow({
      where: { id: abandoned.gym.organizationId },
    });
    expect(organization.deletedAt).toBeNull();
  });
});
