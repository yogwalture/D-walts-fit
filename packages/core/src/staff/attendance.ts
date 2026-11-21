import { withTenant } from '@gym/db';
import { AppError } from '../errors';
import { writeAudit } from '../audit/log';
import {
  requirePermission,
  scopeOf,
  type ResolvedPermissions,
} from '../rbac/engine';
import { businessDayIso, inclusiveDays, startOfDay } from '../shared/dates';
import type { StaffContext } from './service';

/**
 * Staff attendance, the rota, and leave.
 *
 * The part that decides whether any of this is worth having is that they
 * are one thing, not three. Approved leave writes the attendance for those
 * days, so the register does not show a trainer as absent while holding a
 * sanctioned leave approval — and payroll, when it lands, reads one
 * consistent story rather than reconciling three.
 *
 * Nobody approves their own leave, however senior. A manager who can
 * sanction absence can sanction everyone's but their own; theirs goes to
 * someone else. That is an ordinary financial control, and it costs one
 * line here.
 */


export type StaffAttendanceStatus =
  | 'PRESENT'
  | 'ABSENT'
  | 'HALF_DAY'
  | 'ON_LEAVE'
  | 'WEEKLY_OFF'
  | 'HOLIDAY';

export type LeaveStatus = 'REQUESTED' | 'APPROVED' | 'REJECTED' | 'CANCELLED';

// ------------------------------------------------------------ attendance ---

export interface StaffDayRow {
  orgUserId: string;
  fullName: string;
  roleName: string;
  status: StaffAttendanceStatus | null;
  checkedInAt: string | null;
  checkedOutAt: string | null;
  workedMinutes: number | null;
  shift: { startTime: string; endTime: string } | null;
  notes: string | null;
}

/**
 * Who is in today, who is not, and who was meant to be.
 *
 * Returns a row for every active staff member rather than only those with
 * an attendance record, because the useful question at 10am is who has not
 * arrived — and a list of people who are present cannot answer it.
 */
export async function staffDay(
  ctx: StaffContext,
  permissions: ResolvedPermissions,
  options: { date?: string } = {},
): Promise<{ date: string; rows: StaffDayRow[] }> {
  requirePermission(permissions, 'staff.attendance.read');
  const scope = scopeOf(permissions, 'staff.attendance.read');

  return withTenant(ctx, async (tx) => {
    const settings = await tx.orgSetting.findFirst({ select: { timezone: true } });
    const date = options.date ?? businessDayIso(settings?.timezone ?? 'Asia/Kolkata');
    const day = new Date(`${date}T00:00:00.000Z`);
    const weekday = day.getUTCDay();

    // A trainer sees their own row and nobody else's: their colleagues'
    // comings and goings are not their business.
    const self =
      scope === 'OWN'
        ? await tx.orgUser.findFirst({
            where: { userId: ctx.userId, deletedAt: null },
            select: { id: true },
          })
        : null;

    const staff = await tx.orgUser.findMany({
      // Bounded: more than 1,000 staff with access to a gym for one gym is a data
      // problem, and a truncated list beats a request that times out.
      take: 1000,
      where: {
        deletedAt: null,
        status: 'ACTIVE',
        ...(self ? { id: self.id } : {}),
        // Somebody with no branch rows works for the whole gym, so they are
        // visible to branch-scoped staff too. Requiring a branch row here
        // hid every person invited without one — which is the default on
        // the invitation form — so a trainer who had joined could not be
        // marked in or given a shift at all.
        ...(scope === 'BRANCH' && (ctx.branchIds ?? []).length > 0
          ? {
              OR: [
                { branches: { some: { branchId: { in: ctx.branchIds! } } } },
                { branches: { none: {} } },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        user: { select: { fullName: true } },
        role: { select: { name: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    const ids = staff.map((s: any) => s.id);

    const [attendance, shifts] = await Promise.all([
      tx.staffAttendance.findMany({
        // Bounded: more than 2,000 staff attendance rows for one gym is a data
        // problem, and a truncated list beats a request that times out.
        take: 2000,
        where: { orgUserId: { in: ids }, attendanceDate: day },
        select: {
          orgUserId: true,
          status: true,
          checkedInAt: true,
          checkedOutAt: true,
          notes: true,
        },
      }),
      tx.staffShift.findMany({
        // Bounded: more than 2,000 rota entries for one gym is a data
        // problem, and a truncated list beats a request that times out.
        take: 2000,
        where: {
          orgUserId: { in: ids },
          OR: [{ weekday }, { shiftDate: day }],
        },
        select: { orgUserId: true, startTime: true, endTime: true, shiftDate: true },
      }),
    ]);

    const byUser = new Map(attendance.map((a: any) => [a.orgUserId, a]));
    // A one-off shift for the day beats the weekly pattern.
    const shiftFor = new Map<string, { startTime: string; endTime: string }>();
    for (const shift of shifts) {
      const existing = shiftFor.get(shift.orgUserId);
      if (!existing || shift.shiftDate) {
        shiftFor.set(shift.orgUserId, { startTime: shift.startTime, endTime: shift.endTime });
      }
    }

    return {
      date,
      rows: staff.map((member: any) => {
        const record = byUser.get(member.id);
        const worked =
          record?.checkedInAt && record?.checkedOutAt
            ? Math.round(
                (record.checkedOutAt.getTime() - record.checkedInAt.getTime()) / 60_000,
              )
            : null;

        return {
          orgUserId: member.id,
          fullName: member.user.fullName,
          roleName: member.role.name,
          status: (record?.status as StaffAttendanceStatus) ?? null,
          checkedInAt: record?.checkedInAt ? record.checkedInAt.toISOString() : null,
          checkedOutAt: record?.checkedOutAt ? record.checkedOutAt.toISOString() : null,
          workedMinutes: worked,
          shift: shiftFor.get(member.id) ?? null,
          notes: record?.notes ?? null,
        };
      }),
    };
  });
}

/**
 * Marks a staff member in, out, or absent.
 *
 * One row per person per day, so a second check-in updates rather than
 * duplicating — a receptionist marking the same person twice is a slip, not
 * a second working day.
 */
export async function markStaffAttendance(
  ctx: StaffContext,
  permissions: ResolvedPermissions,
  input: {
    orgUserId: string;
    date?: string;
    status?: StaffAttendanceStatus;
    action?: 'IN' | 'OUT';
    notes?: string;
  },
  meta: { ipAddress?: string } = {},
): Promise<{ status: StaffAttendanceStatus; checkedInAt: string | null; checkedOutAt: string | null }> {
  requirePermission(permissions, 'staff.attendance.manage');

  return withTenant(ctx, async (tx) => {
    const member = await tx.orgUser.findFirst({
      where: { id: input.orgUserId, deletedAt: null },
      select: {
        id: true,
        branches: { select: { branchId: true }, take: 1 },
        user: { select: { fullName: true } },
      },
    });
    if (!member) throw new AppError('NOT_FOUND', 'That person is not on the team.');

    const settings = await tx.orgSetting.findFirst({ select: { timezone: true } });
    const date = input.date ?? businessDayIso(settings?.timezone ?? 'Asia/Kolkata');
    const day = new Date(`${date}T00:00:00.000Z`);

    const existing = await tx.staffAttendance.findFirst({
      where: { orgUserId: member.id, attendanceDate: day },
      select: { id: true, status: true, checkedInAt: true, checkedOutAt: true },
    });

    // Sanctioned leave is not overwritten by a stray tap on the register:
    // changing it has to be a deliberate status change, not a check-in.
    if (existing?.status === 'ON_LEAVE' && input.action) {
      throw new AppError(
        'CONFLICT',
        `${member.user.fullName} is on approved leave on that day.`,
      );
    }

    const now = new Date();
    let status: StaffAttendanceStatus = input.status ?? existing?.status ?? 'PRESENT';
    let checkedInAt: Date | null = existing?.checkedInAt ?? null;
    let checkedOutAt: Date | null = existing?.checkedOutAt ?? null;

    if (input.action === 'IN') {
      checkedInAt = checkedInAt ?? now;
      status = input.status ?? 'PRESENT';
    } else if (input.action === 'OUT') {
      if (!checkedInAt) {
        throw new AppError(
          'CONFLICT',
          `${member.user.fullName} has not been marked in yet today.`,
        );
      }
      checkedOutAt = now;
    }

    const saved = existing
      ? await tx.staffAttendance.update({
          where: { id: existing.id },
          data: {
            status,
            checkedInAt,
            checkedOutAt,
            ...(input.notes !== undefined ? { notes: input.notes?.trim() || null } : {}),
          },
          select: { status: true, checkedInAt: true, checkedOutAt: true },
        })
      : await tx.staffAttendance.create({
          data: {
            organizationId: ctx.organizationId,
            orgUserId: member.id,
            branchId: member.branches[0]?.branchId ?? null,
            attendanceDate: day,
            status,
            checkedInAt,
            checkedOutAt,
            notes: input.notes?.trim() || null,
          },
          select: { status: true, checkedInAt: true, checkedOutAt: true },
        });

    await writeAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'staff.attendance.mark',
      entityType: 'StaffAttendance',
      entityId: member.id,
      summary: `${member.user.fullName} — ${saved.status.toLowerCase().replace('_', ' ')} on ${date}`,
      ipAddress: meta.ipAddress,
    });

    return {
      status: saved.status as StaffAttendanceStatus,
      checkedInAt: saved.checkedInAt ? saved.checkedInAt.toISOString() : null,
      checkedOutAt: saved.checkedOutAt ? saved.checkedOutAt.toISOString() : null,
    };
  });
}

export interface AttendanceSummaryRow {
  orgUserId: string;
  fullName: string;
  present: number;
  halfDays: number;
  absent: number;
  onLeave: number;
  workedMinutes: number;
}

/** A month's attendance per person — the sheet payroll will eventually read. */
export async function staffAttendanceSummary(
  ctx: StaffContext,
  permissions: ResolvedPermissions,
  options: { from: string; to: string },
): Promise<AttendanceSummaryRow[]> {
  requirePermission(permissions, 'staff.attendance.read');

  const from = startOfDay(options.from);
  const to = startOfDay(options.to);
  if (to < from) {
    throw new AppError('VALIDATION_FAILED', 'That date range ends before it starts.');
  }

  return withTenant(ctx, async (tx) => {
    const rows = await tx.staffAttendance.findMany({
      // Bounded: more than 2,000 staff attendance rows for one gym is a data
      // problem, and a truncated list beats a request that times out.
      take: 2000,
      where: { attendanceDate: { gte: from, lte: to } },
      select: {
        orgUserId: true,
        status: true,
        checkedInAt: true,
        checkedOutAt: true,
        orgUser: { select: { user: { select: { fullName: true } } } },
      },
    });

    const byUser = new Map<string, AttendanceSummaryRow>();

    for (const row of rows) {
      const current = byUser.get(row.orgUserId) ?? {
        orgUserId: row.orgUserId,
        fullName: row.orgUser.user.fullName,
        present: 0,
        halfDays: 0,
        absent: 0,
        onLeave: 0,
        workedMinutes: 0,
      };

      if (row.status === 'PRESENT') current.present += 1;
      if (row.status === 'HALF_DAY') current.halfDays += 1;
      if (row.status === 'ABSENT') current.absent += 1;
      if (row.status === 'ON_LEAVE') current.onLeave += 1;

      if (row.checkedInAt && row.checkedOutAt) {
        current.workedMinutes += Math.round(
          (row.checkedOutAt.getTime() - row.checkedInAt.getTime()) / 60_000,
        );
      }

      byUser.set(row.orgUserId, current);
    }

    return [...byUser.values()].sort((a, b) => a.fullName.localeCompare(b.fullName));
  });
}

// ----------------------------------------------------------------- rota ---

export interface ShiftRow {
  id: string;
  orgUserId: string;
  fullName: string;
  weekday: number | null;
  shiftDate: string | null;
  startTime: string;
  endTime: string;
  notes: string | null;
}

export async function listShifts(
  ctx: StaffContext,
  permissions: ResolvedPermissions,
  options: { orgUserId?: string } = {},
): Promise<ShiftRow[]> {
  requirePermission(permissions, 'staff.attendance.read');

  return withTenant(ctx, async (tx) => {
    const rows = await tx.staffShift.findMany({
      // Bounded: more than 2,000 rota entries for one gym is a data
      // problem, and a truncated list beats a request that times out.
      take: 2000,
      where: { ...(options.orgUserId ? { orgUserId: options.orgUserId } : {}) },
      orderBy: [{ weekday: 'asc' }, { startTime: 'asc' }],
      select: {
        id: true,
        orgUserId: true,
        weekday: true,
        shiftDate: true,
        startTime: true,
        endTime: true,
        notes: true,
        orgUser: { select: { user: { select: { fullName: true } } } },
      },
    });

    return rows.map((row: any) => ({
      id: row.id,
      orgUserId: row.orgUserId,
      fullName: row.orgUser.user.fullName,
      weekday: row.weekday,
      shiftDate: row.shiftDate ? row.shiftDate.toISOString().slice(0, 10) : null,
      startTime: row.startTime,
      endTime: row.endTime,
      notes: row.notes,
    }));
  });
}

/**
 * Puts someone on the rota, weekly or for one day.
 *
 * Times are stored as `HH:MM` strings rather than instants: a shift is
 * "nine to five at this gym", which does not move when the clocks do and
 * does not belong to any particular date.
 */
export async function setShift(
  ctx: StaffContext,
  permissions: ResolvedPermissions,
  input: {
    orgUserId: string;
    weekday?: number;
    shiftDate?: string;
    startTime: string;
    endTime: string;
    notes?: string;
  },
  meta: { ipAddress?: string } = {},
): Promise<{ id: string }> {
  requirePermission(permissions, 'staff.shift.manage');

  if (input.weekday === undefined && !input.shiftDate) {
    throw new AppError('VALIDATION_FAILED', 'Say which day, or which weekday it repeats on.', [
      { field: 'weekday', issue: 'Required unless a date is given' },
    ]);
  }
  if (!/^\d{2}:\d{2}$/.test(input.startTime) || !/^\d{2}:\d{2}$/.test(input.endTime)) {
    throw new AppError('VALIDATION_FAILED', 'Times are written as HH:MM.', [
      { field: 'startTime', issue: 'Use HH:MM' },
    ]);
  }
  if (input.endTime <= input.startTime) {
    // An overnight shift would need a date to be unambiguous, and a gym that
    // runs one can enter it as two.
    throw new AppError('VALIDATION_FAILED', 'A shift ends after it starts.', [
      { field: 'endTime', issue: 'Must be after the start' },
    ]);
  }

  return withTenant(ctx, async (tx) => {
    const member = await tx.orgUser.findFirst({
      where: { id: input.orgUserId, deletedAt: null },
      select: {
        id: true,
        branches: { select: { branchId: true }, take: 1 },
        user: { select: { fullName: true } },
      },
    });
    if (!member) throw new AppError('NOT_FOUND', 'That person is not on the team.');

    // One shift per person per weekday, or per one-off date: a rota with two
    // conflicting entries for a Tuesday tells nobody when to turn up.
    const existing = await tx.staffShift.findFirst({
      where: {
        orgUserId: member.id,
        ...(input.shiftDate
          ? { shiftDate: new Date(`${input.shiftDate}T00:00:00.000Z`) }
          : { weekday: input.weekday, shiftDate: null }),
      },
      select: { id: true },
    });

    const data = {
      organizationId: ctx.organizationId,
      orgUserId: member.id,
      branchId: member.branches[0]?.branchId ?? null,
      weekday: input.shiftDate ? null : (input.weekday ?? null),
      shiftDate: input.shiftDate ? new Date(`${input.shiftDate}T00:00:00.000Z`) : null,
      startTime: input.startTime,
      endTime: input.endTime,
      notes: input.notes?.trim() || null,
    };

    const saved = existing
      ? await tx.staffShift.update({ where: { id: existing.id }, data, select: { id: true } })
      : await tx.staffShift.create({ data, select: { id: true } });

    await writeAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'staff.shift.set',
      entityType: 'StaffShift',
      entityId: saved.id,
      summary: `${member.user.fullName} on the rota ${input.startTime}–${input.endTime}`,
      ipAddress: meta.ipAddress,
    });

    return saved;
  });
}

export async function removeShift(
  ctx: StaffContext,
  permissions: ResolvedPermissions,
  shiftId: string,
  meta: { ipAddress?: string } = {},
): Promise<void> {
  requirePermission(permissions, 'staff.shift.manage');

  await withTenant(ctx, async (tx) => {
    const shift = await tx.staffShift.findFirst({
      where: { id: shiftId },
      select: { id: true, orgUser: { select: { user: { select: { fullName: true } } } } },
    });
    if (!shift) throw new AppError('NOT_FOUND', 'That shift was not found.');

    await tx.staffShift.delete({ where: { id: shiftId } });

    await writeAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'staff.shift.remove',
      entityType: 'StaffShift',
      entityId: shiftId,
      summary: `Took ${shift.orgUser.user.fullName} off that shift`,
      ipAddress: meta.ipAddress,
    });
  });
}

// ---------------------------------------------------------------- leave ---

export interface LeaveRow {
  id: string;
  orgUserId: string;
  fullName: string;
  leaveType: string;
  fromDate: string;
  toDate: string;
  days: string;
  reason: string | null;
  status: LeaveStatus;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
}

export async function requestLeave(
  ctx: StaffContext,
  permissions: ResolvedPermissions,
  input: {
    orgUserId?: string;
    leaveType: string;
    fromDate: string;
    toDate: string;
    reason?: string;
    halfDay?: boolean;
  },
  meta: { ipAddress?: string } = {},
): Promise<{ id: string; days: string }> {
  requirePermission(permissions, 'staff.leave.read');

  return withTenant(ctx, async (tx) => {
    const me = await tx.orgUser.findFirst({
      where: { userId: ctx.userId, deletedAt: null },
      select: { id: true },
    });

    const targetId = input.orgUserId ?? me?.id;
    if (!targetId) throw new AppError('NOT_FOUND', 'That person is not on the team.');

    // Filing leave for somebody else is a manager's act, not a colleague's.
    if (targetId !== me?.id) {
      requirePermission(permissions, 'staff.leave.approve');
    }

    const member = await tx.orgUser.findFirst({
      where: { id: targetId, deletedAt: null },
      select: { id: true, user: { select: { fullName: true } } },
    });
    if (!member) throw new AppError('NOT_FOUND', 'That person is not on the team.');

    const from = startOfDay(input.fromDate);
    const to = startOfDay(input.toDate);
    if (to < from) {
      throw new AppError('VALIDATION_FAILED', 'That leave ends before it starts.', [
        { field: 'toDate', issue: 'Must be on or after the start' },
      ]);
    }

    const days = input.halfDay && from.getTime() === to.getTime() ? 0.5 : inclusiveDays(from, to);

    // Two approved leaves over the same days is a record nobody can act on,
    // and it would double-count in payroll.
    const clash = await tx.staffLeave.findFirst({
      where: {
        orgUserId: member.id,
        status: { in: ['REQUESTED', 'APPROVED'] },
        fromDate: { lte: to },
        toDate: { gte: from },
      },
      select: { id: true, fromDate: true, toDate: true, status: true },
    });
    if (clash) {
      throw new AppError(
        'CONFLICT',
        `${member.user.fullName} already has leave ${clash.status.toLowerCase()} over those dates.`,
      );
    }

    const leave = await tx.staffLeave.create({
      data: {
        organizationId: ctx.organizationId,
        orgUserId: member.id,
        leaveType: input.leaveType.trim(),
        fromDate: from,
        toDate: to,
        days: days.toString(),
        reason: input.reason?.trim() || null,
        status: 'REQUESTED',
      },
      select: { id: true },
    });

    await writeAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'staff.leave.request',
      entityType: 'StaffLeave',
      entityId: leave.id,
      summary: `${member.user.fullName} requested ${days} day(s) — ${input.leaveType.trim()}`,
      ipAddress: meta.ipAddress,
    });

    return { id: leave.id, days: days.toString() };
  });
}

/**
 * Approves or refuses leave, and writes the attendance that follows from it.
 *
 * Writing the attendance is the point: without it the register shows a
 * sanctioned absence as an unexplained one, and whoever runs payroll docks
 * a day the gym had already agreed to.
 */
export async function decideLeave(
  ctx: StaffContext,
  permissions: ResolvedPermissions,
  input: { leaveId: string; approve: boolean; note?: string },
  meta: { ipAddress?: string } = {},
): Promise<{ status: LeaveStatus; daysMarked: number }> {
  requirePermission(permissions, 'staff.leave.approve');

  return withTenant(ctx, async (tx) => {
    const leave = await tx.staffLeave.findFirst({
      where: { id: input.leaveId },
      select: {
        id: true,
        orgUserId: true,
        status: true,
        fromDate: true,
        toDate: true,
        leaveType: true,
        orgUser: {
          select: {
            userId: true,
            branches: { select: { branchId: true }, take: 1 },
            user: { select: { fullName: true } },
          },
        },
      },
    });
    if (!leave) throw new AppError('NOT_FOUND', 'That leave request was not found.');

    if (leave.status !== 'REQUESTED') {
      throw new AppError(
        'CONFLICT',
        `That request was already ${leave.status.toLowerCase()}.`,
      );
    }

    // Nobody sanctions their own absence, however senior. An ordinary
    // control, and the only place it can be enforced.
    if (leave.orgUser.userId === ctx.userId) {
      throw new AppError(
        'FORBIDDEN',
        'Somebody else has to approve your own leave.',
      );
    }

    await tx.staffLeave.update({
      where: { id: leave.id },
      data: {
        status: input.approve ? 'APPROVED' : 'REJECTED',
        decidedByUserId: ctx.userId,
        decidedAt: new Date(),
        decisionNote: input.note?.trim() || null,
      },
    });

    let daysMarked = 0;

    if (input.approve) {
      const cursor = new Date(leave.fromDate);
      while (cursor <= leave.toDate) {
        const day = new Date(cursor);
        const existing = await tx.staffAttendance.findFirst({
          where: { orgUserId: leave.orgUserId, attendanceDate: day },
          select: { id: true, status: true },
        });

        if (existing) {
          // A day already marked present is left alone: somebody worked it,
          // and overwriting that would quietly erase a day's work.
          if (existing.status !== 'PRESENT' && existing.status !== 'HALF_DAY') {
            await tx.staffAttendance.update({
              where: { id: existing.id },
              data: { status: 'ON_LEAVE', notes: leave.leaveType },
            });
            daysMarked += 1;
          }
        } else {
          await tx.staffAttendance.create({
            data: {
              organizationId: ctx.organizationId,
              orgUserId: leave.orgUserId,
              branchId: leave.orgUser.branches[0]?.branchId ?? null,
              attendanceDate: day,
              status: 'ON_LEAVE',
              notes: leave.leaveType,
            },
          });
          daysMarked += 1;
        }

        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
    }

    await writeAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: input.approve ? 'staff.leave.approve' : 'staff.leave.reject',
      entityType: 'StaffLeave',
      entityId: leave.id,
      summary: `${input.approve ? 'Approved' : 'Refused'} ${
        leave.orgUser.user.fullName
      }'s ${leave.leaveType}`,
      ipAddress: meta.ipAddress,
    });

    return { status: input.approve ? 'APPROVED' : 'REJECTED', daysMarked };
  });
}

export async function listLeave(
  ctx: StaffContext,
  permissions: ResolvedPermissions,
  options: { status?: LeaveStatus; orgUserId?: string; limit?: number } = {},
): Promise<LeaveRow[]> {
  requirePermission(permissions, 'staff.leave.read');
  const scope = scopeOf(permissions, 'staff.leave.read');

  return withTenant(ctx, async (tx) => {
    const self =
      scope === 'OWN'
        ? await tx.orgUser.findFirst({
            where: { userId: ctx.userId, deletedAt: null },
            select: { id: true },
          })
        : null;

    const rows = await tx.staffLeave.findMany({
      where: {
        ...(options.status ? { status: options.status } : {}),
        ...(self ? { orgUserId: self.id } : options.orgUserId ? { orgUserId: options.orgUserId } : {}),
      },
      orderBy: [{ status: 'asc' }, { fromDate: 'desc' }],
      take: Math.min(options.limit ?? 50, 200),
      select: {
        id: true,
        orgUserId: true,
        leaveType: true,
        fromDate: true,
        toDate: true,
        days: true,
        reason: true,
        status: true,
        decidedByUserId: true,
        decidedAt: true,
        decisionNote: true,
        orgUser: { select: { user: { select: { fullName: true } } } },
      },
    });

    const deciderIds = [...new Set(rows.map((r: any) => r.decidedByUserId).filter(Boolean))];
    const deciders = deciderIds.length
      ? await tx.user.findMany({
        // Bounded: more than 1,000 users for one gym is a data
        // problem, and a truncated list beats a request that times out.
        take: 1000,
          where: { id: { in: deciderIds as string[] } },
          select: { id: true, fullName: true },
        })
      : [];
    const names = new Map(deciders.map((d: any) => [d.id, d.fullName]));

    return rows.map((row: any) => ({
      id: row.id,
      orgUserId: row.orgUserId,
      fullName: row.orgUser.user.fullName,
      leaveType: row.leaveType,
      fromDate: row.fromDate.toISOString().slice(0, 10),
      toDate: row.toDate.toISOString().slice(0, 10),
      days: Number(row.days).toString(),
      reason: row.reason,
      status: row.status as LeaveStatus,
      decidedBy: row.decidedByUserId ? (names.get(row.decidedByUserId) ?? null) : null,
      decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
      decisionNote: row.decisionNote,
    }));
  });
}
