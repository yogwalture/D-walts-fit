/**
 * The Super Admin console: running this as a business.
 *
 * Two things are tested harder than the rest, because they are the two that
 * would matter if this software were ever sold:
 *
 *   The console shows commercial facts and counts, never a gym's records.
 *   A gym's own owner cannot reach the console at all, however they ask.
 *
 * The rest is the sales desk: who to ring today, and the two levers —
 * extending a trial and agreeing a limit — that otherwise mean asking an
 * engineer.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  authPrisma,
  withPlatform,
  NotPlatformStaffError,
  PlatformScopeError,
} from '@gym/db';
import {
  registerGym,
  createSession,
  resolveSession,
  createMember,
  gymsNeedingAttention,
  getGymDetail,
  extendTrial,
  setLimitOverrides,
  enterTenantForSupport,
  listAudit,
  getPlatformStats,
  getTenantBilling,
  AppError,
} from '@gym/core';

const db = new PrismaClient({ datasources: { db: { url: process.env.JOBS_DATABASE_URL } } });
const unique = () => Math.random().toString(36).slice(2, 8);
const DAY = 86_400_000;

const createdOrgIds: string[] = [];
const createdEmails: string[] = [];

/** Platform staff: us. Nobody else may open a platform transaction. */
let staffUserId: string;

interface Gym {
  organizationId: string;
  userId: string;
  ctx: { organizationId: string; userId: string };
  permissions: Awaited<ReturnType<typeof resolveSession>>['actor']['permissions'];
}

async function freshGym(name: string, planKey = 'GROWTH'): Promise<Gym> {
  const email = `console.${unique()}@example.com`;
  createdEmails.push(email);

  const created = await registerGym({
    gymName: `${name} ${unique()}`,
    ownerName: 'Console Owner',
    email,
    phone: '9876740000',
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
    organizationId: created.organizationId,
    userId: created.userId,
    ctx: { organizationId: created.organizationId, userId: created.userId },
    permissions: (await resolveSession(authPrisma, session.token)).actor.permissions,
  };
}

/** Moves a subscription's clock, which is how every state below is reached. */
async function setSubscription(organizationId: string, data: Record<string, unknown>) {
  await db.tenantSubscription.updateMany({ where: { organizationId }, data: data as never });
}

beforeAll(async () => {
  const email = `platform.staff.${unique()}@example.com`;
  createdEmails.push(email);

  const staff = await db.user.create({
    data: {
      email,
      fullName: 'Platform Staff',
      status: 'ACTIVE',
      isPlatformAdmin: true,
      emailVerifiedAt: new Date(),
    },
    select: { id: true },
  });
  staffUserId = staff.id;
});

afterAll(async () => {
  await db.organization.deleteMany({ where: { id: { in: createdOrgIds } } });
  await db.user.deleteMany({ where: { email: { in: createdEmails } } });
  await db.$disconnect();
});

// =========================================================================

describe('the boundary between our console and their data', () => {
  it('refuses to open platform context for a gym’s own owner', async () => {
    const gym = await freshGym('Not Staff');

    // The route guard is not the only thing stopping this.
    await expect(getPlatformStats(gym.userId)).rejects.toThrow(NotPlatformStaffError);
    await expect(
      getGymDetail(gym.userId, gym.organizationId),
    ).rejects.toThrow(NotPlatformStaffError);
  });

  it('refuses to open platform context for staff who have left', async () => {
    const email = `ex.staff.${unique()}@example.com`;
    createdEmails.push(email);
    const ex = await db.user.create({
      data: { email, fullName: 'Former Staff', status: 'DISABLED', isPlatformAdmin: true },
      select: { id: true },
    });

    await expect(getPlatformStats(ex.id)).rejects.toThrow(NotPlatformStaffError);
  });

  it('refuses to read a gym’s members from platform context', async () => {
    const gym = await freshGym('Private');
    await createMember(gym.ctx, gym.permissions, {
      firstName: 'Private',
      lastName: 'Person',
      phone: '9876740101',
    });

    // The accidental route — the one somebody writes without thinking.
    await expect(
      withPlatform(staffUserId, async (tx: any) => tx.member.findMany({ take: 1 })),
    ).rejects.toThrow(PlatformScopeError);

    await expect(
      withPlatform(staffUserId, async (tx: any) =>
        tx.payment.findFirst({ where: { organizationId: gym.organizationId } }),
      ),
    ).rejects.toThrow(PlatformScopeError);

    await expect(
      withPlatform(staffUserId, async (tx: any) =>
        tx.member.updateMany({ where: {}, data: { firstName: 'Changed' } }),
      ),
    ).rejects.toThrow(PlatformScopeError);
  });

  it('refuses to count them there too, rather than answering a quiet zero', async () => {
    const gym = await freshGym('Counted');
    await createMember(gym.ctx, gym.permissions, {
      firstName: 'Counted',
      lastName: 'Person',
      phone: '9876740102',
    });

    // The members policy has no platform escape at all, so the database
    // would answer 0 — indistinguishable from a gym with nobody in it. The
    // console must not be able to build a figure on that.
    await expect(
      withPlatform(staffUserId, async (tx: any) =>
        tx.member.count({ where: { organizationId: gym.organizationId } }),
      ),
    ).rejects.toThrow(PlatformScopeError);

    // The honest route, which the console actually uses, still works.
    const detail = await getGymDetail(staffUserId, gym.organizationId);
    expect(detail.usage.members).toBe(1);
  });

  it('reads the commercial tables it is meant to', async () => {
    const gym = await freshGym('Commercial');

    const subscription = await withPlatform(staffUserId, async (tx: any) =>
      tx.tenantSubscription.findFirst({
        where: { organizationId: gym.organizationId },
        select: { status: true },
      }),
    );

    expect(subscription.status).toBe('TRIAL');
  });

  it('writes a row the gym owner can see when support enters their gym', async () => {
    const gym = await freshGym('Supported');

    await enterTenantForSupport({
      actorUserId: staffUserId,
      organizationId: gym.organizationId,
      reason: 'Owner asked us to check a failed payment',
    });

    const rows = await db.auditLog.findMany({
      where: { organizationId: gym.organizationId, isPlatformActor: true },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe('platform.tenant.accessed');
    expect(rows[0]!.summary).toContain('failed payment');
  });

  it('refuses a support entry with no reason recorded', async () => {
    const gym = await freshGym('Unexplained');

    await expect(
      enterTenantForSupport({
        actorUserId: staffUserId,
        organizationId: gym.organizationId,
        reason: 'look',
      }),
    ).rejects.toThrow(AppError);
  });
});

// =========================================================================

describe('who needs a call today', () => {
  it('lists a trial about to end, with somebody to ring', async () => {
    const gym = await freshGym('Deciding');
    await setSubscription(gym.organizationId, { trialEndsAt: new Date(Date.now() + 3 * DAY) });

    const list = await gymsNeedingAttention(staffUserId);
    const row = list.find((item) => item.organizationId === gym.organizationId);

    expect(row).toBeDefined();
    expect(row!.reason).toBe('trial_ending');
    expect(row!.detail).toContain('3 days');
    // A list you cannot act on is a number with extra steps.
    expect(row!.ownerEmail).toMatch(/@example\.com$/);
    // The number is in org_settings, which platform context cannot read. If
    // somebody "simplifies" that back into a nested select, this goes null.
    expect(row!.ownerPhone).toBe('9876740000');
    expect(row!.planName).toBe('Growth');
  });

  it('leaves a healthy trial alone', async () => {
    const gym = await freshGym('Happy');
    await setSubscription(gym.organizationId, { trialEndsAt: new Date(Date.now() + 25 * DAY) });

    const list = await gymsNeedingAttention(staffUserId);

    expect(list.find((item) => item.organizationId === gym.organizationId)).toBeUndefined();
  });

  it('lists a gym whose invoice is unpaid, and when they lose write access', async () => {
    const gym = await freshGym('Unpaid');
    await setSubscription(gym.organizationId, {
      status: 'PAST_DUE',
      trialEndsAt: null,
      graceUntil: new Date(Date.now() + 4 * DAY),
    });

    const row = (await gymsNeedingAttention(staffUserId)).find(
      (item) => item.organizationId === gym.organizationId,
    );

    expect(row!.reason).toBe('past_due');
    expect(row!.detail).toContain('read-only in 4 days');
  });

  it('lists a gym already read-only, and says they still have everything', async () => {
    const gym = await freshGym('Lapsed');
    await setSubscription(gym.organizationId, {
      status: 'PAST_DUE',
      trialEndsAt: null,
      isReadOnly: true,
      graceUntil: new Date(Date.now() - 9 * DAY),
    });

    const row = (await gymsNeedingAttention(staffUserId)).find(
      (item) => item.organizationId === gym.organizationId,
    );

    expect(row!.reason).toBe('read_only');
    expect(row!.detail).toContain('9 days');
    expect(row!.detail).toContain('still have everything');
  });

  it('puts the most recoverable call first', async () => {
    const tomorrow = await freshGym('Tomorrow');
    await setSubscription(tomorrow.organizationId, {
      trialEndsAt: new Date(Date.now() + 1 * DAY),
    });

    const gone = await freshGym('Long Gone');
    await setSubscription(gone.organizationId, {
      status: 'PAST_DUE',
      trialEndsAt: null,
      isReadOnly: true,
      graceUntil: new Date(Date.now() - 20 * DAY),
    });

    const list = await gymsNeedingAttention(staffUserId);
    const positionOf = (id: string) => list.findIndex((item) => item.organizationId === id);

    expect(positionOf(tomorrow.organizationId)).toBeLessThan(positionOf(gone.organizationId));
  });
});

// =========================================================================

describe('one gym, as the business sees it', () => {
  it('shows what they pay, what they use and what they have paid us', async () => {
    const gym = await freshGym('Detailed');
    await createMember(gym.ctx, gym.permissions, {
      firstName: 'Detailed',
      lastName: 'Person',
      phone: '9876740103',
    });

    const detail = await getGymDetail(staffUserId, gym.organizationId);

    expect(detail.subscription.planName).toBe('Growth');
    expect(Number(detail.subscription.monthlyPrice)).toBeGreaterThan(0);
    expect(detail.usage.members).toBe(1);
    expect(detail.usage.branches).toBe(1);
    expect(detail.usage.staff).toBe(1);
    expect(detail.ownerEmail).toMatch(/@example\.com$/);
    // Nothing paid yet: a trial.
    expect(Number(detail.lifetimeValue)).toBe(0);
  });

  it('carries no member, payment or message of theirs anywhere in it', async () => {
    const gym = await freshGym('Opaque');
    await createMember(gym.ctx, gym.permissions, {
      firstName: 'Zephaniah',
      lastName: 'Quillfeather',
      phone: '9876740104',
    });

    const detail = await getGymDetail(staffUserId, gym.organizationId);

    // Deliberately crude: the whole payload is searched for the one name we
    // know is in that gym. A future `include` that leaks it fails here.
    expect(JSON.stringify(detail)).not.toContain('Quillfeather');
    expect(JSON.stringify(detail)).not.toContain('9876740104');
  });

  it('refuses a gym that does not exist', async () => {
    await expect(
      getGymDetail(staffUserId, '00000000-0000-7000-8000-000000000000'),
    ).rejects.toThrow(AppError);
  });
});

// =========================================================================

describe('extending a trial', () => {
  it('gives them another week from today when the trial has already lapsed', async () => {
    const gym = await freshGym('Lapsed Trial');
    await setSubscription(gym.organizationId, {
      trialEndsAt: new Date(Date.now() - 5 * DAY),
      isReadOnly: true,
    });

    const { trialEndsAt } = await extendTrial({
      actorUserId: staffUserId,
      organizationId: gym.organizationId,
      days: 7,
      reason: 'Owner was away, asked for another week',
    });

    // From now, not from the date that already passed.
    const expected = new Date(Date.now() + 7 * DAY).toISOString().slice(0, 10);
    expect(trialEndsAt).toBe(expected);

    const detail = await getGymDetail(staffUserId, gym.organizationId);
    // A gym evaluating the software has to be able to use it.
    expect(detail.subscription.isReadOnly).toBe(false);
    expect(detail.subscription.status).toBe('TRIAL');
  });

  it('extends from the existing end date when the trial is still running', async () => {
    const gym = await freshGym('Live Trial');
    const endsAt = new Date(Date.now() + 10 * DAY);
    await setSubscription(gym.organizationId, { trialEndsAt: endsAt });

    const { trialEndsAt } = await extendTrial({
      actorUserId: staffUserId,
      organizationId: gym.organizationId,
      days: 5,
      reason: 'Agreed on the call',
    });

    expect(trialEndsAt).toBe(new Date(endsAt.getTime() + 5 * DAY).toISOString().slice(0, 10));
  });

  it('records the extension in the gym’s own audit log', async () => {
    const gym = await freshGym('Audited Trial');

    await extendTrial({
      actorUserId: staffUserId,
      organizationId: gym.organizationId,
      days: 14,
      reason: 'Migrating from their old system',
    });

    const rows = await db.auditLog.findMany({
      where: { organizationId: gym.organizationId, action: 'platform.trial.extended' },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.isPlatformActor).toBe(true);
    expect(rows[0]!.summary).toContain('Migrating from their old system');
  });

  it('refuses an extension with no end and one with no reason', async () => {
    const gym = await freshGym('Refused');

    await expect(
      extendTrial({
        actorUserId: staffUserId,
        organizationId: gym.organizationId,
        days: 400,
        reason: 'Because',
      }),
    ).rejects.toThrow(AppError);

    await expect(
      extendTrial({
        actorUserId: staffUserId,
        organizationId: gym.organizationId,
        days: 7,
        reason: '',
      }),
    ).rejects.toThrow(AppError);
  });
});

// =========================================================================

describe('a limit agreed with one gym', () => {
  it('raises their cap without inventing a plan everybody can buy', async () => {
    const gym = await freshGym('Negotiated');

    const before = await getTenantBilling(gym.ctx, gym.permissions);
    expect(before.usage.branches.limit).toBe(2);

    await setLimitOverrides({
      actorUserId: staffUserId,
      organizationId: gym.organizationId,
      overrides: { maxBranches: 6 },
      reason: 'Six sites, agreed at the price of Growth',
    });

    const after = await getTenantBilling(gym.ctx, gym.permissions);
    expect(after.usage.branches.limit).toBe(6);
  });

  it('puts it back on the plan when the override is cleared', async () => {
    const gym = await freshGym('Reset');

    await setLimitOverrides({
      actorUserId: staffUserId,
      organizationId: gym.organizationId,
      overrides: { maxBranches: 6 },
      reason: 'Agreed on the call',
    });
    await setLimitOverrides({
      actorUserId: staffUserId,
      organizationId: gym.organizationId,
      overrides: {},
      reason: 'Deal ended, back to the plan',
    });

    const billing = await getTenantBilling(gym.ctx, gym.permissions);
    expect(billing.usage.branches.limit).toBe(2);
  });

  it('records it in the gym’s own audit log', async () => {
    const gym = await freshGym('Audited Limit');

    await setLimitOverrides({
      actorUserId: staffUserId,
      organizationId: gym.organizationId,
      overrides: { maxMembers: null },
      reason: 'Unlimited members for the pilot',
    });

    const rows = await db.auditLog.findMany({
      where: { organizationId: gym.organizationId, action: 'platform.limits.overridden' },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.summary).toContain('maxMembers unlimited');
  });

  it('refuses a limit that is not a limit', async () => {
    const gym = await freshGym('Nonsense');

    await expect(
      setLimitOverrides({
        actorUserId: staffUserId,
        organizationId: gym.organizationId,
        overrides: { price: 0 } as never,
        reason: 'Trying it on',
      }),
    ).rejects.toThrow(AppError);
  });
});

// =========================================================================

describe('what the gym can see us doing', () => {
  it('shows the owner every platform action on their account, in their own log', async () => {
    const gym = await freshGym('Watching');

    await enterTenantForSupport({
      actorUserId: staffUserId,
      organizationId: gym.organizationId,
      reason: 'Owner rang about a duplicate payment',
    });
    await extendTrial({
      actorUserId: staffUserId,
      organizationId: gym.organizationId,
      days: 7,
      reason: 'Gave them another week',
    });
    await setLimitOverrides({
      actorUserId: staffUserId,
      organizationId: gym.organizationId,
      overrides: { maxStaff: 20 },
      reason: 'Twenty trainers agreed',
    });

    const { rows } = await listAudit(gym.ctx, gym.permissions, { platformOnly: true });
    const actions = rows.map((row) => row.action);

    expect(actions).toContain('platform.tenant.accessed');
    expect(actions).toContain('platform.trial.extended');
    expect(actions).toContain('platform.limits.overridden');

    // The reason is the part that matters: a log of bare verbs explains
    // nothing six months later.
    expect(rows.map((row) => row.summary).join(' ')).toContain('duplicate payment');
    // Which human at the vendor pressed the button is our business; that
    // the vendor did it is theirs.
    expect(rows.every((row) => row.actor === 'Platform support')).toBe(true);
  });

  it('reads legibly to the gym, without becoming a second copy of their data', async () => {
    const gym = await freshGym('No Payloads');
    await createMember(gym.ctx, gym.permissions, {
      firstName: 'Payload',
      lastName: 'Person',
      phone: '9876740105',
    });

    const { rows } = await listAudit(gym.ctx, gym.permissions, {});
    const added = rows.find((row) => row.action === 'member.created');

    // Their own log, about their own member: the summary names them, because
    // "a member was added" tells the owner nothing.
    expect(added!.summary).toContain('Payload Person');

    // The stored before/after payloads stay out of it. They hold phone
    // numbers and more, and an activity log is for accounting for actions,
    // not for browsing records a second way.
    for (const row of rows) {
      expect(row).not.toHaveProperty('beforeData');
      expect(row).not.toHaveProperty('afterData');
    }
    expect(JSON.stringify(rows)).not.toContain('9876740105');
  });

  it('shows one gym nothing of another gym’s activity', async () => {
    const mine = await freshGym('Mine');
    const theirs = await freshGym('Theirs');

    await enterTenantForSupport({
      actorUserId: staffUserId,
      organizationId: theirs.organizationId,
      reason: 'Something about their gym entirely',
    });

    const { rows } = await listAudit(mine.ctx, mine.permissions, { platformOnly: true });

    expect(rows).toHaveLength(0);
  });
});
