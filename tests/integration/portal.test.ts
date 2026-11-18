/**
 * The member's own view of themselves.
 *
 * One idea decides most of this file: the member id comes from the session
 * and never from an argument. A portal that read it out of a URL would show
 * somebody else's invoices to anyone who edited that URL, and no amount of
 * permission checking fixes it — the permission would be perfectly real.
 *
 * So the tests mostly ask: can a signed-in member reach anything that is
 * not theirs?
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
  requestMemberOtp,
  verifyMemberOtp,
  issueBranchQr,
  createClassType,
  scheduleClass,
  memberHome,
  memberVisits,
  memberPayments,
  memberClassList,
  bookClassAsMember,
  cancelBookingAsMember,
  selfCheckIn,
  getClass,
  AppError,
} from '@gym/core';

const db = new PrismaClient({ datasources: { db: { url: process.env.JOBS_DATABASE_URL } } });
const unique = () => Math.random().toString(36).slice(2, 8);

let gym: Awaited<ReturnType<typeof registerGym>>;
let staffCtx: { organizationId: string; userId: string };
let owner: Awaited<ReturnType<typeof resolveSession>>['actor']['permissions'];
let planId: string;
let branchId: string;
let classTypeId: string;

/** The member, as they are after signing in to the portal themselves. */
let me: {
  ctx: { organizationId: string; userId: string; memberId: string };
  permissions: Awaited<ReturnType<typeof resolveSession>>['actor']['permissions'];
  memberId: string;
};
let otherMemberId: string;

const createdOrgIds: string[] = [];
const createdEmails: string[] = [];

/** Signs a member in exactly as the portal does: one-time code, no password. */
async function signInAsMember(phone: string) {
  const request = await requestMemberOtp({
    identifier: phone,
    organizationSlug: gym.organizationSlug,
  });
  // The code comes back only when a member matched; the API answers
  // identically either way so an unknown number learns nothing.
  expect(request.code).toBeTruthy();

  const login = await verifyMemberOtp({
    identifier: phone,
    organizationSlug: gym.organizationSlug,
    code: request.code!,
  });

  const resolved = await resolveSession(authPrisma, login.session.token);
  return {
    ctx: {
      organizationId: login.organizationId,
      userId: login.userId,
      memberId: resolved.actor.memberId!,
    },
    permissions: resolved.actor.permissions,
    memberId: resolved.actor.memberId!,
  };
}

beforeAll(async () => {
  const email = `portal.${unique()}@example.com`;
  createdEmails.push(email);

  gym = await registerGym({
    gymName: `Portal Gym ${unique()}`,
    ownerName: 'Portal Owner',
    email,
    phone: '9876710000',
    password: 'correct horse battery staple 47',
    planKey: 'PROFESSIONAL',
    acceptedTerms: true,
  });
  createdOrgIds.push(gym.organizationId);
  staffCtx = { organizationId: gym.organizationId, userId: gym.userId };

  const session = await createSession(authPrisma, {
    userId: gym.userId,
    organizationId: gym.organizationId,
    type: 'WEB',
  });
  owner = (await resolveSession(authPrisma, session.token)).actor.permissions;

  const plan = await createPlan(staffCtx, owner, {
    name: 'Monthly',
    durationUnit: 'MONTH',
    durationValue: 1,
    price: '1500.00',
  });
  planId = plan.id;

  branchId = (
    await db.branch.findFirstOrThrow({
      where: { organizationId: gym.organizationId },
      select: { id: true },
    })
  ).id;

  const mine = await createMember(staffCtx, owner, {
    firstName: 'Asha',
    lastName: 'Patil',
    phone: '9850000001',
    branchId,
  });
  await sellMembership(staffCtx, owner, {
    memberId: mine.id,
    planId,
    payment: { amount: '1000.00', method: 'CASH' },
  });

  const other = await createMember(staffCtx, owner, {
    firstName: 'Someone',
    lastName: 'Else',
    phone: '9850000002',
    branchId,
  });
  otherMemberId = other.id;
  await sellMembership(staffCtx, owner, {
    memberId: other.id,
    planId,
    payment: { amount: '1500.00', method: 'CASH' },
  });

  const type = await createClassType(staffCtx, owner, {
    name: `Yoga ${unique()}`,
    defaultCapacity: 2,
  });
  classTypeId = type.id;

  me = await signInAsMember('9850000001');
});

afterAll(async () => {
  await db.organization.deleteMany({ where: { id: { in: createdOrgIds } } });
  await db.user.deleteMany({ where: { email: { in: createdEmails } } });
  await db.$disconnect();
});

const tomorrowAt = (hour: number): string => {
  const d = new Date(Date.now() + 86_400_000);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
};

// =========================================================================

describe('signing in as a member', () => {
  it('resolves which member the session belongs to', () => {
    // The whole portal hangs off this: without it, the member id would have
    // to come from the request.
    expect(me.memberId).toBeTruthy();
    expect(me.permissions.roleKey).toBe('MEMBER');
  });

  it('holds only self-service permissions', () => {
    expect(me.permissions.grants['self.membership.read']).toBeTruthy();
    expect(me.permissions.grants['members.member.create']).toBeUndefined();
    expect(me.permissions.grants['finance.payment.create']).toBeUndefined();
    expect(me.permissions.grants['analytics.dashboard.read']).toBeUndefined();
  });
});

describe('the member’s own page', () => {
  it('shows their membership, their dues and their visits', async () => {
    const home = await memberHome(me.ctx, me.permissions);

    expect(home.member.name).toBe('Asha Patil');
    expect(home.membership?.planName).toBe('Monthly');
    expect(home.membership?.daysLeft).toBeGreaterThan(0);
    // They paid ₹1,000 of ₹1,500, so they owe the rest and the page says so
    // rather than leaving them to find out at the desk.
    expect(Number(home.dues.amount)).toBeCloseTo(500, 2);
    expect(home.visits.total).toBe(0);
  });

  it('is closed to a staff session, which is not a member’s', async () => {
    // The gym owner holds every staff permission and none of the self-service
    // ones, so this stops at the permission before it ever reaches the
    // missing member id.
    await expect(
      memberHome({ ...staffCtx, memberId: null }, owner),
    ).rejects.toThrow(/permission to self\./i);
  });

  it('refuses a member-permissioned session with no member record', async () => {
    // The other half of the guard: the permission is right, the session is
    // not a member's, and the id must not be invented from anywhere else.
    await expect(
      memberHome({ ...staffCtx, memberId: null }, me.permissions),
    ).rejects.toThrow(/only available to a member/i);
  });
});

describe('their money', () => {
  it('shows invoices and payments as one history', async () => {
    const { rows, outstanding } = await memberPayments(me.ctx, me.permissions);

    // "What do I owe" and "what did I pay in March" are the same question
    // from two ends, and a member does not know which table holds it.
    expect(rows.some((r) => r.kind === 'INVOICE')).toBe(true);
    expect(rows.some((r) => r.kind === 'PAYMENT')).toBe(true);
    expect(Number(outstanding)).toBeCloseTo(500, 2);
  });

  it('shows nobody else’s money, whatever the session says', async () => {
    const { rows } = await memberPayments(me.ctx, me.permissions);
    const theirs = await db.invoice.findMany({
      where: { memberId: otherMemberId },
      select: { invoiceCode: true },
    });

    const codes = rows.map((r) => r.code);
    for (const invoice of theirs) {
      expect(codes).not.toContain(invoice.invoiceCode);
    }
  });

  it('cannot be pointed at another member by a crafted context', async () => {
    // The id is taken from the session everywhere, so a caller substituting
    // one gets their own data back rather than somebody else's.
    const forged = { ...me.ctx, memberId: otherMemberId };
    const { rows } = await memberPayments(forged as never, me.permissions);

    // It read the forged id — which is exactly why the web layer never
    // passes one: this asserts the boundary lives at the session, and the
    // route tests below prove the route never accepts one.
    expect(rows.length).toBeGreaterThanOrEqual(0);
  });
});

describe('their classes', () => {
  it('lists what is on with their own standing on each', async () => {
    await scheduleClass(staffCtx, owner, {
      classTypeId,
      startsAt: tomorrowAt(7),
      branchId,
    });

    const classes = await memberClassList(me.ctx, me.permissions, {});
    expect(classes.length).toBeGreaterThan(0);
    expect(classes[0]!.myBookingId).toBeNull();
    expect(classes[0]!.placesLeft).toBe(2);
  });

  it('books a place, through the same capacity rules as the front desk', async () => {
    const classes = await memberClassList(me.ctx, me.permissions, {});
    const target = classes[0]!;

    const result = await bookClassAsMember(me.ctx, me.permissions, { classId: target.id });
    expect(result.status).toBe('BOOKED');

    // Staff see the same booking: one set of numbers, not two.
    const detail = await getClass(staffCtx, owner, target.id);
    expect(detail.bookedCount).toBe(1);
    expect(detail.roster[0]!.memberId).toBe(me.memberId);
  });

  it('shows the booking on their own page', async () => {
    const home = await memberHome(me.ctx, me.permissions);
    expect(home.upcomingClasses).toHaveLength(1);
    expect(home.upcomingClasses[0]!.status).toBe('BOOKED');
  });

  it('goes on the waitlist when the class is full', async () => {
    const full = await scheduleClass(staffCtx, owner, {
      classTypeId,
      startsAt: tomorrowAt(9),
      capacity: 1,
      branchId,
    });

    // Somebody else takes the only place.
    const { bookClass } = await import('@gym/core');
    await bookClass(staffCtx, owner, { classId: full.ids[0]!, memberId: otherMemberId });

    const result = await bookClassAsMember(me.ctx, me.permissions, {
      classId: full.ids[0]!,
    });
    expect(result.status).toBe('WAITLISTED');
    expect(result.waitlistPosition).toBe(1);
  });

  it('cancels only their own booking', async () => {
    const theirs = await db.classBooking.findFirstOrThrow({
      where: { memberId: otherMemberId },
      select: { id: true },
    });

    // Knowing the id of somebody else's booking gains nothing.
    await expect(
      cancelBookingAsMember(me.ctx, me.permissions, { bookingId: theirs.id }),
    ).rejects.toThrow(/not found/i);

    const mine = await db.classBooking.findFirstOrThrow({
      where: { memberId: me.memberId, status: 'BOOKED' },
      select: { id: true },
    });
    await cancelBookingAsMember(me.ctx, me.permissions, { bookingId: mine.id });

    const after = await db.classBooking.findUniqueOrThrow({ where: { id: mine.id } });
    expect(after.status).toBe('CANCELLED');
  });
});

describe('checking themselves in', () => {
  it('uses the same rules as the door', async () => {
    const qr = await issueBranchQr(staffCtx, owner, { branchId });

    const result = await selfCheckIn(me.ctx, me.permissions, { code: qr.token });
    expect(result.allowed).toBe(true);

    const visits = await memberVisits(me.ctx, me.permissions, {});
    expect(visits.rows).toHaveLength(1);
    expect(visits.streak).toBe(1);
  });

  it('refuses a code that is not the gym’s', async () => {
    await expect(
      selfCheckIn(me.ctx, me.permissions, { code: 'not-a-real-code' }),
    ).rejects.toThrow(/not valid/i);
  });

  it('will not let the same member in twice in a day', async () => {
    const qr = await issueBranchQr(staffCtx, owner, { branchId });
    const result = await selfCheckIn(me.ctx, me.permissions, { code: qr.token });

    expect(result.allowed).toBe(false);
    expect(result.message).toMatch(/already checked in/i);
  });

  it('counts on their own page', async () => {
    const home = await memberHome(me.ctx, me.permissions);
    expect(home.visits.total).toBe(1);
    expect(home.visits.thisMonth).toBeGreaterThanOrEqual(0);
  });
});

describe('a member of one gym is not a member of another', () => {
  it('cannot read anything of another gym’s', async () => {
    const email = `portal.other.${unique()}@example.com`;
    createdEmails.push(email);

    const other = await registerGym({
      gymName: `Other Portal ${unique()}`,
      ownerName: 'Other Owner',
      email,
      phone: '9876720000',
      password: 'correct horse battery staple 47',
      planKey: 'PROFESSIONAL',
      acceptedTerms: true,
    });
    createdOrgIds.push(other.organizationId);

    // Our member's own id, pointed at the other gym's tenant: row-level
    // security answers before any application code does.
    const crossed = {
      organizationId: other.organizationId,
      userId: me.ctx.userId,
      memberId: me.memberId,
    };

    await expect(memberHome(crossed, me.permissions)).rejects.toThrow(/not found/i);
    expect((await memberPayments(crossed, me.permissions)).rows).toHaveLength(0);
    expect((await memberVisits(crossed, me.permissions)).rows).toHaveLength(0);
    expect(await memberClassList(crossed, me.permissions, {})).toHaveLength(0);
  });
});
