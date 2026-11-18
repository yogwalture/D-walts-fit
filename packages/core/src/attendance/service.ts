import { Prisma, withTenant } from '@gym/db';
import { AppError } from '../errors';
import { writeAudit } from '../audit/log';
import {
  requirePermission,
  assertBranchAllowed,
  type ResolvedPermissions,
} from '../rbac/engine';
import { generateToken, hashToken } from '../auth/password';
import { businessDay, isOnOrAfter, startOfDay } from '../shared/dates';

/**
 * Attendance.
 *
 * Check-in is the single most-used screen in a gym: forty people in twenty
 * minutes at 6 a.m., one receptionist, one phone. So it is one endpoint, one
 * round trip, and every rule is decided server-side — eligibility, duplicates
 * and branch scope included.
 *
 * The business day comes from the BRANCH's timezone, not the server's.
 * Hostinger runs UTC, so a 5:30 a.m. check-in in Maharashtra is midnight UTC
 * and would otherwise be recorded on the previous day.
 */

export interface AttendanceContext {
  organizationId: string;
  userId: string;
  branchIds?: string[];
}

export type CheckInRefusal =
  | 'NO_MEMBERSHIP'
  | 'EXPIRED'
  | 'FROZEN'
  | 'CANCELLED'
  | 'MEMBER_SUSPENDED'
  | 'ALREADY_CHECKED_IN'
  | 'WRONG_BRANCH';

/** Enough to show reception who is at the desk. */
export interface MemberIdentity {
  id: string;
  memberCode: string;
  name: string;
  photoFileKey: string | null;
  phone: string;
}

export interface CheckInResult {
  allowed: boolean;
  refusal?: CheckInRefusal;
  message: string;
  attendanceId?: string;
  member: MemberIdentity;
  membership?: {
    planName: string;
    endDate: Date;
    daysRemaining: number;
    inGracePeriod: boolean;
    sessionsRemaining: number | null;
  };
  /** Set when an override was used to let an ineligible member in. */
  overrideUsed?: boolean;
}

/**
 * Member QR tokens.
 *
 * Rotatable rather than static: a static code can be screenshotted and
 * passed to a friend, and sharing a membership is the commonest abuse in a
 * gym. Re-issuing revokes the previous token, so the screenshot stops
 * working the moment the member asks for a new card.
 */
export async function issueMemberQr(
  ctx: AttendanceContext,
  input: { memberId: string },
): Promise<{ token: string; payload: string }> {
  return withTenant(ctx, async (tx) => {
    const member = await tx.member.findFirst({
      where: { id: input.memberId, deletedAt: null },
      select: { id: true, memberCode: true },
    });
    if (!member) throw new AppError('NOT_FOUND', 'Member not found.');

    const organization = await tx.organization.findFirst({ select: { slug: true } });
    const issued = generateToken(24);

    await tx.memberQrToken.updateMany({
      where: { memberId: member.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    await tx.memberQrToken.create({
      data: {
        organizationId: ctx.organizationId,
        memberId: member.id,
        tokenHash: issued.hash,
      },
    });

    return {
      token: issued.token,
      payload: `gymcloud:m:${organization?.slug ?? ''}:${issued.token}`,
    };
  });
}

/** The code displayed at the entrance for members to scan from the app. */
export async function issueBranchQr(
  ctx: AttendanceContext,
  permissions: ResolvedPermissions,
  input: { branchId: string; label?: string },
): Promise<{ token: string; payload: string }> {
  requirePermission(permissions, 'attendance.checkin.create');
  assertBranchAllowed(permissions, input.branchId);

  return withTenant(ctx, async (tx) => {
    const branch = await tx.branch.findFirst({
      where: { id: input.branchId, deletedAt: null },
      select: { id: true },
    });
    if (!branch) throw new AppError('NOT_FOUND', 'Branch not found.');

    const organization = await tx.organization.findFirst({ select: { slug: true } });
    const issued = generateToken(24);

    await tx.branchQrCode.updateMany({
      where: { branchId: branch.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    await tx.branchQrCode.create({
      data: {
        organizationId: ctx.organizationId,
        branchId: branch.id,
        tokenHash: issued.hash,
        label: input.label,
      },
    });

    return {
      token: issued.token,
      payload: `gymcloud:b:${organization?.slug ?? ''}:${issued.token}`,
    };
  });
}

export interface CheckInInput {
  /** One of these identifies the member. */
  memberId?: string;
  memberCode?: string;
  phone?: string;
  qrToken?: string;
  branchId?: string;
  method?: 'MEMBER_QR' | 'BRANCH_QR' | 'MANUAL' | 'SEARCH' | 'KIOSK';
  /** Lets reception admit a member whose membership has lapsed. Audited. */
  override?: boolean;
  overrideReason?: string;
}

/**
 * Records a visit, or says why it cannot.
 *
 * The duplicate-scan recovery lives in `checkIn` below, outside the
 * transaction, because PostgreSQL aborts a transaction the moment a statement
 * in it fails: nothing can be read from `tx` after the unique index fires.
 */
async function attemptCheckIn(
  ctx: AttendanceContext,
  permissions: ResolvedPermissions,
  input: CheckInInput,
  meta: { ipAddress?: string; deviceLabel?: string } = {},
): Promise<CheckInResult> {
  return withTenant(ctx, async (tx) => {
    // --- identify ---------------------------------------------------------
    const where = input.qrToken
      ? { qrTokens: { some: { tokenHash: hashToken(input.qrToken), revokedAt: null } } }
      : input.memberId
        ? { id: input.memberId }
        : input.memberCode
          ? { memberCode: input.memberCode.trim().toUpperCase() }
          : input.phone
            ? { phone: input.phone.trim() }
            : null;

    if (!where) {
      throw new AppError('VALIDATION_FAILED', 'Scan a code, or search by name, code or phone.');
    }

    const member = await tx.member.findFirst({
      where: { ...where, deletedAt: null },
      select: {
        id: true,
        memberCode: true,
        firstName: true,
        lastName: true,
        phone: true,
        photoFileKey: true,
        status: true,
        branchId: true,
        branch: { select: { id: true, name: true, timezone: true } },
        subscriptions: {
          where: { status: { in: ['ACTIVE', 'FROZEN'] }, deletedAt: null },
          orderBy: { endDate: 'desc' },
          take: 1,
          select: {
            id: true,
            status: true,
            endDate: true,
            graceUntil: true,
            branchId: true,
            sessionsTotal: true,
            sessionsConsumed: true,
            plan: { select: { name: true } },
          },
        },
      },
    });

    if (!member) {
      throw new AppError('NOT_FOUND', 'No member found for that code.');
    }

    const identity = {
      id: member.id,
      memberCode: member.memberCode,
      name: [member.firstName, member.lastName].filter(Boolean).join(' '),
      photoFileKey: member.photoFileKey,
      phone: member.phone,
    };

    const branchId = input.branchId ?? member.branchId ?? null;
    if (branchId) assertBranchAllowed(permissions, branchId);

    // The branch's own timezone decides which day this is.
    const timezone = member.branch?.timezone ?? 'Asia/Kolkata';
    const attendanceDate = businessDay(timezone);

    // --- already in today? -------------------------------------------------
    const existing = await tx.attendance.findFirst({
      where: { memberId: member.id, attendanceDate },
      select: { id: true, checkedInAt: true },
    });

    if (existing) {
      return {
        allowed: false,
        refusal: 'ALREADY_CHECKED_IN',
        message: `${identity.name} already checked in today.`,
        attendanceId: existing.id,
        member: identity,
      };
    }

    // --- eligible? ---------------------------------------------------------
    const subscription = member.subscriptions[0];
    const refuse = (refusal: CheckInRefusal, message: string): CheckInResult => ({
      allowed: false,
      refusal,
      message,
      member: identity,
    });

    if (member.status === 'SUSPENDED') {
      if (!input.override) return refuse('MEMBER_SUSPENDED', `${identity.name} is suspended.`);
    }

    if (!subscription) {
      if (!input.override) {
        return refuse('NO_MEMBERSHIP', `${identity.name} has no active membership.`);
      }
    }

    let inGracePeriod = false;

    if (subscription) {
      const limit = subscription.graceUntil ?? subscription.endDate;
      if (!isOnOrAfter(limit, attendanceDate)) {
        if (!input.override) {
          return refuse(
            'EXPIRED',
            `${identity.name}'s membership ended on ${subscription.endDate
              .toISOString()
              .slice(0, 10)}.`,
          );
        }
      }
      inGracePeriod =
        !isOnOrAfter(subscription.endDate, attendanceDate) &&
        isOnOrAfter(limit, attendanceDate);

      if (subscription.status === 'FROZEN' && !input.override) {
        return refuse('FROZEN', `${identity.name}'s membership is frozen.`);
      }

      if (
        subscription.sessionsTotal !== null &&
        subscription.sessionsConsumed >= subscription.sessionsTotal &&
        !input.override
      ) {
        return refuse('EXPIRED', `${identity.name} has used all their sessions.`);
      }
    }

    if (input.override && !input.overrideReason?.trim()) {
      throw new AppError('VALIDATION_FAILED', 'Record why this member is being let in.', [
        { field: 'overrideReason', issue: 'Required for an override' },
      ]);
    }

    // --- record ------------------------------------------------------------
    // The unique index on (memberId, attendanceDate) is the real duplicate
    // guard: two scans a second apart both pass the check above, and the
    // database settles it.
    let attendanceId: string;
    try {
      const attendance = await tx.attendance.create({
        data: {
          organizationId: ctx.organizationId,
          branchId,
          memberId: member.id,
          subscriptionId: subscription?.id ?? null,
          attendanceDate,
          checkedInAt: new Date(),
          method: input.method ?? (input.qrToken ? 'MEMBER_QR' : 'SEARCH'),
          subscriptionStatusAtEntry: subscription?.status ?? null,
          wasOverride: Boolean(input.override),
          overrideReason: input.override ? input.overrideReason : null,
          recordedByUserId: ctx.userId,
          deviceLabel: meta.deviceLabel,
        },
        select: { id: true },
      });
      attendanceId = attendance.id;
    } catch (error) {
      // No database call may follow here: the transaction is already aborted.
      // Carry what reception needs out in the error and let `checkIn` read the
      // winning row in a fresh transaction.
      if (isDuplicateAttendance(error)) {
        throw new DuplicateScanError(identity, member.id, attendanceDate);
      }
      throw error;
    }

    if (subscription?.sessionsTotal !== null && subscription) {
      await tx.subscription.update({
        where: { id: subscription.id },
        data: { sessionsConsumed: { increment: 1 } },
      });
    }

    await tx.member.update({
      where: { id: member.id },
      data: { lastVisitAt: new Date() },
    });

    if (input.override) {
      await writeAudit(tx, {
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        action: 'attendance.override',
        entityType: 'Attendance',
        entityId: attendanceId,
        summary: `${identity.name} admitted despite an ineligible membership — ${input.overrideReason}`,
        ipAddress: meta.ipAddress,
      });
    }

    const daysRemaining = subscription
      ? Math.max(
          0,
          Math.round(
            (startOfDay(subscription.endDate).getTime() - attendanceDate.getTime()) / 86_400_000,
          ),
        )
      : 0;

    return {
      allowed: true,
      message: inGracePeriod
        ? `Welcome back, ${member.firstName}. Membership expired — ${daysRemaining === 0 ? 'in grace period' : ''} please renew.`
        : `Welcome, ${member.firstName}.`,
      attendanceId,
      member: identity,
      overrideUsed: input.override || undefined,
      membership: subscription
        ? {
            planName: subscription.plan.name,
            endDate: subscription.endDate,
            daysRemaining,
            inGracePeriod,
            sessionsRemaining:
              subscription.sessionsTotal === null
                ? null
                : Math.max(0, subscription.sessionsTotal - subscription.sessionsConsumed - 1),
          }
        : undefined,
    };
  });
}

/**
 * Was this the unique index on (memberId, attendanceDate) firing?
 *
 * Only ever asked of an error thrown by the one `attendance.create` below,
 * and `Attendance` carries exactly one unique constraint — so a P2002 from
 * there can only be a second scan on the same day.
 *
 * Prisma does not always populate `meta.target` (it arrives as "not
 * available" here), so the columns are checked only when they are reported:
 * enough to keep a future second unique index on the table from being
 * silently reported to reception as a cheerful "already checked in".
 */
function isDuplicateAttendance(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code !== 'P2002') return false;

  const target = error.meta?.target;
  if (!Array.isArray(target)) return true;

  const fields = target.join(',');
  return fields.includes('memberId') && fields.includes('attendanceDate');
}

/** Carries the identity out of the aborted transaction. Never thrown to callers. */
class DuplicateScanError extends Error {
  constructor(
    readonly identity: MemberIdentity,
    readonly memberId: string,
    readonly attendanceDate: Date,
  ) {
    super('Duplicate scan');
  }
}

/**
 * Records a visit.
 *
 * Two scans in the same second both pass the eligibility checks, and the
 * unique index settles it. The loser's transaction is rolled back whole — so
 * the recovery runs here, in a new transaction, rather than inside the
 * aborted one.
 */
export async function checkIn(
  ctx: AttendanceContext,
  permissions: ResolvedPermissions,
  input: CheckInInput,
  meta: { ipAddress?: string; deviceLabel?: string } = {},
): Promise<CheckInResult> {
  requirePermission(permissions, 'attendance.checkin.create');

  try {
    return await attemptCheckIn(ctx, permissions, input, meta);
  } catch (error) {
    if (!(error instanceof DuplicateScanError)) throw error;

    const winner = await withTenant(ctx, (tx) =>
      tx.attendance.findFirst({
        where: { memberId: error.memberId, attendanceDate: error.attendanceDate },
        select: { id: true },
      }),
    );

    return {
      allowed: false,
      refusal: 'ALREADY_CHECKED_IN',
      message: `${error.identity.name} already checked in today.`,
      attendanceId: winner?.id,
      member: error.identity,
    };
  }
}

/** Members may scan the gym's code from their own app. */
export async function checkInByBranchQr(
  ctx: AttendanceContext & { memberId: string },
  input: { branchQrToken: string },
): Promise<CheckInResult> {
  return withTenant(ctx, async (tx) => {
    const branchQr = await tx.branchQrCode.findFirst({
      where: { tokenHash: hashToken(input.branchQrToken), revokedAt: null },
      select: { branchId: true },
    });
    if (!branchQr) {
      throw new AppError('NOT_FOUND', 'That code is not valid. Ask reception for the current one.');
    }

    // The member is the actor, so the permission check is self-scoped rather
    // than the staff check-in permission.
    const selfPermissions = {
      grants: { 'attendance.checkin.create': 'ALL' as const },
      roleKey: 'MEMBER',
      branchIds: [],
      isPlatformAdmin: false,
      features: new Set<string>(),
      lockedByPlan: {},
    };

    return checkIn(ctx, selfPermissions, {
      memberId: ctx.memberId,
      branchId: branchQr.branchId,
      method: 'BRANCH_QR',
    });
  });
}

export async function checkOut(
  ctx: AttendanceContext,
  permissions: ResolvedPermissions,
  input: { attendanceId: string },
): Promise<{ durationMinutes: number }> {
  requirePermission(permissions, 'attendance.checkin.create');

  return withTenant(ctx, async (tx) => {
    const attendance = await tx.attendance.findFirst({
      where: { id: input.attendanceId, checkedOutAt: null },
      select: { id: true, checkedInAt: true },
    });
    if (!attendance) throw new AppError('NOT_FOUND', 'No open check-in found.');

    const now = new Date();
    const durationMinutes = Math.max(
      1,
      Math.round((now.getTime() - attendance.checkedInAt.getTime()) / 60_000),
    );

    await tx.attendance.update({
      where: { id: attendance.id },
      data: { checkedOutAt: now, durationMinutes },
    });

    return { durationMinutes };
  });
}

// ------------------------------------------------------------- reporting ---

export async function todaysAttendance(
  ctx: AttendanceContext,
  permissions: ResolvedPermissions,
  options: { branchId?: string; limit?: number } = {},
) {
  requirePermission(permissions, 'attendance.record.read');

  return withTenant(ctx, async (tx) => {
    const date = businessDay();
    const rows = await tx.attendance.findMany({
      where: { attendanceDate: date, ...(options.branchId ? { branchId: options.branchId } : {}) },
      orderBy: { checkedInAt: 'desc' },
      take: Math.min(options.limit ?? 100, 200),
      select: {
        id: true,
        checkedInAt: true,
        checkedOutAt: true,
        method: true,
        wasOverride: true,
        member: {
          select: { id: true, memberCode: true, firstName: true, lastName: true, photoFileKey: true },
        },
        branch: { select: { name: true } },
      },
    });

    return rows.map((row: any) => ({
      id: row.id,
      checkedInAt: row.checkedInAt,
      checkedOutAt: row.checkedOutAt,
      method: row.method,
      wasOverride: row.wasOverride,
      memberId: row.member.id,
      memberCode: row.member.memberCode,
      name: [row.member.firstName, row.member.lastName].filter(Boolean).join(' '),
      photoFileKey: row.member.photoFileKey,
      branchName: row.branch?.name ?? null,
    }));
  });
}

/**
 * Hour-by-hour counts, for staffing decisions.
 *
 * Grouped in SQL rather than pulled into memory: a year of attendance for a
 * busy gym is a hundred thousand rows, and the 120-second request ceiling on
 * shared hosting is not generous.
 */
export async function peakHours(
  ctx: AttendanceContext,
  permissions: ResolvedPermissions,
  options: { fromDate: string; toDate: string; timezone?: string },
): Promise<Array<{ hour: number; visits: number }>> {
  requirePermission(permissions, 'attendance.report.read');
  const timezone = options.timezone ?? 'Asia/Kolkata';

  return withTenant(ctx, async (tx) => {
    const rows = await tx.$queryRaw<Array<{ hour: number; visits: bigint }>>`
      SELECT EXTRACT(HOUR FROM ("checkedInAt" AT TIME ZONE ${timezone}))::int AS hour,
             COUNT(*)::bigint AS visits
        FROM attendance
       WHERE "attendanceDate" BETWEEN ${startOfDay(options.fromDate)}::date
                                  AND ${startOfDay(options.toDate)}::date
       GROUP BY 1
       ORDER BY 1`;

    const byHour = new Map(rows.map((row) => [row.hour, Number(row.visits)]));
    return Array.from({ length: 24 }, (_, hour) => ({
      hour,
      visits: byHour.get(hour) ?? 0,
    }));
  });
}
