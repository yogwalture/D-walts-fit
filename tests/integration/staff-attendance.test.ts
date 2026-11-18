/**
 * Staff attendance, the rota and leave.
 *
 * These are one thing rather than three, and the tests are mostly about the
 * seams between them: approved leave has to write the attendance for those
 * days, or the register shows a sanctioned absence as an unexplained one
 * and whoever runs payroll docks a day the gym already agreed to.
 *
 * And nobody approves their own leave, however senior.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { authPrisma } from '@gym/db';
import {
  registerGym,
  createSession,
  resolveSession,
  inviteStaff,
  acceptInvitation,
  staffDay,
  markStaffAttendance,
  staffAttendanceSummary,
  listShifts,
  setShift,
  removeShift,
  requestLeave,
  decideLeave,
  listLeave,
  businessDayIso,
  AppError,
} from '@gym/core';

const db = new PrismaClient({ datasources: { db: { url: process.env.JOBS_DATABASE_URL } } });
const unique = () => Math.random().toString(36).slice(2, 8);
const iso = (offsetDays: number) =>
  new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

let gym: Awaited<ReturnType<typeof registerGym>>;
let ctx: { organizationId: string; userId: string };
let owner: Awaited<ReturnType<typeof resolveSession>>['actor']['permissions'];
let trainerOrgUserId: string;
let trainerUserId: string;
let ownerOrgUserId: string;

const createdOrgIds: string[] = [];
const createdEmails: string[] = [];

async function addTeamMember(
  email: string,
  fullName: string,
  roleKey: string,
  branchIds: string[] = [],
) {
  const role = await db.role.findFirstOrThrow({
    where: { organizationId: null, key: roleKey },
    select: { id: true },
  });

  const invitation = await inviteStaff({
    organizationId: gym.organizationId,
    email,
    fullName,
    roleId: role.id,
    branchIds,
    invitedByUserId: gym.userId,
  });
  await acceptInvitation({
    token: invitation.token,
    fullName,
    password: 'correct horse battery staple 47',
  });

  const orgUser = await db.orgUser.findFirstOrThrow({
    where: { organizationId: gym.organizationId, user: { email } },
    select: { id: true, userId: true },
  });
  return orgUser;
}

beforeAll(async () => {
  const email = `rota.${unique()}@example.com`;
  createdEmails.push(email);

  gym = await registerGym({
    gymName: `Rota Gym ${unique()}`,
    ownerName: 'Rota Owner',
    email,
    phone: '9876630000',
    password: 'correct horse battery staple 47',
    planKey: 'PROFESSIONAL',
    acceptedTerms: true,
  });
  createdOrgIds.push(gym.organizationId);
  ctx = { organizationId: gym.organizationId, userId: gym.userId };

  const session = await createSession(authPrisma, {
    userId: gym.userId,
    organizationId: gym.organizationId,
    type: 'WEB',
  });
  owner = (await resolveSession(authPrisma, session.token)).actor.permissions;

  const trainerEmail = `trainer.${unique()}@example.com`;
  createdEmails.push(trainerEmail);
  const trainer = await addTeamMember(trainerEmail, 'Suresh Pawar', 'TRAINER');
  trainerOrgUserId = trainer.id;
  trainerUserId = trainer.userId;

  ownerOrgUserId = (
    await db.orgUser.findFirstOrThrow({
      where: { organizationId: gym.organizationId, userId: gym.userId },
      select: { id: true },
    })
  ).id;
});

afterAll(async () => {
  await db.organization.deleteMany({ where: { id: { in: createdOrgIds } } });
  await db.user.deleteMany({ where: { email: { in: createdEmails } } });
  await db.$disconnect();
});

// =========================================================================
//  Who is in
// =========================================================================

describe('the staff register', () => {
  it('lists everybody, not only those who turned up', async () => {
    const day = await staffDay(ctx, owner, {});
    // At 10am the useful question is who has NOT arrived, and a list of
    // people who are present cannot answer it.
    expect(day.rows.length).toBeGreaterThanOrEqual(2);
    expect(day.rows.every((row) => row.status === null)).toBe(true);
    expect(day.rows.map((r) => r.fullName)).toContain('Suresh Pawar');
  });

  it('shows a person who belongs to no branch, not only those who do', async () => {
    // A manager assigned to a branch has their ALL grants narrowed to
    // BRANCH. A trainer invited without a branch — the default on the
    // invitation form — has no branch row at all, and requiring one here
    // hid them from that manager's rota entirely: they could not be marked
    // in or given a shift.
    const branchRows = await db.orgUserBranch.count({ where: { orgUserId: trainerOrgUserId } });
    expect(branchRows).toBe(0);

    const branch = await db.branch.findFirstOrThrow({
      where: { organizationId: gym.organizationId },
      select: { id: true },
    });

    const managerEmail = `manager.${unique()}@example.com`;
    createdEmails.push(managerEmail);
    const manager = await addTeamMember(managerEmail, 'Priya Deshmukh', 'GYM_MANAGER', [
      branch.id,
    ]);

    const session = await createSession(authPrisma, {
      userId: manager.userId,
      organizationId: gym.organizationId,
      type: 'WEB',
    });
    const resolved = (await resolveSession(authPrisma, session.token)).actor;
    expect(resolved.permissions.branchIds).toContain(branch.id);

    const day = await staffDay(
      { organizationId: gym.organizationId, userId: manager.userId, branchIds: resolved.permissions.branchIds },
      resolved.permissions,
      {},
    );
    expect(day.rows.map((r) => r.orgUserId)).toContain(trainerOrgUserId);
  });

  it('marks somebody in, then out, and works out the hours', async () => {
    await markStaffAttendance(ctx, owner, { orgUserId: trainerOrgUserId, action: 'IN' });

    // Rewind the check-in so the gap is real rather than milliseconds.
    await db.staffAttendance.updateMany({
      where: { orgUserId: trainerOrgUserId },
      data: { checkedInAt: new Date(Date.now() - 4 * 3_600_000) },
    });

    const out = await markStaffAttendance(ctx, owner, {
      orgUserId: trainerOrgUserId,
      action: 'OUT',
    });
    expect(out.checkedOutAt).not.toBeNull();

    const day = await staffDay(ctx, owner, {});
    const trainer = day.rows.find((r) => r.orgUserId === trainerOrgUserId)!;
    expect(trainer.status).toBe('PRESENT');
    expect(trainer.workedMinutes).toBeGreaterThanOrEqual(239);
  });

  it('keeps one row a day, so marking twice is a slip rather than a second day', async () => {
    await markStaffAttendance(ctx, owner, { orgUserId: trainerOrgUserId, action: 'IN' });
    await markStaffAttendance(ctx, owner, { orgUserId: trainerOrgUserId, action: 'IN' });

    const rows = await db.staffAttendance.findMany({
      where: { orgUserId: trainerOrgUserId, attendanceDate: new Date(`${businessDayIso()}T00:00:00.000Z`) },
    });
    expect(rows).toHaveLength(1);
  });

  it('refuses a check-out from somebody never marked in', async () => {
    await expect(
      markStaffAttendance(ctx, owner, {
        orgUserId: ownerOrgUserId,
        date: iso(-3),
        action: 'OUT',
      }),
    ).rejects.toThrow(/not been marked in/i);
  });

  it('totals a period per person', async () => {
    await markStaffAttendance(ctx, owner, {
      orgUserId: trainerOrgUserId,
      date: iso(-1),
      status: 'ABSENT',
    });
    await markStaffAttendance(ctx, owner, {
      orgUserId: trainerOrgUserId,
      date: iso(-2),
      status: 'HALF_DAY',
    });

    const summary = await staffAttendanceSummary(ctx, owner, { from: iso(-7), to: iso(0) });
    const trainer = summary.find((r) => r.orgUserId === trainerOrgUserId)!;
    expect(trainer.absent).toBe(1);
    expect(trainer.halfDays).toBe(1);
    expect(trainer.present).toBeGreaterThanOrEqual(1);
  });
});

// =========================================================================
//  The rota
// =========================================================================

describe('the rota', () => {
  it('puts somebody on a weekly shift', async () => {
    await setShift(ctx, owner, {
      orgUserId: trainerOrgUserId,
      weekday: 1,
      startTime: '06:00',
      endTime: '14:00',
    });

    const shifts = await listShifts(ctx, owner, { orgUserId: trainerOrgUserId });
    expect(shifts).toHaveLength(1);
    expect(shifts[0]!.startTime).toBe('06:00');
    expect(shifts[0]!.weekday).toBe(1);
  });

  it('replaces rather than duplicating the same weekday', async () => {
    await setShift(ctx, owner, {
      orgUserId: trainerOrgUserId,
      weekday: 1,
      startTime: '07:00',
      endTime: '15:00',
    });

    // A rota with two entries for a Monday tells nobody when to turn up.
    const shifts = await listShifts(ctx, owner, { orgUserId: trainerOrgUserId });
    expect(shifts.filter((s) => s.weekday === 1)).toHaveLength(1);
    expect(shifts.find((s) => s.weekday === 1)!.startTime).toBe('07:00');
  });

  it('refuses a shift that ends before it starts', async () => {
    await expect(
      setShift(ctx, owner, {
        orgUserId: trainerOrgUserId,
        weekday: 3,
        startTime: '18:00',
        endTime: '09:00',
      }),
    ).rejects.toThrow(/ends after it starts/i);
  });

  it('shows the shift against the day, with a one-off beating the pattern', async () => {
    const today = new Date();
    const weekday = today.getUTCDay();

    await setShift(ctx, owner, {
      orgUserId: trainerOrgUserId,
      weekday,
      startTime: '06:00',
      endTime: '14:00',
    });

    const before = await staffDay(ctx, owner, {});
    expect(before.rows.find((r) => r.orgUserId === trainerOrgUserId)!.shift?.startTime).toBe('06:00');

    await setShift(ctx, owner, {
      orgUserId: trainerOrgUserId,
      shiftDate: businessDayIso(),
      startTime: '12:00',
      endTime: '20:00',
      notes: 'Covering the late shift',
    });

    const after = await staffDay(ctx, owner, {});
    expect(after.rows.find((r) => r.orgUserId === trainerOrgUserId)!.shift?.startTime).toBe('12:00');
  });

  it('takes somebody off a shift', async () => {
    const created = await setShift(ctx, owner, {
      orgUserId: trainerOrgUserId,
      weekday: 5,
      startTime: '09:00',
      endTime: '17:00',
    });
    await removeShift(ctx, owner, created.id);

    const shifts = await listShifts(ctx, owner, { orgUserId: trainerOrgUserId });
    expect(shifts.find((s) => s.id === created.id)).toBeUndefined();
  });
});

// =========================================================================
//  Leave, and the attendance that follows from it
// =========================================================================

describe('leave', () => {
  it('records a request with the days counted inclusively', async () => {
    const leave = await requestLeave(ctx, owner, {
      orgUserId: trainerOrgUserId,
      leaveType: 'Casual',
      fromDate: iso(10),
      toDate: iso(12),
      reason: 'Family wedding',
    });
    expect(leave.days).toBe('3');

    const rows = await listLeave(ctx, owner, { status: 'REQUESTED' });
    expect(rows.find((r) => r.id === leave.id)?.fullName).toBe('Suresh Pawar');
  });

  it('counts a single-day half day as half', async () => {
    const leave = await requestLeave(ctx, owner, {
      orgUserId: trainerOrgUserId,
      leaveType: 'Casual',
      fromDate: iso(20),
      toDate: iso(20),
      halfDay: true,
    });
    expect(leave.days).toBe('0.5');
  });

  it('refuses leave that overlaps leave already in hand', async () => {
    await expect(
      requestLeave(ctx, owner, {
        orgUserId: trainerOrgUserId,
        leaveType: 'Sick',
        fromDate: iso(11),
        toDate: iso(13),
      }),
    ).rejects.toThrow(/already has leave/i);
  });

  it('marks the attendance for the days it approves', async () => {
    const leave = await requestLeave(ctx, owner, {
      orgUserId: trainerOrgUserId,
      leaveType: 'Sick',
      fromDate: iso(30),
      toDate: iso(32),
    });

    const decision = await decideLeave(ctx, owner, { leaveId: leave.id, approve: true });

    // The point of the whole thing: without this the register shows a
    // sanctioned absence as an unexplained one.
    expect(decision.status).toBe('APPROVED');
    expect(decision.daysMarked).toBe(3);

    const marked = await db.staffAttendance.findMany({
      where: {
        orgUserId: trainerOrgUserId,
        attendanceDate: {
          gte: new Date(`${iso(30)}T00:00:00.000Z`),
          lte: new Date(`${iso(32)}T00:00:00.000Z`),
        },
      },
    });
    expect(marked).toHaveLength(3);
    expect(marked.every((m) => m.status === 'ON_LEAVE')).toBe(true);
    expect(marked[0]!.notes).toBe('Sick');
  });

  it('does not erase a day somebody actually worked', async () => {
    await markStaffAttendance(ctx, owner, {
      orgUserId: trainerOrgUserId,
      date: iso(40),
      status: 'PRESENT',
    });

    const leave = await requestLeave(ctx, owner, {
      orgUserId: trainerOrgUserId,
      leaveType: 'Casual',
      fromDate: iso(40),
      toDate: iso(41),
    });
    const decision = await decideLeave(ctx, owner, { leaveId: leave.id, approve: true });

    // One of the two days was worked, so only the other is marked.
    expect(decision.daysMarked).toBe(1);
    const worked = await db.staffAttendance.findFirstOrThrow({
      where: { orgUserId: trainerOrgUserId, attendanceDate: new Date(`${iso(40)}T00:00:00.000Z`) },
    });
    expect(worked.status).toBe('PRESENT');
  });

  it('refuses a check-in on a day of approved leave', async () => {
    await expect(
      markStaffAttendance(ctx, owner, {
        orgUserId: trainerOrgUserId,
        date: iso(31),
        action: 'IN',
      }),
    ).rejects.toThrow(/on approved leave/i);
  });

  it('writes no attendance when leave is refused', async () => {
    const leave = await requestLeave(ctx, owner, {
      orgUserId: trainerOrgUserId,
      leaveType: 'Casual',
      fromDate: iso(50),
      toDate: iso(51),
    });
    const decision = await decideLeave(ctx, owner, {
      leaveId: leave.id,
      approve: false,
      note: 'Short staffed that week',
    });

    expect(decision.status).toBe('REJECTED');
    expect(decision.daysMarked).toBe(0);
    expect(
      await db.staffAttendance.count({
        where: {
          orgUserId: trainerOrgUserId,
          attendanceDate: new Date(`${iso(50)}T00:00:00.000Z`),
        },
      }),
    ).toBe(0);
  });

  it('cannot decide the same request twice', async () => {
    const leave = await requestLeave(ctx, owner, {
      orgUserId: trainerOrgUserId,
      leaveType: 'Casual',
      fromDate: iso(60),
      toDate: iso(60),
    });
    await decideLeave(ctx, owner, { leaveId: leave.id, approve: true });

    await expect(
      decideLeave(ctx, owner, { leaveId: leave.id, approve: false }),
    ).rejects.toThrow(/already approved/i);
  });

  it('will not let anybody approve their own leave', async () => {
    const mine = await requestLeave(ctx, owner, {
      leaveType: 'Casual',
      fromDate: iso(70),
      toDate: iso(71),
    });

    // The owner holds every permission in the gym, and still cannot sanction
    // their own absence. That is the control.
    await expect(
      decideLeave(ctx, owner, { leaveId: mine.id, approve: true }),
    ).rejects.toThrow(/somebody else has to approve/i);

    const rows = await listLeave(ctx, owner, { status: 'REQUESTED' });
    expect(rows.find((r) => r.id === mine.id)).toBeDefined();
  });
});

// =========================================================================
//  Isolation
// =========================================================================

describe('one gym’s rota is not another’s', () => {
  it('cannot read or decide another gym’s staff records', async () => {
    const email = `rota.other.${unique()}@example.com`;
    createdEmails.push(email);

    const other = await registerGym({
      gymName: `Other Rota ${unique()}`,
      ownerName: 'Other Owner',
      email,
      phone: '9876640000',
      password: 'correct horse battery staple 47',
      planKey: 'PROFESSIONAL',
      acceptedTerms: true,
    });
    createdOrgIds.push(other.organizationId);

    const otherCtx = { organizationId: other.organizationId, userId: other.userId };
    const otherSession = await createSession(authPrisma, {
      userId: other.userId,
      organizationId: other.organizationId,
      type: 'WEB',
    });
    const otherOwner = (await resolveSession(authPrisma, otherSession.token)).actor.permissions;

    const leave = await requestLeave(ctx, owner, {
      orgUserId: trainerOrgUserId,
      leaveType: 'Casual',
      fromDate: iso(80),
      toDate: iso(81),
    });

    await expect(
      decideLeave(otherCtx, otherOwner, { leaveId: leave.id, approve: true }),
    ).rejects.toThrow(/not found/i);

    await expect(
      markStaffAttendance(otherCtx, otherOwner, {
        orgUserId: trainerOrgUserId,
        action: 'IN',
      }),
    ).rejects.toThrow(/not on the team/i);

    await expect(
      setShift(otherCtx, otherOwner, {
        orgUserId: trainerOrgUserId,
        weekday: 2,
        startTime: '09:00',
        endTime: '17:00',
      }),
    ).rejects.toThrow(/not on the team/i);

    const theirDay = await staffDay(otherCtx, otherOwner, {});
    expect(theirDay.rows.map((r) => r.orgUserId)).not.toContain(trainerOrgUserId);

    const theirLeave = await listLeave(otherCtx, otherOwner, {});
    expect(theirLeave).toHaveLength(0);
  });
});
