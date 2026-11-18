import { withTenant } from '@gym/db';
import { AppError } from '../errors';
import { writeAudit } from '../audit/log';
import {
  requirePermission,
  scopeOf,
  branchFilter,
  type ResolvedPermissions,
} from '../rbac/engine';
import { businessDayRange } from '../shared/dates';

/**
 * Classes and the timetable.
 *
 * Two things make or break this in a real gym, and neither is the calendar.
 *
 * The first is capacity. A yoga room holds fourteen people, and two members
 * will press Book on the last place within the same second. Reading
 * `bookedCount` and then writing it back cannot be correct: both reads see
 * thirteen. So every booking locks the class row inside its transaction and
 * decides from the locked figure, which makes the second booking wait and
 * then see a full class. The unique index on (classId, memberId) is the
 * second line of defence against the same member double-booking.
 *
 * The second is the waitlist. A waitlist that does not move when somebody
 * cancels is decoration: the member who dropped out frees a place nobody is
 * told about, and the class runs with an empty mat. Cancelling therefore
 * promotes the first person waiting, in the same transaction, and says who
 * was promoted so the gym can tell them.
 *
 * Repeating classes are materialised as real rows at creation, bounded to a
 * horizon, rather than computed from a rule at read time. The deploy target
 * has no background worker to extend them, and a timetable that quietly
 * stops is worse than one a manager has to extend on purpose — so the
 * generator is explicit about how far ahead it has gone.
 */

export interface ClassContext {
  organizationId: string;
  userId: string;
  branchIds?: string[];
}

export type ClassStatus = 'SCHEDULED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';
export type BookingStatus = 'BOOKED' | 'WAITLISTED' | 'CANCELLED' | 'ATTENDED' | 'NO_SHOW';

/** How far ahead a repeating class is generated in one go. */
export const RECURRENCE_HORIZON_WEEKS = 12;

// ---------------------------------------------------------- class types ---

export interface ClassTypeView {
  id: string;
  name: string;
  description: string | null;
  defaultDurationMinutes: number;
  defaultCapacity: number;
  colorHex: string | null;
  requiresBooking: boolean;
  isActive: boolean;
  scheduledCount: number;
}

export async function listClassTypes(
  ctx: ClassContext,
  permissions: ResolvedPermissions,
  options: { includeInactive?: boolean } = {},
): Promise<ClassTypeView[]> {
  requirePermission(permissions, 'classes.class.read');

  return withTenant(ctx, async (tx) => {
    const rows = await tx.classType.findMany({
      where: options.includeInactive ? {} : { isActive: true },
      orderBy: { name: 'asc' },
      include: {
        _count: {
          select: { classes: { where: { startsAt: { gte: new Date() }, cancelledAt: null } } },
        },
      },
    });

    return rows.map((row: any) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      defaultDurationMinutes: row.defaultDurationMinutes,
      defaultCapacity: row.defaultCapacity,
      colorHex: row.colorHex,
      requiresBooking: row.requiresBooking,
      isActive: row.isActive,
      scheduledCount: row._count.classes,
    }));
  });
}

export async function createClassType(
  ctx: ClassContext,
  permissions: ResolvedPermissions,
  input: {
    name: string;
    description?: string;
    defaultDurationMinutes?: number;
    defaultCapacity?: number;
    colorHex?: string;
    requiresBooking?: boolean;
  },
  meta: { ipAddress?: string } = {},
): Promise<{ id: string }> {
  requirePermission(permissions, 'classes.class.manage');

  return withTenant(ctx, async (tx) => {
    const existing = await tx.classType.findFirst({
      where: { name: input.name.trim() },
      select: { id: true, isActive: true },
    });
    if (existing) {
      throw new AppError('CONFLICT', `There is already a class called ${input.name.trim()}.`);
    }

    const created = await tx.classType.create({
      data: {
        organizationId: ctx.organizationId,
        name: input.name.trim(),
        description: input.description?.trim() || null,
        defaultDurationMinutes: input.defaultDurationMinutes ?? 60,
        defaultCapacity: input.defaultCapacity ?? 20,
        colorHex: input.colorHex ?? null,
        requiresBooking: input.requiresBooking ?? true,
      },
      select: { id: true },
    });

    await writeAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'classes.type.create',
      entityType: 'ClassType',
      entityId: created.id,
      summary: `Added the class ${input.name.trim()}`,
      ipAddress: meta.ipAddress,
    });

    return created;
  });
}

export async function updateClassType(
  ctx: ClassContext,
  permissions: ResolvedPermissions,
  classTypeId: string,
  input: {
    name?: string;
    description?: string | null;
    defaultDurationMinutes?: number;
    defaultCapacity?: number;
    colorHex?: string | null;
    requiresBooking?: boolean;
    isActive?: boolean;
  },
  meta: { ipAddress?: string } = {},
): Promise<void> {
  requirePermission(permissions, 'classes.class.manage');

  await withTenant(ctx, async (tx) => {
    const existing = await tx.classType.findFirst({
      where: { id: classTypeId },
      select: { id: true, name: true },
    });
    if (!existing) throw new AppError('NOT_FOUND', 'That class was not found.');

    // Retiring a class type leaves the sessions already on the timetable
    // alone: people have booked them, and a booking that vanishes is worse
    // than a class nobody can schedule again.
    await tx.classType.update({
      where: { id: classTypeId },
      data: {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.description !== undefined
          ? { description: input.description?.trim() || null }
          : {}),
        ...(input.defaultDurationMinutes !== undefined
          ? { defaultDurationMinutes: input.defaultDurationMinutes }
          : {}),
        ...(input.defaultCapacity !== undefined
          ? { defaultCapacity: input.defaultCapacity }
          : {}),
        ...(input.colorHex !== undefined ? { colorHex: input.colorHex } : {}),
        ...(input.requiresBooking !== undefined
          ? { requiresBooking: input.requiresBooking }
          : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
    });

    await writeAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'classes.type.update',
      entityType: 'ClassType',
      entityId: classTypeId,
      summary:
        input.isActive === false
          ? `Retired the class ${existing.name}`
          : `Edited the class ${existing.name}`,
      ipAddress: meta.ipAddress,
    });
  });
}

// ------------------------------------------------------------ scheduling ---

export interface ScheduleClassInput {
  classTypeId: string;
  branchId?: string;
  trainerOrgUserId?: string;
  title?: string;
  startsAt: string;
  durationMinutes?: number;
  capacity?: number;
  room?: string;
  notes?: string;
  /** Weekdays (0 = Sunday) for a repeating class; empty for a one-off. */
  repeatOn?: number[];
  /** Weeks to generate, capped at RECURRENCE_HORIZON_WEEKS. */
  repeatWeeks?: number;
}

export interface ScheduledClasses {
  ids: string[];
  /** The last occurrence created, so the manager knows when to extend. */
  generatedUntil: string | null;
  skipped: Array<{ startsAt: string; reason: string }>;
}

/**
 * Puts a class on the timetable, once or weekly.
 *
 * A clash is reported rather than refused as a whole: generating twelve
 * weeks of a Tuesday class should not fail because the trainer is busy on
 * one of those Tuesdays. The occurrences that fit are created and the ones
 * that clash come back with a reason, which is what a manager can act on.
 */
export async function scheduleClass(
  ctx: ClassContext,
  permissions: ResolvedPermissions,
  input: ScheduleClassInput,
  meta: { ipAddress?: string } = {},
): Promise<ScheduledClasses> {
  requirePermission(permissions, 'classes.class.manage');

  const start = new Date(input.startsAt);
  if (Number.isNaN(start.getTime())) {
    throw new AppError('VALIDATION_FAILED', 'That start time is not a valid date and time.', [
      { field: 'startsAt', issue: 'Not a valid date and time' },
    ]);
  }

  return withTenant(ctx, async (tx) => {
    const classType = await tx.classType.findFirst({
      where: { id: input.classTypeId },
      select: {
        id: true,
        name: true,
        defaultCapacity: true,
        defaultDurationMinutes: true,
        isActive: true,
      },
    });
    if (!classType) throw new AppError('NOT_FOUND', 'That class was not found.');
    if (!classType.isActive) {
      throw new AppError('CONFLICT', `${classType.name} has been retired. Reactivate it first.`);
    }

    const branchId = await resolveBranch(tx, ctx, permissions, input.branchId);

    if (input.trainerOrgUserId) {
      const trainer = await tx.orgUser.findFirst({
        where: { id: input.trainerOrgUserId, status: 'ACTIVE', deletedAt: null },
        select: { id: true, user: { select: { fullName: true } } },
      });
      if (!trainer) {
        throw new AppError('NOT_FOUND', 'That trainer is not on the team.');
      }
    }

    const duration = input.durationMinutes ?? classType.defaultDurationMinutes;
    const capacity = input.capacity ?? classType.defaultCapacity;
    if (duration < 5 || duration > 480) {
      throw new AppError('VALIDATION_FAILED', 'A class runs between 5 and 480 minutes.', [
        { field: 'durationMinutes', issue: 'Between 5 and 480' },
      ]);
    }
    if (capacity < 1 || capacity > 500) {
      throw new AppError('VALIDATION_FAILED', 'Capacity is between 1 and 500.', [
        { field: 'capacity', issue: 'Between 1 and 500' },
      ]);
    }

    const occurrences = plannedOccurrences(start, input.repeatOn ?? [], input.repeatWeeks ?? 0);
    const recurrenceGroupId = occurrences.length > 1 ? crypto.randomUUID() : null;
    const recurrenceRule =
      occurrences.length > 1 && (input.repeatOn ?? []).length > 0
        ? `FREQ=WEEKLY;BYDAY=${(input.repeatOn ?? [])
            .map((d) => ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][d])
            .join(',')}`
        : null;

    const ids: string[] = [];
    const created: Date[] = [];
    const skipped: Array<{ startsAt: string; reason: string }> = [];

    for (const startsAt of occurrences) {
      const endsAt = new Date(startsAt.getTime() + duration * 60_000);

      // A trainer cannot be in two rooms at once, and a room cannot hold two
      // classes. Both are checked against live occurrences only: a cancelled
      // class frees its slot.
      const clash = await tx.gymClass.findFirst({
        where: {
          cancelledAt: null,
          status: { not: 'CANCELLED' },
          startsAt: { lt: endsAt },
          endsAt: { gt: startsAt },
          ...(input.trainerOrgUserId
            ? { trainerOrgUserId: input.trainerOrgUserId }
            : { room: input.room ?? undefined, branchId }),
        },
        select: { id: true, title: true, classType: { select: { name: true } } },
      });

      if (clash && (input.trainerOrgUserId || input.room)) {
        skipped.push({
          startsAt: startsAt.toISOString(),
          reason: input.trainerOrgUserId
            ? `The trainer is already taking ${clash.title ?? clash.classType.name}`
            : `${input.room} is already booked for ${clash.title ?? clash.classType.name}`,
        });
        continue;
      }

      const row = await tx.gymClass.create({
        data: {
          organizationId: ctx.organizationId,
          branchId,
          classTypeId: input.classTypeId,
          trainerOrgUserId: input.trainerOrgUserId ?? null,
          title: input.title?.trim() || null,
          startsAt,
          endsAt,
          capacity,
          room: input.room?.trim() || null,
          notes: input.notes?.trim() || null,
          recurrenceRule,
          recurrenceGroupId,
        },
        select: { id: true },
      });
      ids.push(row.id);
      created.push(startsAt);
    }

    if (ids.length === 0) {
      throw new AppError(
        'CONFLICT',
        skipped[0]?.reason ?? 'None of those times could be scheduled.',
      );
    }

    await writeAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'classes.class.schedule',
      entityType: 'GymClass',
      entityId: ids[0]!,
      summary:
        ids.length === 1
          ? `Scheduled ${classType.name} for ${start.toISOString()}`
          : `Scheduled ${ids.length} sessions of ${classType.name}`,
      after: { count: ids.length, skipped: skipped.length },
      ipAddress: meta.ipAddress,
    });

    // The last session actually created, not the last one planned: a manager
    // extending the timetable needs to know where it really ends.
    return {
      ids,
      generatedUntil: created[created.length - 1]?.toISOString() ?? null,
      skipped,
    };
  });
}

/**
 * The occurrence times a repeat produces.
 *
 * Weekly on chosen weekdays, from the first start time, keeping the time of
 * day. Bounded by the horizon because nothing extends it automatically.
 */
export function plannedOccurrences(
  start: Date,
  repeatOn: number[],
  repeatWeeks: number,
): Date[] {
  if (repeatOn.length === 0 || repeatWeeks < 1) return [start];

  const weeks = Math.min(repeatWeeks, RECURRENCE_HORIZON_WEEKS);
  const days = [...new Set(repeatOn)].filter((d) => d >= 0 && d <= 6).sort();
  if (days.length === 0) return [start];

  const out: Date[] = [];
  // Anchor on the Sunday of the first week so weekday maths is plain.
  const anchor = new Date(start);
  anchor.setUTCDate(anchor.getUTCDate() - anchor.getUTCDay());

  for (let week = 0; week < weeks; week += 1) {
    for (const day of days) {
      const when = new Date(anchor);
      when.setUTCDate(anchor.getUTCDate() + week * 7 + day);
      when.setUTCHours(
        start.getUTCHours(),
        start.getUTCMinutes(),
        start.getUTCSeconds(),
        0,
      );
      if (when.getTime() >= start.getTime()) out.push(when);
    }
  }

  return out.length > 0 ? out : [start];
}

/** The branch a class belongs to, respecting the actor's branch scope. */
async function resolveBranch(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  ctx: ClassContext,
  permissions: ResolvedPermissions,
  requested?: string,
): Promise<string | null> {
  const scope = scopeOf(permissions, 'classes.class.manage');

  if (requested) {
    const branch = await tx.branch.findFirst({
      where: { id: requested, deletedAt: null },
      select: { id: true },
    });
    if (!branch) throw new AppError('NOT_FOUND', 'That branch was not found.');
    if (scope === 'BRANCH' && !(ctx.branchIds ?? []).includes(requested)) {
      throw new AppError(
        'BRANCH_OUT_OF_SCOPE',
        'You can only schedule classes at the branches you work at.',
      );
    }
    return requested;
  }

  // Unnamed: the actor's own branch where they have one, otherwise the
  // primary branch — the same fallback registering a member by hand uses,
  // because a class with no branch is invisible to branch-scoped staff.
  if (scope === 'BRANCH' && (ctx.branchIds ?? []).length > 0) {
    return ctx.branchIds![0]!;
  }
  const primary = await tx.branch.findFirst({
    where: { deletedAt: null },
    orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    select: { id: true },
  });
  return primary?.id ?? null;
}

// --------------------------------------------------------------- booking ---

export interface BookingResult {
  bookingId: string;
  status: 'BOOKED' | 'WAITLISTED';
  waitlistPosition: number | null;
  placesLeft: number;
  memberName: string;
  className: string;
  startsAt: string;
}

/**
 * Books a member onto a class, or onto the waitlist.
 *
 * `SELECT ... FOR UPDATE` on the class row is the whole point: two members
 * pressing Book on the last place at the same moment both read the same
 * `bookedCount` otherwise, and the class ends up over capacity with one mat
 * too few. The lock makes the second request wait and then see the truth.
 */
export async function bookClass(
  ctx: ClassContext,
  permissions: ResolvedPermissions,
  input: { classId: string; memberId: string; allowIneligible?: boolean },
  meta: { ipAddress?: string } = {},
): Promise<BookingResult> {
  requirePermission(permissions, 'classes.booking.manage');

  return withTenant(ctx, async (tx) => {
    // The lock. Scoped by organizationId as well as id: row-level security
    // already confines this, and the explicit filter means a raw statement
    // carries the tenant on its face.
    const locked = await tx.$queryRawUnsafe<
      Array<{ id: string; capacity: number; bookedCount: number; waitlistCount: number }>
    >(
      `SELECT id, capacity, "bookedCount", "waitlistCount"
         FROM classes
        WHERE id = $1::uuid AND "organizationId" = $2::uuid
        FOR UPDATE`,
      input.classId,
      ctx.organizationId,
    );

    if (locked.length === 0) throw new AppError('NOT_FOUND', 'That class was not found.');
    const lock = locked[0]!;

    const gymClass = await tx.gymClass.findFirst({
      where: { id: input.classId },
      select: {
        id: true,
        startsAt: true,
        status: true,
        cancelledAt: true,
        branchId: true,
        classType: { select: { name: true, requiresBooking: true } },
      },
    });
    if (!gymClass) throw new AppError('NOT_FOUND', 'That class was not found.');

    if (gymClass.cancelledAt || gymClass.status === 'CANCELLED') {
      throw new AppError('CONFLICT', 'That class has been cancelled.');
    }
    if (gymClass.status === 'COMPLETED') {
      throw new AppError('CONFLICT', 'That class has already finished.');
    }
    if (gymClass.startsAt.getTime() < Date.now()) {
      throw new AppError(
        'CONFLICT',
        'That class has already started. Mark the member present instead of booking them.',
      );
    }

    const member = await tx.member.findFirst({
      where: { id: input.memberId, deletedAt: null },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        status: true,
        subscriptions: {
          where: { status: { in: ['ACTIVE', 'FROZEN'] } },
          orderBy: { endDate: 'desc' },
          take: 1,
          select: { id: true, status: true, endDate: true, graceUntil: true },
        },
      },
    });
    if (!member) throw new AppError('NOT_FOUND', 'That member was not found.');

    const memberName = `${member.firstName} ${member.lastName ?? ''}`.trim();

    // The same question the door asks. A gym that lets a lapsed member book
    // a class is a gym that has a conversation at the door instead.
    const subscription = member.subscriptions[0];
    if (!input.allowIneligible) {
      if (member.status === 'SUSPENDED') {
        throw new AppError('SUBSCRIPTION_NOT_ACTIVE', `${memberName} is suspended.`);
      }
      if (!subscription) {
        throw new AppError(
          'SUBSCRIPTION_NOT_ACTIVE',
          `${memberName} has no active membership.`,
        );
      }
      if (subscription.status === 'FROZEN') {
        throw new AppError(
          'SUBSCRIPTION_NOT_ACTIVE',
          `${memberName}'s membership is frozen.`,
        );
      }
      const until = subscription.graceUntil ?? subscription.endDate;
      if (until.getTime() < gymClass.startsAt.getTime()) {
        throw new AppError(
          'SUBSCRIPTION_EXPIRED',
          `${memberName}'s membership ends before that class.`,
        );
      }
    }

    const existing = await tx.classBooking.findFirst({
      where: { classId: input.classId, memberId: input.memberId },
      select: { id: true, status: true, waitlistPosition: true },
    });

    if (existing && existing.status !== 'CANCELLED') {
      throw new AppError(
        'CONFLICT',
        existing.status === 'WAITLISTED'
          ? `${memberName} is already on the waitlist for this class.`
          : `${memberName} is already booked onto this class.`,
      );
    }

    const full = lock.bookedCount >= lock.capacity;
    const status: 'BOOKED' | 'WAITLISTED' = full ? 'WAITLISTED' : 'BOOKED';
    const waitlistPosition = full ? lock.waitlistCount + 1 : null;

    // A cancelled booking is revived rather than duplicated: the unique
    // index on (classId, memberId) means there is only ever one row, and a
    // member who changes their mind twice should not meet a constraint error.
    const booking = existing
      ? await tx.classBooking.update({
          where: { id: existing.id },
          data: {
            status,
            waitlistPosition,
            bookedAt: new Date(),
            cancelledAt: null,
            cancelReason: null,
          },
          select: { id: true },
        })
      : await tx.classBooking.create({
          data: {
            organizationId: ctx.organizationId,
            classId: input.classId,
            memberId: input.memberId,
            status,
            waitlistPosition,
          },
          select: { id: true },
        });

    await tx.gymClass.update({
      where: { id: input.classId },
      data: full
        ? { waitlistCount: { increment: 1 } }
        : { bookedCount: { increment: 1 } },
    });

    await writeAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'classes.booking.create',
      entityType: 'ClassBooking',
      entityId: booking.id,
      summary: full
        ? `${memberName} waitlisted for ${gymClass.classType.name} at position ${waitlistPosition}`
        : `${memberName} booked onto ${gymClass.classType.name}`,
      ipAddress: meta.ipAddress,
    });

    return {
      bookingId: booking.id,
      status,
      waitlistPosition,
      placesLeft: Math.max(0, lock.capacity - lock.bookedCount - (full ? 0 : 1)),
      memberName,
      className: gymClass.classType.name,
      startsAt: gymClass.startsAt.toISOString(),
    };
  });
}

export interface CancellationResult {
  memberName: string;
  /** Who moved off the waitlist into the free place, if anyone did. */
  promoted: { bookingId: string; memberId: string; memberName: string } | null;
}

/**
 * Cancels a booking and moves the waitlist.
 *
 * The promotion is the feature. Without it the member who dropped out frees
 * a place that nobody is told about, and the class runs a person short while
 * someone sits at home on a waitlist — so the first person waiting is moved
 * in, in the same transaction, and returned so the gym can tell them.
 */
export async function cancelBooking(
  ctx: ClassContext,
  permissions: ResolvedPermissions,
  input: { bookingId: string; reason?: string },
  meta: { ipAddress?: string } = {},
): Promise<CancellationResult> {
  requirePermission(permissions, 'classes.booking.manage');

  return withTenant(ctx, async (tx) => {
    const booking = await tx.classBooking.findFirst({
      where: { id: input.bookingId },
      select: {
        id: true,
        classId: true,
        status: true,
        waitlistPosition: true,
        member: { select: { firstName: true, lastName: true } },
      },
    });
    if (!booking) throw new AppError('NOT_FOUND', 'That booking was not found.');
    if (booking.status === 'CANCELLED') {
      throw new AppError('CONFLICT', 'That booking is already cancelled.');
    }
    if (booking.status === 'ATTENDED') {
      throw new AppError('CONFLICT', 'That member already attended the class.');
    }

    const memberName = `${booking.member.firstName} ${booking.member.lastName ?? ''}`.trim();
    const wasBooked = booking.status === 'BOOKED';

    // Lock the class before moving counts, for the same reason booking does.
    await tx.$queryRawUnsafe(
      `SELECT id FROM classes WHERE id = $1::uuid AND "organizationId" = $2::uuid FOR UPDATE`,
      booking.classId,
      ctx.organizationId,
    );

    await tx.classBooking.update({
      where: { id: booking.id },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelReason: input.reason?.trim() || null,
        waitlistPosition: null,
      },
    });

    let promoted: CancellationResult['promoted'] = null;

    if (wasBooked) {
      const next = await tx.classBooking.findFirst({
        where: { classId: booking.classId, status: 'WAITLISTED' },
        orderBy: [{ waitlistPosition: 'asc' }, { bookedAt: 'asc' }],
        select: {
          id: true,
          memberId: true,
          member: { select: { firstName: true, lastName: true } },
        },
      });

      if (next) {
        await tx.classBooking.update({
          where: { id: next.id },
          data: { status: 'BOOKED', waitlistPosition: null },
        });
        // The place is filled, so the booked count does not fall; the
        // waitlist shortens instead.
        await tx.gymClass.update({
          where: { id: booking.classId },
          data: { waitlistCount: { decrement: 1 } },
        });
        await renumberWaitlist(tx, booking.classId);

        promoted = {
          bookingId: next.id,
          memberId: next.memberId,
          memberName: `${next.member.firstName} ${next.member.lastName ?? ''}`.trim(),
        };
      } else {
        await tx.gymClass.update({
          where: { id: booking.classId },
          data: { bookedCount: { decrement: 1 } },
        });
      }
    } else {
      await tx.gymClass.update({
        where: { id: booking.classId },
        data: { waitlistCount: { decrement: 1 } },
      });
      await renumberWaitlist(tx, booking.classId);
    }

    await writeAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'classes.booking.cancel',
      entityType: 'ClassBooking',
      entityId: booking.id,
      summary: promoted
        ? `${memberName} cancelled; ${promoted.memberName} moved off the waitlist`
        : `${memberName} cancelled their booking`,
      ipAddress: meta.ipAddress,
    });

    return { memberName, promoted };
  });
}

/** Keeps waitlist positions as 1, 2, 3 after somebody leaves the queue. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function renumberWaitlist(tx: any, classId: string): Promise<void> {
  const waiting = await tx.classBooking.findMany({
    where: { classId, status: 'WAITLISTED' },
    orderBy: [{ waitlistPosition: 'asc' }, { bookedAt: 'asc' }],
    select: { id: true },
  });

  for (let index = 0; index < waiting.length; index += 1) {
    await tx.classBooking.update({
      where: { id: waiting[index]!.id },
      data: { waitlistPosition: index + 1 },
    });
  }
}

// ------------------------------------------------------- the register ---

export interface ClassRosterEntry {
  bookingId: string;
  memberId: string;
  memberCode: string;
  memberName: string;
  phone: string;
  status: BookingStatus;
  waitlistPosition: number | null;
  attendedAt: string | null;
}

export interface ClassDetail {
  id: string;
  title: string | null;
  classTypeId: string;
  className: string;
  colorHex: string | null;
  branchId: string | null;
  branchName: string | null;
  trainerOrgUserId: string | null;
  trainerName: string | null;
  startsAt: string;
  endsAt: string;
  capacity: number;
  bookedCount: number;
  waitlistCount: number;
  placesLeft: number;
  status: ClassStatus;
  room: string | null;
  notes: string | null;
  cancelReason: string | null;
  repeats: boolean;
  roster: ClassRosterEntry[];
}

export async function getClass(
  ctx: ClassContext,
  permissions: ResolvedPermissions,
  classId: string,
): Promise<ClassDetail> {
  requirePermission(permissions, 'classes.class.read');
  const canSeeRoster = scopeOf(permissions, 'classes.booking.read') !== null;

  return withTenant(ctx, async (tx) => {
    const row = await tx.gymClass.findFirst({
      where: { id: classId },
      select: {
        id: true,
        title: true,
        classTypeId: true,
        startsAt: true,
        endsAt: true,
        capacity: true,
        bookedCount: true,
        waitlistCount: true,
        status: true,
        room: true,
        notes: true,
        cancelReason: true,
        recurrenceGroupId: true,
        branchId: true,
        classType: { select: { name: true, colorHex: true } },
        branch: { select: { name: true } },
        trainerOrgUserId: true,
        trainer: { select: { user: { select: { fullName: true } } } },
        bookings: canSeeRoster
          ? {
              where: { status: { not: 'CANCELLED' } },
              orderBy: [{ status: 'asc' }, { waitlistPosition: 'asc' }, { bookedAt: 'asc' }],
              select: {
                id: true,
                status: true,
                waitlistPosition: true,
                attendedAt: true,
                memberId: true,
                member: {
                  select: {
                    memberCode: true,
                    firstName: true,
                    lastName: true,
                    phone: true,
                  },
                },
              },
            }
          : false,
      },
    });

    if (!row) throw new AppError('NOT_FOUND', 'That class was not found.');

    return {
      id: row.id,
      title: row.title,
      classTypeId: row.classTypeId,
      className: row.classType.name,
      colorHex: row.classType.colorHex,
      branchId: row.branchId,
      branchName: row.branch?.name ?? null,
      trainerOrgUserId: row.trainerOrgUserId,
      trainerName: row.trainer?.user.fullName ?? null,
      startsAt: row.startsAt.toISOString(),
      endsAt: row.endsAt.toISOString(),
      capacity: row.capacity,
      bookedCount: row.bookedCount,
      waitlistCount: row.waitlistCount,
      placesLeft: Math.max(0, row.capacity - row.bookedCount),
      status: row.status as ClassStatus,
      room: row.room,
      notes: row.notes,
      cancelReason: row.cancelReason,
      repeats: row.recurrenceGroupId !== null,
      roster: (row.bookings ?? []).map((b: any) => ({
        bookingId: b.id,
        memberId: b.memberId,
        memberCode: b.member.memberCode,
        memberName: `${b.member.firstName} ${b.member.lastName ?? ''}`.trim(),
        phone: b.member.phone,
        status: b.status as BookingStatus,
        waitlistPosition: b.waitlistPosition,
        attendedAt: b.attendedAt ? b.attendedAt.toISOString() : null,
      })),
    };
  });
}

export interface TimetableEntry {
  id: string;
  title: string | null;
  className: string;
  colorHex: string | null;
  trainerName: string | null;
  branchName: string | null;
  startsAt: string;
  endsAt: string;
  capacity: number;
  bookedCount: number;
  waitlistCount: number;
  placesLeft: number;
  status: ClassStatus;
  room: string | null;
}

/**
 * The timetable for a day or a week.
 *
 * Defaults to the gym's own business day rather than a UTC one, for the same
 * reason the till figure does: a 9pm class belongs to the day the gym was
 * open, not to tomorrow.
 */
export async function listClasses(
  ctx: ClassContext,
  permissions: ResolvedPermissions,
  options: {
    from?: string;
    to?: string;
    branchId?: string;
    classTypeId?: string;
    trainerOrgUserId?: string;
    includeCancelled?: boolean;
  } = {},
): Promise<{ rows: TimetableEntry[]; from: string; to: string }> {
  requirePermission(permissions, 'classes.class.read');
  const branches = branchFilter(permissions, 'classes.class.read');

  return withTenant(ctx, async (tx) => {
    const settings = await tx.orgSetting.findFirst({ select: { timezone: true } });
    const timezone = settings?.timezone ?? 'Asia/Kolkata';

    const start = options.from
      ? businessDayRange(timezone, new Date(`${options.from}T12:00:00Z`)).start
      : businessDayRange(timezone).start;
    const end = options.to
      ? businessDayRange(timezone, new Date(`${options.to}T12:00:00Z`)).end
      : businessDayRange(timezone, options.from
          ? new Date(`${options.from}T12:00:00Z`)
          : undefined).end;

    const rows = await tx.gymClass.findMany({
      where: {
        startsAt: { gte: start, lt: end },
        ...(options.includeCancelled ? {} : { cancelledAt: null }),
        ...(options.classTypeId ? { classTypeId: options.classTypeId } : {}),
        ...(options.trainerOrgUserId ? { trainerOrgUserId: options.trainerOrgUserId } : {}),
        ...(options.branchId ? { branchId: options.branchId } : {}),
        ...(branches ? { OR: [{ branchId: branches }, { branchId: null }] } : {}),
      },
      orderBy: { startsAt: 'asc' },
      select: {
        id: true,
        title: true,
        startsAt: true,
        endsAt: true,
        capacity: true,
        bookedCount: true,
        waitlistCount: true,
        status: true,
        room: true,
        classType: { select: { name: true, colorHex: true } },
        trainer: { select: { user: { select: { fullName: true } } } },
        branch: { select: { name: true } },
      },
    });

    return {
      from: start.toISOString(),
      to: end.toISOString(),
      rows: rows.map((row: any) => ({
        id: row.id,
        title: row.title,
        className: row.classType.name,
        colorHex: row.classType.colorHex,
        trainerName: row.trainer?.user.fullName ?? null,
        branchName: row.branch?.name ?? null,
        startsAt: row.startsAt.toISOString(),
        endsAt: row.endsAt.toISOString(),
        capacity: row.capacity,
        bookedCount: row.bookedCount,
        waitlistCount: row.waitlistCount,
        placesLeft: Math.max(0, row.capacity - row.bookedCount),
        status: row.status as ClassStatus,
        room: row.room,
      })),
    };
  });
}

/**
 * Marks who turned up.
 *
 * A class attendance is also a gym visit, so the member's attendance record
 * for the day is created if they have not already been through the door —
 * otherwise a member who only ever comes for the 7am class would show as
 * never attending. The record is created at MANUAL, since a person marked
 * the register rather than a scanner reading a code. The unique index on
 * (memberId, attendanceDate) is what keeps the two from double-counting.
 */
export async function markAttendance(
  ctx: ClassContext,
  permissions: ResolvedPermissions,
  input: { bookingId: string; attended: boolean },
  meta: { ipAddress?: string } = {},
): Promise<{ memberName: string; status: BookingStatus; countedAsVisit: boolean }> {
  requirePermission(permissions, 'classes.booking.manage');

  return withTenant(ctx, async (tx) => {
    const booking = await tx.classBooking.findFirst({
      where: { id: input.bookingId },
      select: {
        id: true,
        status: true,
        memberId: true,
        class: {
          select: {
            id: true,
            startsAt: true,
            branchId: true,
            classType: { select: { name: true } },
          },
        },
        member: {
          select: {
            firstName: true,
            lastName: true,
            subscriptions: {
              where: { status: { in: ['ACTIVE', 'FROZEN'] } },
              orderBy: { endDate: 'desc' },
              take: 1,
              select: { id: true, status: true },
            },
          },
        },
      },
    });
    if (!booking) throw new AppError('NOT_FOUND', 'That booking was not found.');
    if (booking.status === 'CANCELLED') {
      throw new AppError('CONFLICT', 'That booking was cancelled.');
    }

    const memberName = `${booking.member.firstName} ${booking.member.lastName ?? ''}`.trim();
    const status: BookingStatus = input.attended ? 'ATTENDED' : 'NO_SHOW';

    await tx.classBooking.update({
      where: { id: booking.id },
      data: { status, attendedAt: input.attended ? new Date() : null },
    });

    let countedAsVisit = false;

    if (input.attended) {
      const settings = await tx.orgSetting.findFirst({ select: { timezone: true } });
      const timezone = settings?.timezone ?? 'Asia/Kolkata';
      // `date` is the business day as a Date at UTC midnight, which is
      // exactly what the @db.Date column stores.
      const attendanceDate = businessDayRange(timezone, booking.class.startsAt).date;

      const already = await tx.attendance.findFirst({
        where: { memberId: booking.memberId, attendanceDate },
        select: { id: true },
      });

      if (!already) {
        await tx.attendance.create({
          data: {
            organizationId: ctx.organizationId,
            branchId: booking.class.branchId,
            memberId: booking.memberId,
            subscriptionId: booking.member.subscriptions[0]?.id ?? null,
            attendanceDate,
            checkedInAt: booking.class.startsAt,
            method: 'MANUAL',
            subscriptionStatusAtEntry:
              (booking.member.subscriptions[0]?.status as never) ?? null,
            recordedByUserId: ctx.userId,
            deviceLabel: `Class register — ${booking.class.classType.name}`,
          },
        });
        countedAsVisit = true;
      }
    }

    await writeAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'classes.booking.attendance',
      entityType: 'ClassBooking',
      entityId: booking.id,
      summary: input.attended
        ? `${memberName} attended ${booking.class.classType.name}`
        : `${memberName} did not turn up for ${booking.class.classType.name}`,
      ipAddress: meta.ipAddress,
    });

    return { memberName, status, countedAsVisit };
  });
}

/**
 * Cancels a class.
 *
 * Returns who was booked, because the next thing that has to happen is
 * telling them — and until the messaging phase lands that is a person with
 * a phone, who needs the list.
 */
export async function cancelClass(
  ctx: ClassContext,
  permissions: ResolvedPermissions,
  input: { classId: string; reason: string; wholeSeries?: boolean },
  meta: { ipAddress?: string } = {},
): Promise<{
  cancelled: number;
  toInform: Array<{ memberId: string; memberName: string; phone: string }>;
}> {
  requirePermission(permissions, 'classes.class.manage');

  if (!input.reason?.trim()) {
    throw new AppError('VALIDATION_FAILED', 'Say why the class is cancelled.', [
      { field: 'reason', issue: 'Required' },
    ]);
  }

  return withTenant(ctx, async (tx) => {
    const target = await tx.gymClass.findFirst({
      where: { id: input.classId },
      select: {
        id: true,
        recurrenceGroupId: true,
        startsAt: true,
        classType: { select: { name: true } },
      },
    });
    if (!target) throw new AppError('NOT_FOUND', 'That class was not found.');

    // A series cancellation only ever affects what has not happened yet:
    // rewriting the past would take attendance records with it.
    const ids: string[] = input.wholeSeries && target.recurrenceGroupId
      ? (
          await tx.gymClass.findMany({
            where: {
              recurrenceGroupId: target.recurrenceGroupId,
              cancelledAt: null,
              startsAt: { gte: target.startsAt },
            },
            select: { id: true },
          })
        ).map((c: { id: string }) => c.id)
      : [input.classId];

    const bookings = await tx.classBooking.findMany({
      where: { classId: { in: ids }, status: { in: ['BOOKED', 'WAITLISTED'] } },
      select: {
        id: true,
        memberId: true,
        member: { select: { firstName: true, lastName: true, phone: true } },
      },
    });

    await tx.classBooking.updateMany({
      where: { classId: { in: ids }, status: { in: ['BOOKED', 'WAITLISTED'] } },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelReason: `Class cancelled — ${input.reason.trim()}`,
        waitlistPosition: null,
      },
    });

    await tx.gymClass.updateMany({
      where: { id: { in: ids } },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelReason: input.reason.trim(),
      },
    });

    await writeAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'classes.class.cancel',
      entityType: 'GymClass',
      entityId: input.classId,
      summary:
        ids.length === 1
          ? `Cancelled ${target.classType.name} — ${input.reason.trim()}`
          : `Cancelled ${ids.length} sessions of ${target.classType.name} — ${input.reason.trim()}`,
      after: { sessions: ids.length, bookingsAffected: bookings.length },
      ipAddress: meta.ipAddress,
    });

    // De-duplicated: one member booked onto several sessions of a cancelled
    // series needs telling once, not six times.
    const seen = new Set<string>();
    const toInform: Array<{ memberId: string; memberName: string; phone: string }> = [];
    for (const booking of bookings) {
      if (seen.has(booking.memberId)) continue;
      seen.add(booking.memberId);
      toInform.push({
        memberId: booking.memberId,
        memberName: `${booking.member.firstName} ${booking.member.lastName ?? ''}`.trim(),
        phone: booking.member.phone,
      });
    }

    return { cancelled: ids.length, toInform };
  });
}

/**
 * A member's own classes — what the member app and the member's profile
 * both need: what they have booked, and what they have been to.
 */
export async function memberClasses(
  ctx: ClassContext,
  permissions: ResolvedPermissions,
  memberId: string,
  options: { upcoming?: boolean; limit?: number } = {},
): Promise<Array<{
  bookingId: string;
  classId: string;
  className: string;
  startsAt: string;
  status: BookingStatus;
  waitlistPosition: number | null;
  trainerName: string | null;
}>> {
  requirePermission(permissions, 'classes.booking.read');

  return withTenant(ctx, async (tx) => {
    const rows = await tx.classBooking.findMany({
      where: {
        memberId,
        ...(options.upcoming === false
          ? {}
          : { class: { startsAt: { gte: new Date() } }, status: { not: 'CANCELLED' } }),
      },
      orderBy: { class: { startsAt: options.upcoming === false ? 'desc' : 'asc' } },
      take: Math.min(options.limit ?? 20, 100),
      select: {
        id: true,
        status: true,
        waitlistPosition: true,
        classId: true,
        class: {
          select: {
            startsAt: true,
            classType: { select: { name: true } },
            trainer: { select: { user: { select: { fullName: true } } } },
          },
        },
      },
    });

    return rows.map((row: any) => ({
      bookingId: row.id,
      classId: row.classId,
      className: row.class.classType.name,
      startsAt: row.class.startsAt.toISOString(),
      status: row.status as BookingStatus,
      waitlistPosition: row.waitlistPosition,
      trainerName: row.class.trainer?.user.fullName ?? null,
    }));
  });
}
