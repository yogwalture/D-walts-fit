/**
 * Classes, capacity and the waitlist.
 *
 * Two things decide whether a class timetable works in a real gym, and the
 * calendar is neither of them.
 *
 * Capacity, because two members press Book on the last place in the same
 * second. And the waitlist, because a waitlist that does not move when
 * somebody cancels is decoration: the class runs a person short while
 * someone sits at home waiting.
 *
 * So most of what follows is about those two, including a test that fires
 * genuinely concurrent bookings at the last place.
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
  freezeSubscription,
  listClassTypes,
  createClassType,
  updateClassType,
  scheduleClass,
  plannedOccurrences,
  listClasses,
  getClass,
  bookClass,
  cancelBooking,
  markAttendance,
  cancelClass,
  memberClasses,
  businessDayIso,
  AppError,
} from '@gym/core';
import { nextTestAddress } from '../support/addresses';

const db = new PrismaClient({ datasources: { db: { url: process.env.JOBS_DATABASE_URL } } });
const unique = () => Math.random().toString(36).slice(2, 8);

let gym: Awaited<ReturnType<typeof registerGym>>;
let ctx: { organizationId: string; userId: string };
let owner: Awaited<ReturnType<typeof resolveSession>>['actor']['permissions'];
let planId: string;
let yogaId: string;

const createdOrgIds: string[] = [];
const createdEmails: string[] = [];

/** A time tomorrow, so nothing in these tests is in the past mid-run. */
const tomorrowAt = (hour: number, minute = 0): string => {
  const d = new Date(Date.now() + 86_400_000);
  d.setUTCHours(hour, minute, 0, 0);
  return d.toISOString();
};

/**
 * The gym's own business day for a given instant.
 *
 * Not `businessDayIso(tz, Date.now() + a day)`: after 18:30 UTC those are
 * different days, and a test that assumes otherwise passes only between
 * midnight and half past six in the evening.
 */
const businessDayOf = (iso: string): string => businessDayIso('Asia/Kolkata', new Date(iso));

/** A paying member who may attend anything. */
async function paidMember(name: string, phone: string): Promise<string> {
  const member = await createMember(ctx, owner, {
    firstName: name,
    lastName: 'Member',
    phone,
  });
  await sellMembership(ctx, owner, {
    memberId: member.id,
    planId,
    payment: { amount: '1500.00', method: 'CASH' },
  });
  return member.id;
}

beforeAll(async () => {
  const email = `classes.${unique()}@example.com`;
  createdEmails.push(email);

  gym = await registerGym({
    gymName: `Classes Gym ${unique()}`,
    ownerName: 'Classes Owner',
    email,
    phone: '9876580000',
    password: 'correct horse battery staple 47',
    planKey: 'PROFESSIONAL',
    acceptedTerms: true,
    ipAddress: nextTestAddress(),
  });
  createdOrgIds.push(gym.organizationId);
  ctx = { organizationId: gym.organizationId, userId: gym.userId };

  const session = await createSession(authPrisma, {
    userId: gym.userId,
    organizationId: gym.organizationId,
    type: 'WEB',
  });
  owner = (await resolveSession(authPrisma, session.token)).actor.permissions;

  const plan = await createPlan(ctx, owner, {
    name: 'Monthly',
    durationUnit: 'MONTH',
    durationValue: 1,
    price: '1500.00',
  });
  planId = plan.id;

  const yoga = await createClassType(ctx, owner, {
    name: 'Yoga',
    defaultCapacity: 14,
    defaultDurationMinutes: 60,
    colorHex: '#16A34A',
  });
  yogaId = yoga.id;
});

afterAll(async () => {
  await db.organization.deleteMany({ where: { id: { in: createdOrgIds } } });
  await db.user.deleteMany({ where: { email: { in: createdEmails } } });
  await db.$disconnect();
});

// =========================================================================
//  What a gym offers
// =========================================================================

describe('class types', () => {
  it('lists what the gym offers, with how many sessions are coming up', async () => {
    const types = await listClassTypes(ctx, owner);
    const yoga = types.find((t) => t.id === yogaId)!;
    expect(yoga.name).toBe('Yoga');
    expect(yoga.defaultCapacity).toBe(14);
    expect(yoga.scheduledCount).toBe(0);
  });

  it('refuses a second class with the same name', async () => {
    await expect(createClassType(ctx, owner, { name: 'Yoga' })).rejects.toThrow(
      /already a class called Yoga/i,
    );
  });

  it('retires a class without touching the sessions already booked', async () => {
    const spin = await createClassType(ctx, owner, { name: `Spin ${unique()}`, defaultCapacity: 10 });
    const scheduled = await scheduleClass(ctx, owner, {
      classTypeId: spin.id,
      startsAt: tomorrowAt(7),
    });

    await updateClassType(ctx, owner, spin.id, { isActive: false });

    // The session stays: people have booked it, and a booking that vanishes
    // is worse than a class nobody can schedule again.
    const still = await getClass(ctx, owner, scheduled.ids[0]!);
    expect(still.status).toBe('SCHEDULED');

    // But nothing new can be put on the timetable.
    await expect(
      scheduleClass(ctx, owner, { classTypeId: spin.id, startsAt: tomorrowAt(9) }),
    ).rejects.toThrow(/retired/i);

    const visible = await listClassTypes(ctx, owner);
    expect(visible.find((t) => t.id === spin.id)).toBeUndefined();
    const all = await listClassTypes(ctx, owner, { includeInactive: true });
    expect(all.find((t) => t.id === spin.id)).toBeDefined();
  });
});

// =========================================================================
//  Putting it on the timetable
// =========================================================================

describe('scheduling', () => {
  it('schedules a single class and shows it on the day', async () => {
    const result = await scheduleClass(ctx, owner, {
      classTypeId: yogaId,
      startsAt: tomorrowAt(6, 30),
      room: `Studio ${unique()}`,
    });

    expect(result.ids).toHaveLength(1);

    const scheduled = await db.gymClass.findUniqueOrThrow({ where: { id: result.ids[0]! } });
    const day = businessDayOf(scheduled.startsAt.toISOString());
    const { rows } = await listClasses(ctx, owner, { from: day, to: day });
    const found = rows.find((r) => r.id === result.ids[0]);
    expect(found).toBeDefined();
    expect(found!.capacity).toBe(14);
    expect(found!.placesLeft).toBe(14);
  });

  it('takes the duration and capacity from the class when not told', async () => {
    const result = await scheduleClass(ctx, owner, {
      classTypeId: yogaId,
      startsAt: tomorrowAt(11),
    });
    const detail = await getClass(ctx, owner, result.ids[0]!);
    expect(detail.capacity).toBe(14);
    expect(
      (new Date(detail.endsAt).getTime() - new Date(detail.startsAt).getTime()) / 60_000,
    ).toBe(60);
  });

  it('generates a weekly class as real rows, and says how far it went', async () => {
    const start = new Date(Date.now() + 86_400_000);
    start.setUTCHours(18, 0, 0, 0);

    const result = await scheduleClass(ctx, owner, {
      classTypeId: yogaId,
      startsAt: start.toISOString(),
      repeatOn: [start.getUTCDay()],
      repeatWeeks: 4,
      room: `Hall ${unique()}`,
    });

    expect(result.ids).toHaveLength(4);
    // Nothing extends a timetable automatically on this deploy target, so a
    // manager has to be told where it stops.
    expect(result.generatedUntil).not.toBeNull();
    const until = new Date(result.generatedUntil!);
    expect(Math.round((until.getTime() - start.getTime()) / 86_400_000)).toBe(21);

    const rows = await db.gymClass.findMany({
      where: { id: { in: result.ids } },
      select: { recurrenceGroupId: true, recurrenceRule: true },
    });
    expect(new Set(rows.map((r) => r.recurrenceGroupId)).size).toBe(1);
    expect(rows[0]!.recurrenceRule).toMatch(/FREQ=WEEKLY/);
  });

  it('never generates past the horizon, however many weeks are asked for', () => {
    const start = new Date('2027-03-01T06:00:00.000Z');
    const occurrences = plannedOccurrences(start, [1], 52);
    expect(occurrences).toHaveLength(12);
  });

  it('keeps the time of day across several weekdays', () => {
    const start = new Date('2027-03-01T06:30:00.000Z'); // a Monday
    const occurrences = plannedOccurrences(start, [1, 3, 5], 2);
    expect(occurrences).toHaveLength(6);
    for (const when of occurrences) {
      expect(when.getUTCHours()).toBe(6);
      expect(when.getUTCMinutes()).toBe(30);
      expect([1, 3, 5]).toContain(when.getUTCDay());
    }
    // In order, and never before the first session.
    for (let i = 1; i < occurrences.length; i += 1) {
      expect(occurrences[i]!.getTime()).toBeGreaterThan(occurrences[i - 1]!.getTime());
    }
  });

  it('will not put a trainer in two rooms at once', async () => {
    const trainer = await db.orgUser.findFirstOrThrow({
      where: { organizationId: gym.organizationId },
      select: { id: true },
    });

    const first = await scheduleClass(ctx, owner, {
      classTypeId: yogaId,
      startsAt: tomorrowAt(14),
      trainerOrgUserId: trainer.id,
    });
    expect(first.ids).toHaveLength(1);

    // Overlapping by half an hour is still a clash.
    await expect(
      scheduleClass(ctx, owner, {
        classTypeId: yogaId,
        startsAt: tomorrowAt(14, 30),
        trainerOrgUserId: trainer.id,
      }),
    ).rejects.toThrow(/already taking/i);
  });

  it('skips the clashing week rather than failing the whole series', async () => {
    const trainer = await db.orgUser.findFirstOrThrow({
      where: { organizationId: gym.organizationId },
      select: { id: true },
    });

    const start = new Date(Date.now() + 2 * 86_400_000);
    start.setUTCHours(20, 0, 0, 0);

    // One session already in the way, three weeks out.
    const clashAt = new Date(start.getTime() + 21 * 86_400_000);
    await scheduleClass(ctx, owner, {
      classTypeId: yogaId,
      startsAt: clashAt.toISOString(),
      trainerOrgUserId: trainer.id,
    });

    const series = await scheduleClass(ctx, owner, {
      classTypeId: yogaId,
      startsAt: start.toISOString(),
      repeatOn: [start.getUTCDay()],
      repeatWeeks: 4,
      trainerOrgUserId: trainer.id,
    });

    // Generating a term of classes should not fail because the trainer is
    // busy on one of those evenings.
    expect(series.ids).toHaveLength(3);
    expect(series.skipped).toHaveLength(1);
    expect(series.skipped[0]!.reason).toMatch(/already taking/i);
  });
});

// =========================================================================
//  Capacity, which is the whole thing
// =========================================================================

describe('booking and capacity', () => {
  it('fills the places, then puts people on the waitlist in order', async () => {
    const small = await createClassType(ctx, owner, {
      name: `Pilates ${unique()}`,
      defaultCapacity: 2,
    });
    const { ids } = await scheduleClass(ctx, owner, {
      classTypeId: small.id,
      startsAt: tomorrowAt(8),
    });
    const classId = ids[0]!;

    const a = await paidMember('Asha', `98111${Math.floor(Math.random() * 90000) + 10000}`);
    const b = await paidMember('Bilal', `98112${Math.floor(Math.random() * 90000) + 10000}`);
    const c = await paidMember('Chetan', `98113${Math.floor(Math.random() * 90000) + 10000}`);
    const d = await paidMember('Divya', `98114${Math.floor(Math.random() * 90000) + 10000}`);

    const first = await bookClass(ctx, owner, { classId, memberId: a });
    expect(first.status).toBe('BOOKED');
    expect(first.placesLeft).toBe(1);

    const second = await bookClass(ctx, owner, { classId, memberId: b });
    expect(second.status).toBe('BOOKED');
    expect(second.placesLeft).toBe(0);

    const third = await bookClass(ctx, owner, { classId, memberId: c });
    expect(third.status).toBe('WAITLISTED');
    expect(third.waitlistPosition).toBe(1);

    const fourth = await bookClass(ctx, owner, { classId, memberId: d });
    expect(fourth.status).toBe('WAITLISTED');
    expect(fourth.waitlistPosition).toBe(2);

    const detail = await getClass(ctx, owner, classId);
    expect(detail.bookedCount).toBe(2);
    expect(detail.waitlistCount).toBe(2);
    expect(detail.placesLeft).toBe(0);
  });

  it('never oversells the last place, even to simultaneous requests', async () => {
    const tiny = await createClassType(ctx, owner, {
      name: `Reformer ${unique()}`,
      defaultCapacity: 1,
    });
    const { ids } = await scheduleClass(ctx, owner, {
      classTypeId: tiny.id,
      startsAt: tomorrowAt(9, 15),
    });
    const classId = ids[0]!;

    const rivals = await Promise.all([
      paidMember('Rival One', `98211${Math.floor(Math.random() * 90000) + 10000}`),
      paidMember('Rival Two', `98212${Math.floor(Math.random() * 90000) + 10000}`),
      paidMember('Rival Three', `98213${Math.floor(Math.random() * 90000) + 10000}`),
    ]);

    // The real test: three requests in flight at once for one place. Reading
    // bookedCount and writing it back would let all three in.
    const results = await Promise.all(
      rivals.map((memberId) => bookClass(ctx, owner, { classId, memberId })),
    );

    const booked = results.filter((r) => r.status === 'BOOKED');
    const waitlisted = results.filter((r) => r.status === 'WAITLISTED');
    expect(booked).toHaveLength(1);
    expect(waitlisted).toHaveLength(2);

    const row = await db.gymClass.findUniqueOrThrow({ where: { id: classId } });
    expect(row.bookedCount).toBe(1);
    expect(row.waitlistCount).toBe(2);
    expect(row.bookedCount).toBeLessThanOrEqual(row.capacity);

    // And the waitlist positions are 1 and 2, not two 1s.
    const positions = await db.classBooking.findMany({
      where: { classId, status: 'WAITLISTED' },
      select: { waitlistPosition: true },
      orderBy: { waitlistPosition: 'asc' },
    });
    expect(positions.map((p) => p.waitlistPosition)).toEqual([1, 2]);
  });

  it('refuses the same member twice', async () => {
    const { ids } = await scheduleClass(ctx, owner, {
      classTypeId: yogaId,
      startsAt: tomorrowAt(10, 45),
    });
    const memberId = await paidMember('Twice', `98311${Math.floor(Math.random() * 90000) + 10000}`);

    await bookClass(ctx, owner, { classId: ids[0]!, memberId });
    await expect(
      bookClass(ctx, owner, { classId: ids[0]!, memberId }),
    ).rejects.toThrow(/already booked/i);
  });

  it('asks the same question as the door: no membership, no class', async () => {
    const { ids } = await scheduleClass(ctx, owner, {
      classTypeId: yogaId,
      startsAt: tomorrowAt(12, 15),
    });
    const walkIn = await createMember(ctx, owner, {
      firstName: 'No',
      lastName: 'Membership',
      phone: `98411${Math.floor(Math.random() * 90000) + 10000}`,
    });

    await expect(
      bookClass(ctx, owner, { classId: ids[0]!, memberId: walkIn.id }),
    ).rejects.toThrow(/no active membership/i);

    // Deliberately, and audited — the same shape as an override at the door.
    const forced = await bookClass(ctx, owner, {
      classId: ids[0]!,
      memberId: walkIn.id,
      allowIneligible: true,
    });
    expect(forced.status).toBe('BOOKED');
  });

  it('will not let a frozen membership book a class', async () => {
    const { ids } = await scheduleClass(ctx, owner, {
      classTypeId: yogaId,
      startsAt: tomorrowAt(13, 15),
    });
    // A plan that permits a freeze, since the default Monthly does not.
    const freezable = await createPlan(ctx, owner, {
      name: `Freezable ${unique()}`,
      durationUnit: 'MONTH',
      durationValue: 1,
      price: '1500.00',
      freezeAllowed: true,
      freezeMaxDays: 30,
    });
    const member = await createMember(ctx, owner, {
      firstName: 'Frozen',
      lastName: 'Member',
      phone: `98511${Math.floor(Math.random() * 90000) + 10000}`,
    });
    await sellMembership(ctx, owner, {
      memberId: member.id,
      planId: freezable.id,
      payment: { amount: '1500.00', method: 'CASH' },
    });
    const memberId = member.id;

    const subscription = await db.subscription.findFirstOrThrow({
      where: { memberId },
      select: { id: true },
    });
    await freezeSubscription(ctx, owner, {
      subscriptionId: subscription.id,
      fromDate: businessDayIso(),
      toDate: businessDayIso('Asia/Kolkata', new Date(Date.now() + 7 * 86_400_000)),
      reason: 'Travelling',
    });

    await expect(
      bookClass(ctx, owner, { classId: ids[0]!, memberId }),
    ).rejects.toThrow(/frozen/i);
  });

  it('refuses a class that has already started', async () => {
    const past = new Date(Date.now() - 3_600_000);
    const row = await db.gymClass.create({
      data: {
        organizationId: gym.organizationId,
        classTypeId: yogaId,
        startsAt: past,
        endsAt: new Date(past.getTime() + 3_600_000),
        capacity: 10,
      },
      select: { id: true },
    });
    const memberId = await paidMember('Late', `98611${Math.floor(Math.random() * 90000) + 10000}`);

    await expect(
      bookClass(ctx, owner, { classId: row.id, memberId }),
    ).rejects.toThrow(/already started/i);
  });
});

// =========================================================================
//  The waitlist moving, which is the point of having one
// =========================================================================

describe('cancelling a booking', () => {
  it('moves the first person waiting into the free place', async () => {
    const type = await createClassType(ctx, owner, {
      name: `Zumba ${unique()}`,
      defaultCapacity: 1,
    });
    const { ids } = await scheduleClass(ctx, owner, {
      classTypeId: type.id,
      startsAt: tomorrowAt(17),
    });
    const classId = ids[0]!;

    const holder = await paidMember('Holder', `98711${Math.floor(Math.random() * 90000) + 10000}`);
    const waiting = await paidMember('Waiting', `98712${Math.floor(Math.random() * 90000) + 10000}`);
    const behind = await paidMember('Behind', `98713${Math.floor(Math.random() * 90000) + 10000}`);

    const held = await bookClass(ctx, owner, { classId, memberId: holder });
    await bookClass(ctx, owner, { classId, memberId: waiting });
    await bookClass(ctx, owner, { classId, memberId: behind });

    const result = await cancelBooking(ctx, owner, {
      bookingId: held.bookingId,
      reason: 'Work',
    });

    // The promotion is the feature: without it the class runs a person short
    // while someone sits at home on a waitlist.
    expect(result.promoted).not.toBeNull();
    expect(result.promoted!.memberId).toBe(waiting);

    const row = await db.gymClass.findUniqueOrThrow({ where: { id: classId } });
    expect(row.bookedCount).toBe(1);
    expect(row.waitlistCount).toBe(1);

    const stillWaiting = await db.classBooking.findFirstOrThrow({
      where: { classId, memberId: behind },
    });
    expect(stillWaiting.status).toBe('WAITLISTED');
    // Renumbered, so the queue reads 1 rather than 2.
    expect(stillWaiting.waitlistPosition).toBe(1);
  });

  it('frees the place when nobody is waiting', async () => {
    const { ids } = await scheduleClass(ctx, owner, {
      classTypeId: yogaId,
      startsAt: tomorrowAt(15, 30),
    });
    const memberId = await paidMember('Alone', `98811${Math.floor(Math.random() * 90000) + 10000}`);
    const booking = await bookClass(ctx, owner, { classId: ids[0]!, memberId });

    const result = await cancelBooking(ctx, owner, { bookingId: booking.bookingId });
    expect(result.promoted).toBeNull();

    const row = await db.gymClass.findUniqueOrThrow({ where: { id: ids[0]! } });
    expect(row.bookedCount).toBe(0);
  });

  it('lets a member who changed their mind twice book again', async () => {
    const { ids } = await scheduleClass(ctx, owner, {
      classTypeId: yogaId,
      startsAt: tomorrowAt(16, 15),
    });
    const memberId = await paidMember('Mind', `98911${Math.floor(Math.random() * 90000) + 10000}`);

    const first = await bookClass(ctx, owner, { classId: ids[0]!, memberId });
    await cancelBooking(ctx, owner, { bookingId: first.bookingId });

    // One row per member per class, so this must revive rather than collide
    // with the unique index.
    const again = await bookClass(ctx, owner, { classId: ids[0]!, memberId });
    expect(again.status).toBe('BOOKED');
    expect(again.bookingId).toBe(first.bookingId);

    const row = await db.gymClass.findUniqueOrThrow({ where: { id: ids[0]! } });
    expect(row.bookedCount).toBe(1);
  });

  it('leaves the booked count alone when somebody leaves the waitlist', async () => {
    const type = await createClassType(ctx, owner, {
      name: `Barre ${unique()}`,
      defaultCapacity: 1,
    });
    const { ids } = await scheduleClass(ctx, owner, {
      classTypeId: type.id,
      startsAt: tomorrowAt(18, 45),
    });

    const inside = await paidMember('Inside', `97111${Math.floor(Math.random() * 90000) + 10000}`);
    const outside = await paidMember('Outside', `97112${Math.floor(Math.random() * 90000) + 10000}`);

    await bookClass(ctx, owner, { classId: ids[0]!, memberId: inside });
    const waiting = await bookClass(ctx, owner, { classId: ids[0]!, memberId: outside });

    await cancelBooking(ctx, owner, { bookingId: waiting.bookingId });

    const row = await db.gymClass.findUniqueOrThrow({ where: { id: ids[0]! } });
    expect(row.bookedCount).toBe(1);
    expect(row.waitlistCount).toBe(0);
  });
});

// =========================================================================
//  The register
// =========================================================================

describe('the register', () => {
  it('counts a class as a gym visit', async () => {
    const { ids } = await scheduleClass(ctx, owner, {
      classTypeId: yogaId,
      startsAt: tomorrowAt(7, 15),
    });
    const memberId = await paidMember('Present', `97211${Math.floor(Math.random() * 90000) + 10000}`);
    const booking = await bookClass(ctx, owner, { classId: ids[0]!, memberId });

    const result = await markAttendance(ctx, owner, {
      bookingId: booking.bookingId,
      attended: true,
    });

    // A member who only ever comes for the 7am class would otherwise show as
    // never attending.
    expect(result.status).toBe('ATTENDED');
    expect(result.countedAsVisit).toBe(true);

    const visits = await db.attendance.findMany({ where: { memberId } });
    expect(visits).toHaveLength(1);
    expect(visits[0]!.deviceLabel).toMatch(/Class register/);
  });

  it('does not double-count a member who had already checked in', async () => {
    const { ids } = await scheduleClass(ctx, owner, {
      classTypeId: yogaId,
      startsAt: tomorrowAt(7, 45),
    });
    const memberId = await paidMember('Twice In', `97311${Math.floor(Math.random() * 90000) + 10000}`);
    const booking = await bookClass(ctx, owner, { classId: ids[0]!, memberId });

    const session = await db.gymClass.findUniqueOrThrow({ where: { id: ids[0]! } });
    const tomorrow = businessDayOf(session.startsAt.toISOString());
    await db.attendance.create({
      data: {
        organizationId: gym.organizationId,
        memberId,
        attendanceDate: new Date(`${tomorrow}T00:00:00.000Z`),
        method: 'SEARCH',
      },
    });

    const result = await markAttendance(ctx, owner, {
      bookingId: booking.bookingId,
      attended: true,
    });
    expect(result.countedAsVisit).toBe(false);

    const visits = await db.attendance.findMany({ where: { memberId } });
    expect(visits).toHaveLength(1);
  });

  it('records a no-show without inventing a visit', async () => {
    const { ids } = await scheduleClass(ctx, owner, {
      classTypeId: yogaId,
      startsAt: tomorrowAt(8, 45),
    });
    const memberId = await paidMember('Absent', `97411${Math.floor(Math.random() * 90000) + 10000}`);
    const booking = await bookClass(ctx, owner, { classId: ids[0]!, memberId });

    const result = await markAttendance(ctx, owner, {
      bookingId: booking.bookingId,
      attended: false,
    });
    expect(result.status).toBe('NO_SHOW');
    expect(await db.attendance.count({ where: { memberId } })).toBe(0);
  });

  it('shows the roster in booked-then-waitlisted order', async () => {
    const type = await createClassType(ctx, owner, {
      name: `HIIT ${unique()}`,
      defaultCapacity: 1,
    });
    const { ids } = await scheduleClass(ctx, owner, {
      classTypeId: type.id,
      startsAt: tomorrowAt(19, 30),
    });

    const inside = await paidMember('Roster In', `97511${Math.floor(Math.random() * 90000) + 10000}`);
    const outside = await paidMember('Roster Out', `97512${Math.floor(Math.random() * 90000) + 10000}`);
    await bookClass(ctx, owner, { classId: ids[0]!, memberId: inside });
    await bookClass(ctx, owner, { classId: ids[0]!, memberId: outside });

    const detail = await getClass(ctx, owner, ids[0]!);
    expect(detail.roster).toHaveLength(2);
    expect(detail.roster[0]!.status).toBe('BOOKED');
    expect(detail.roster[1]!.status).toBe('WAITLISTED');
    expect(detail.roster[0]!.memberCode).toMatch(/\w/);
  });
});

// =========================================================================
//  Cancelling a class
// =========================================================================

describe('cancelling a class', () => {
  it('cancels the bookings and says who has to be told', async () => {
    const { ids } = await scheduleClass(ctx, owner, {
      classTypeId: yogaId,
      startsAt: tomorrowAt(20, 15),
    });
    const one = await paidMember('Told One', `97611${Math.floor(Math.random() * 90000) + 10000}`);
    const two = await paidMember('Told Two', `97612${Math.floor(Math.random() * 90000) + 10000}`);
    await bookClass(ctx, owner, { classId: ids[0]!, memberId: one });
    await bookClass(ctx, owner, { classId: ids[0]!, memberId: two });

    const result = await cancelClass(ctx, owner, {
      classId: ids[0]!,
      reason: 'The trainer is unwell',
    });

    expect(result.cancelled).toBe(1);
    // Until messaging lands, this list is a person with a phone.
    expect(result.toInform.map((t) => t.memberId).sort()).toEqual([one, two].sort());
    expect(result.toInform[0]!.phone).toMatch(/^\d{10}$/);

    const detail = await getClass(ctx, owner, ids[0]!);
    expect(detail.status).toBe('CANCELLED');
    expect(detail.cancelReason).toBe('The trainer is unwell');
    expect(detail.roster).toHaveLength(0);
  });

  it('cancels the rest of a series without rewriting the past', async () => {
    const type = await createClassType(ctx, owner, { name: `Aqua ${unique()}` });
    const start = new Date(Date.now() + 86_400_000);
    start.setUTCHours(21, 0, 0, 0);

    const series = await scheduleClass(ctx, owner, {
      classTypeId: type.id,
      startsAt: start.toISOString(),
      repeatOn: [start.getUTCDay()],
      repeatWeeks: 4,
    });

    // Pretend the first one has happened and somebody attended it.
    await db.gymClass.update({
      where: { id: series.ids[0]! },
      data: {
        startsAt: new Date(Date.now() - 7 * 86_400_000),
        endsAt: new Date(Date.now() - 7 * 86_400_000 + 3_600_000),
        status: 'COMPLETED',
      },
    });

    const result = await cancelClass(ctx, owner, {
      classId: series.ids[1]!,
      reason: 'Pool repairs',
      wholeSeries: true,
    });

    // Three remaining, and the completed one is left exactly as it was.
    expect(result.cancelled).toBe(3);
    const past = await db.gymClass.findUniqueOrThrow({ where: { id: series.ids[0]! } });
    expect(past.status).toBe('COMPLETED');
    expect(past.cancelledAt).toBeNull();
  });

  it('insists on a reason', async () => {
    const { ids } = await scheduleClass(ctx, owner, {
      classTypeId: yogaId,
      startsAt: tomorrowAt(22, 15),
    });
    await expect(
      cancelClass(ctx, owner, { classId: ids[0]!, reason: '  ' }),
    ).rejects.toThrow(AppError);
  });

  it('tells each member once, however many sessions they had booked', async () => {
    const type = await createClassType(ctx, owner, { name: `Boxing ${unique()}` });
    const start = new Date(Date.now() + 2 * 86_400_000);
    start.setUTCHours(5, 30, 0, 0);

    const series = await scheduleClass(ctx, owner, {
      classTypeId: type.id,
      startsAt: start.toISOString(),
      repeatOn: [start.getUTCDay()],
      repeatWeeks: 3,
    });

    const regular = await paidMember('Regular', `97711${Math.floor(Math.random() * 90000) + 10000}`);
    for (const id of series.ids) {
      await bookClass(ctx, owner, { classId: id, memberId: regular });
    }

    const result = await cancelClass(ctx, owner, {
      classId: series.ids[0]!,
      reason: 'Trainer leaving',
      wholeSeries: true,
    });

    expect(result.cancelled).toBe(3);
    expect(result.toInform).toHaveLength(1);
  });
});

// =========================================================================
//  A member's own view
// =========================================================================

describe('a member’s classes', () => {
  it('lists what they have coming up, soonest first', async () => {
    const memberId = await paidMember('Upcoming', `97811${Math.floor(Math.random() * 90000) + 10000}`);

    const later = await scheduleClass(ctx, owner, {
      classTypeId: yogaId,
      startsAt: tomorrowAt(23, 15),
    });
    const sooner = await scheduleClass(ctx, owner, {
      classTypeId: yogaId,
      startsAt: tomorrowAt(4, 15),
    });

    await bookClass(ctx, owner, { classId: later.ids[0]!, memberId });
    await bookClass(ctx, owner, { classId: sooner.ids[0]!, memberId });

    const mine = await memberClasses(ctx, owner, memberId);
    expect(mine).toHaveLength(2);
    expect(new Date(mine[0]!.startsAt).getTime()).toBeLessThan(
      new Date(mine[1]!.startsAt).getTime(),
    );
  });
});

// =========================================================================
//  Isolation
// =========================================================================

describe('one gym’s timetable is not another’s', () => {
  it('cannot read, book onto or cancel another gym’s class', async () => {
    const email = `classes.other.${unique()}@example.com`;
    createdEmails.push(email);

    const other = await registerGym({
      gymName: `Other Classes ${unique()}`,
      ownerName: 'Other Owner',
      email,
      phone: '9876590000',
      password: 'correct horse battery staple 47',
      planKey: 'PROFESSIONAL',
      acceptedTerms: true,
    ipAddress: nextTestAddress(),
    });
    createdOrgIds.push(other.organizationId);

    const otherCtx = { organizationId: other.organizationId, userId: other.userId };
    const otherSession = await createSession(authPrisma, {
      userId: other.userId,
      organizationId: other.organizationId,
      type: 'WEB',
    });
    const otherOwner = (await resolveSession(authPrisma, otherSession.token)).actor.permissions;

    const { ids } = await scheduleClass(ctx, owner, {
      classTypeId: yogaId,
      startsAt: tomorrowAt(3, 15),
    });
    const ours = ids[0]!;
    const ourMember = await paidMember('Ours', `97911${Math.floor(Math.random() * 90000) + 10000}`);
    const booking = await bookClass(ctx, owner, { classId: ours, memberId: ourMember });

    // Knowing the id is not access.
    await expect(getClass(otherCtx, otherOwner, ours)).rejects.toThrow(/not found/i);
    await expect(
      bookClass(otherCtx, otherOwner, { classId: ours, memberId: ourMember }),
    ).rejects.toThrow(/not found/i);
    await expect(
      cancelBooking(otherCtx, otherOwner, { bookingId: booking.bookingId }),
    ).rejects.toThrow(/not found/i);
    await expect(
      cancelClass(otherCtx, otherOwner, { classId: ours, reason: 'Mischief' }),
    ).rejects.toThrow(/not found/i);
    await expect(
      markAttendance(otherCtx, otherOwner, { bookingId: booking.bookingId, attended: true }),
    ).rejects.toThrow(/not found/i);

    // And the other gym's own timetable is empty, not ours.
    const theirs = await listClasses(otherCtx, otherOwner, {});
    expect(theirs.rows).toHaveLength(0);

    // Ours is untouched by all of that.
    const still = await getClass(ctx, owner, ours);
    expect(still.status).toBe('SCHEDULED');
    expect(still.bookedCount).toBe(1);
  });
});
