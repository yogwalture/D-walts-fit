import { withTenant } from '@gym/db';
import { AppError } from '../errors';
import { requirePermission, type ResolvedPermissions } from '../rbac/engine';
import { businessDayIso, today } from '../shared/dates';
import { toPaise, toRupees } from '../shared/money';

/**
 * The member's own view of themselves.
 *
 * Every function here takes the member id from the session's context and
 * never from an argument a caller could choose. That is the whole security
 * model of this file: a portal that read the id out of a URL would show
 * somebody else's invoices to anyone who edited it, and no amount of
 * permission checking fixes that, because the permission would be real.
 *
 * It is also deliberately read-mostly. A member can see everything about
 * themselves, book a class, and check in — and nothing else. Changing a
 * membership, taking a payment at the counter, or seeing another member is
 * staff work.
 */

export interface PortalContext {
  organizationId: string;
  userId: string;
  memberId: string;
}

function requireMember(ctx: { memberId?: string | null }): string {
  if (!ctx.memberId) {
    throw new AppError('FORBIDDEN', 'This is only available to a member of the gym.');
  }
  return ctx.memberId;
}

export interface MemberHome {
  member: {
    id: string;
    memberCode: string;
    name: string;
    phone: string;
    email: string | null;
    branchName: string | null;
    joinedOn: string;
  };
  membership: {
    planName: string;
    status: string;
    startDate: string;
    endDate: string;
    graceUntil: string | null;
    daysLeft: number;
    sessionsLeft: number | null;
    isFrozen: boolean;
  } | null;
  dues: { amount: string; invoices: number };
  visits: { thisMonth: number; lastVisit: string | null; total: number };
  upcomingClasses: Array<{
    bookingId: string;
    classId: string;
    className: string;
    startsAt: string;
    status: string;
    waitlistPosition: number | null;
  }>;
}

export async function memberHome(
  ctx: { organizationId: string; userId: string; memberId?: string | null },
  permissions: ResolvedPermissions,
): Promise<MemberHome> {
  requirePermission(permissions, 'self.membership.read');
  const memberId = requireMember(ctx);

  return withTenant(ctx, async (tx) => {
    const member = await tx.member.findFirst({
      where: { id: memberId, deletedAt: null },
      select: {
        id: true,
        memberCode: true,
        firstName: true,
        lastName: true,
        phone: true,
        email: true,
        joiningDate: true,
        branch: { select: { name: true, timezone: true } },
        subscriptions: {
          where: { status: { in: ['ACTIVE', 'FROZEN'] } },
          orderBy: { endDate: 'desc' },
          take: 1,
          select: {
            status: true,
            startDate: true,
            endDate: true,
            graceUntil: true,
            sessionsTotal: true,
            sessionsConsumed: true,
            plan: { select: { name: true } },
          },
        },
      },
    });
    if (!member) throw new AppError('NOT_FOUND', 'That member record was not found.');

    const timezone = member.branch?.timezone ?? 'Asia/Kolkata';
    const now = today();
    const monthStart = new Date(`${businessDayIso(timezone).slice(0, 7)}-01T00:00:00.000Z`);

    const [invoices, visitsThisMonth, lastVisit, totalVisits, bookings] = await Promise.all([
      tx.invoice.findMany({
        // Bounded: more than 5,000 invoices for one gym is a data
        // problem, and a truncated list beats a request that times out.
        take: 5000,
        where: { memberId, status: { in: ['ISSUED', 'PARTIALLY_PAID'] } },
        select: { amountDue: true },
      }),
      tx.attendance.count({ where: { memberId, attendanceDate: { gte: monthStart } } }),
      tx.attendance.findFirst({
        where: { memberId },
        orderBy: { attendanceDate: 'desc' },
        select: { attendanceDate: true },
      }),
      tx.attendance.count({ where: { memberId } }),
      tx.classBooking.findMany({
        where: {
          memberId,
          status: { in: ['BOOKED', 'WAITLISTED'] },
          class: { startsAt: { gte: new Date() }, cancelledAt: null },
        },
        orderBy: { class: { startsAt: 'asc' } },
        take: 5,
        select: {
          id: true,
          classId: true,
          status: true,
          waitlistPosition: true,
          class: { select: { startsAt: true, classType: { select: { name: true } } } },
        },
      }),
    ]);

    const duePaise = invoices.reduce(
      (sum: number, invoice: any) => sum + toPaise(invoice.amountDue.toString()),
      0,
    );

    const subscription = member.subscriptions[0];

    return {
      member: {
        id: member.id,
        memberCode: member.memberCode,
        name: `${member.firstName} ${member.lastName ?? ''}`.trim(),
        phone: member.phone,
        email: member.email,
        branchName: member.branch?.name ?? null,
        joinedOn: member.joiningDate.toISOString().slice(0, 10),
      },
      membership: subscription
        ? {
            planName: subscription.plan.name,
            status: subscription.status,
            startDate: subscription.startDate.toISOString().slice(0, 10),
            endDate: subscription.endDate.toISOString().slice(0, 10),
            graceUntil: subscription.graceUntil
              ? subscription.graceUntil.toISOString().slice(0, 10)
              : null,
            daysLeft: Math.round(
              (subscription.endDate.getTime() - now.getTime()) / 86_400_000,
            ),
            sessionsLeft:
              subscription.sessionsTotal === null
                ? null
                : Math.max(0, subscription.sessionsTotal - subscription.sessionsConsumed),
            isFrozen: subscription.status === 'FROZEN',
          }
        : null,
      dues: { amount: toRupees(duePaise), invoices: invoices.filter((i: any) => toPaise(i.amountDue.toString()) > 0).length },
      visits: {
        thisMonth: visitsThisMonth,
        lastVisit: lastVisit ? lastVisit.attendanceDate.toISOString().slice(0, 10) : null,
        total: totalVisits,
      },
      upcomingClasses: bookings.map((booking: any) => ({
        bookingId: booking.id,
        classId: booking.classId,
        className: booking.class.classType.name,
        startsAt: booking.class.startsAt.toISOString(),
        status: booking.status,
        waitlistPosition: booking.waitlistPosition,
      })),
    };
  });
}

export interface MemberVisit {
  date: string;
  checkedInAt: string;
  method: string;
}

export async function memberVisits(
  ctx: { organizationId: string; userId: string; memberId?: string | null },
  permissions: ResolvedPermissions,
  options: { limit?: number } = {},
): Promise<{ rows: MemberVisit[]; streak: number }> {
  requirePermission(permissions, 'self.attendance.read');
  const memberId = requireMember(ctx);

  return withTenant(ctx, async (tx) => {
    const rows = await tx.attendance.findMany({
      where: { memberId },
      orderBy: { attendanceDate: 'desc' },
      take: Math.min(options.limit ?? 60, 200),
      select: { attendanceDate: true, checkedInAt: true, method: true },
    });

    // Consecutive days up to the most recent visit. Counted from the last
    // visit rather than from today, so a streak is not broken by looking at
    // the page before training.
    let streak = 0;
    if (rows.length > 0) {
      let cursor = rows[0]!.attendanceDate.getTime();
      for (const row of rows) {
        if (row.attendanceDate.getTime() === cursor) {
          streak += 1;
          cursor -= 86_400_000;
        } else if (row.attendanceDate.getTime() < cursor) {
          break;
        }
      }
    }

    return {
      streak,
      rows: rows.map((row: any) => ({
        date: row.attendanceDate.toISOString().slice(0, 10),
        checkedInAt: row.checkedInAt.toISOString(),
        method: row.method,
      })),
    };
  });
}

export interface MemberPayment {
  id: string;
  kind: 'PAYMENT' | 'INVOICE';
  code: string | null;
  description: string;
  amount: string;
  amountDue: string | null;
  status: string;
  date: string;
}

/**
 * What they have paid, and what they still owe.
 *
 * Invoices and payments together, because "what do I owe" and "what did I
 * pay in March" are the same question asked from two ends, and a member
 * does not know which of our tables holds the answer.
 */
export async function memberPayments(
  ctx: { organizationId: string; userId: string; memberId?: string | null },
  permissions: ResolvedPermissions,
  options: { limit?: number } = {},
): Promise<{ rows: MemberPayment[]; outstanding: string }> {
  requirePermission(permissions, 'self.payment.read');
  const memberId = requireMember(ctx);

  return withTenant(ctx, async (tx) => {
    const [invoices, payments] = await Promise.all([
      tx.invoice.findMany({
        where: { memberId, status: { not: 'CANCELLED' } },
        orderBy: { issueDate: 'desc' },
        take: Math.min(options.limit ?? 30, 100),
        select: {
          id: true,
          invoiceCode: true,
          total: true,
          amountDue: true,
          status: true,
          issueDate: true,
          lines: { select: { description: true }, take: 2 },
        },
      }),
      tx.payment.findMany({
        where: { memberId, status: 'CAPTURED' },
        orderBy: { receivedAt: 'desc' },
        take: Math.min(options.limit ?? 30, 100),
        select: {
          id: true,
          receiptCode: true,
          amount: true,
          method: true,
          receivedAt: true,
        },
      }),
    ]);

    const outstanding = invoices.reduce(
      (sum: number, invoice: any) => sum + toPaise(invoice.amountDue.toString()),
      0,
    );

    const rows: MemberPayment[] = [
      ...invoices.map((invoice: any) => ({
        id: invoice.id,
        kind: 'INVOICE' as const,
        code: invoice.invoiceCode,
        description:
          invoice.lines.map((line: any) => line.description).join(', ') || 'Invoice',
        amount: Number(invoice.total).toFixed(2),
        amountDue: Number(invoice.amountDue).toFixed(2),
        status: invoice.status,
        date: invoice.issueDate.toISOString().slice(0, 10),
      })),
      ...payments.map((payment: any) => ({
        id: payment.id,
        kind: 'PAYMENT' as const,
        code: payment.receiptCode,
        description: `Paid by ${payment.method.replace('_', ' ').toLowerCase()}`,
        amount: Number(payment.amount).toFixed(2),
        amountDue: null,
        status: 'PAID',
        date: payment.receivedAt.toISOString().slice(0, 10),
      })),
    ].sort((a, b) => b.date.localeCompare(a.date));

    return { rows, outstanding: toRupees(outstanding) };
  });
}

export interface MemberClassRow {
  id: string;
  className: string;
  trainerName: string | null;
  startsAt: string;
  endsAt: string;
  room: string | null;
  placesLeft: number;
  capacity: number;
  /** Where this member stands on this class right now. */
  myBookingId: string | null;
  myStatus: string | null;
  myWaitlistPosition: number | null;
}

/**
 * The classes a member can book, with their own standing on each.
 *
 * One list rather than two, because "what is on" and "what have I booked"
 * are the same screen in a member's head, and a separate bookings page is
 * where double bookings come from.
 */
export async function memberClassList(
  ctx: { organizationId: string; userId: string; memberId?: string | null },
  permissions: ResolvedPermissions,
  options: { days?: number } = {},
): Promise<MemberClassRow[]> {
  requirePermission(permissions, 'self.class.read');
  const memberId = requireMember(ctx);

  return withTenant(ctx, async (tx) => {
    const member = await tx.member.findFirst({
      where: { id: memberId },
      select: { branchId: true },
    });

    const from = new Date();
    const to = new Date(from.getTime() + (options.days ?? 7) * 86_400_000);

    const classes = await tx.gymClass.findMany({
      where: {
        startsAt: { gte: from, lte: to },
        cancelledAt: null,
        status: { not: 'CANCELLED' },
        // A member sees what is on where they train, plus anything the gym
        // runs for everybody.
        ...(member?.branchId
          ? { OR: [{ branchId: member.branchId }, { branchId: null }] }
          : {}),
      },
      orderBy: { startsAt: 'asc' },
      take: 100,
      select: {
        id: true,
        startsAt: true,
        endsAt: true,
        capacity: true,
        bookedCount: true,
        room: true,
        title: true,
        classType: { select: { name: true } },
        trainer: { select: { user: { select: { fullName: true } } } },
        bookings: {
          where: { memberId, status: { not: 'CANCELLED' } },
          select: { id: true, status: true, waitlistPosition: true },
          take: 1,
        },
      },
    });

    return classes.map((row: any) => {
      const mine = row.bookings[0];
      return {
        id: row.id,
        className: row.title ?? row.classType.name,
        trainerName: row.trainer?.user.fullName ?? null,
        startsAt: row.startsAt.toISOString(),
        endsAt: row.endsAt.toISOString(),
        room: row.room,
        capacity: row.capacity,
        placesLeft: Math.max(0, row.capacity - row.bookedCount),
        myBookingId: mine?.id ?? null,
        myStatus: mine?.status ?? null,
        myWaitlistPosition: mine?.waitlistPosition ?? null,
      };
    });
  });
}

/**
 * A member booking themselves onto a class.
 *
 * Reuses the staff booking service rather than reimplementing capacity and
 * the waitlist — two implementations of "is there a place left" is how a
 * class ends up oversold by the member app while the front desk shows it
 * full. The member id comes from the session, so a crafted request cannot
 * book somebody else.
 */
export async function bookClassAsMember(
  ctx: { organizationId: string; userId: string; memberId?: string | null },
  permissions: ResolvedPermissions,
  input: { classId: string },
  meta: { ipAddress?: string } = {},
): Promise<{ status: string; waitlistPosition: number | null; className: string }> {
  requirePermission(permissions, 'self.class.book');
  const memberId = requireMember(ctx);

  const { bookClass } = await import('../classes/service');

  const result = await bookClass(
    { organizationId: ctx.organizationId, userId: ctx.userId },
    // The member's own permission to book is what was checked above; the
    // booking service wants the staff-side key, which a member does not
    // hold. Granting it here, scoped to this one call and this one member,
    // keeps the capacity rules in one place.
    {
      ...permissions,
      grants: { ...permissions.grants, 'classes.booking.manage': 'OWN' },
    },
    { classId: input.classId, memberId },
    meta,
  );

  return {
    status: result.status,
    waitlistPosition: result.waitlistPosition,
    className: result.className,
  };
}

export async function cancelBookingAsMember(
  ctx: { organizationId: string; userId: string; memberId?: string | null },
  permissions: ResolvedPermissions,
  input: { bookingId: string },
  meta: { ipAddress?: string } = {},
): Promise<{ promoted: boolean }> {
  requirePermission(permissions, 'self.class.book');
  const memberId = requireMember(ctx);

  // Theirs, and only theirs: the booking id is checked against this member
  // before the shared service is allowed anywhere near it.
  const owned = await withTenant(ctx, async (tx) =>
    tx.classBooking.findFirst({
      where: { id: input.bookingId, memberId },
      select: { id: true },
    }),
  );
  if (!owned) throw new AppError('NOT_FOUND', 'That booking was not found.');

  const { cancelBooking } = await import('../classes/service');

  const result = await cancelBooking(
    { organizationId: ctx.organizationId, userId: ctx.userId },
    {
      ...permissions,
      grants: { ...permissions.grants, 'classes.booking.manage': 'OWN' },
    },
    { bookingId: input.bookingId, reason: 'Cancelled by the member' },
    meta,
  );

  return { promoted: result.promoted !== null };
}

export interface SelfCheckInResult {
  allowed: boolean;
  message: string;
  attendanceId?: string;
}

/**
 * A member checking themselves in from their own phone.
 *
 * The branch QR carries the branch, the session carries the member, and the
 * eligibility rules are the door's own — the same service, so a membership
 * that would be refused at the desk is refused here too. A member app that
 * waved people past an expired membership would be worse than no app.
 */
export async function selfCheckIn(
  ctx: { organizationId: string; userId: string; memberId?: string | null },
  permissions: ResolvedPermissions,
  input: { code: string },
): Promise<SelfCheckInResult> {
  requirePermission(permissions, 'self.attendance.checkin');
  const memberId = requireMember(ctx);

  const { checkInByBranchQr } = await import('../attendance/service');

  const result = await checkInByBranchQr(
    { organizationId: ctx.organizationId, userId: ctx.userId, memberId },
    { branchQrToken: input.code },
  );

  return {
    allowed: result.allowed,
    message: result.message ?? (result.allowed ? 'Checked in.' : 'Not checked in.'),
    attendanceId: result.attendanceId,
  };
}
