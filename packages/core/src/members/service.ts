import { withTenant } from '@gym/db';
import { AppError } from '../errors';
import { writeAudit } from '../audit/log';
import {
  requirePermission,
  branchFilter,
  assertBranchAllowed,
  scopeOf,
  type ResolvedPermissions,
} from '../rbac/engine';
import { allocateMemberCode } from '../shared/sequences';
import { startOfDay, today } from '../shared/dates';

/**
 * Member management.
 *
 * Every function takes a tenant context and a resolved permission set, and
 * every read is narrowed by the actor's scope before it reaches the
 * database — a trainer at OWN scope sees their own members, a manager at
 * BRANCH scope sees their branches, an owner sees the gym.
 */

export interface MemberContext {
  organizationId: string;
  userId: string;
  branchIds?: string[];
}

export interface CreateMemberInput {
  firstName: string;
  lastName?: string;
  phone: string;
  altPhone?: string;
  email?: string;
  dateOfBirth?: string;
  gender?: 'MALE' | 'FEMALE' | 'OTHER' | 'UNDISCLOSED';
  branchId?: string;
  joiningDate?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  emergencyContactName?: string;
  emergencyContactPhone?: string;
  emergencyContactRelation?: string;
  fitnessGoals?: string[];
  occupation?: string;
  bloodGroup?: string;
  referredBy?: string;
  notes?: string;
  assignedTrainerOrgUserId?: string;
  /** Set when the member is being converted from a lead. */
  convertedFromLeadId?: string;
  /** Deliberate override after the duplicate warning has been seen. */
  allowDuplicate?: boolean;
}

export interface DuplicateMatch {
  id: string;
  memberCode: string;
  name: string;
  phone: string;
  status: string;
  reason: 'phone' | 'email';
}

/**
 * Duplicate detection.
 *
 * The same person registering twice is the commonest data problem in a gym:
 * the member forgets they joined last year, reception is busy, and now there
 * are two records, two histories and two sets of expiry reminders. The phone
 * number is the practical key in India.
 *
 * Reported, not blocked — families share numbers, and reception must be able
 * to proceed. Confirming the warning records the decision.
 */
export async function findDuplicates(
  ctx: MemberContext,
  input: { phone: string; email?: string; excludeMemberId?: string },
): Promise<DuplicateMatch[]> {
  return withTenant(ctx, async (tx) => {
    const rows = await tx.member.findMany({
      where: {
        deletedAt: null,
        ...(input.excludeMemberId ? { id: { not: input.excludeMemberId } } : {}),
        OR: [
          { phone: input.phone },
          ...(input.email ? [{ email: input.email }] : []),
        ],
      },
      select: {
        id: true,
        memberCode: true,
        firstName: true,
        lastName: true,
        phone: true,
        email: true,
        status: true,
      },
      take: 10,
    });

    return rows.map((row: any) => ({
      id: row.id,
      memberCode: row.memberCode,
      name: [row.firstName, row.lastName].filter(Boolean).join(' '),
      phone: row.phone,
      status: row.status,
      reason: row.phone === input.phone ? ('phone' as const) : ('email' as const),
    }));
  });
}

export async function createMember(
  ctx: MemberContext,
  permissions: ResolvedPermissions,
  input: CreateMemberInput,
  meta: { ipAddress?: string; userAgent?: string } = {},
): Promise<{ id: string; memberCode: string; duplicatesAcknowledged: number }> {
  requirePermission(permissions, 'members.member.create');
  if (input.branchId) assertBranchAllowed(permissions, input.branchId);

  const duplicates = await findDuplicates(ctx, {
    phone: input.phone,
    email: input.email,
  });

  if (duplicates.length > 0 && !input.allowDuplicate) {
    throw new AppError(
      'DUPLICATE_MEMBER',
      `${duplicates[0]!.name} (${duplicates[0]!.memberCode}) already uses that ${duplicates[0]!.reason}.`,
      duplicates.map((match) => ({
        field: match.reason,
        issue: `${match.name} — ${match.memberCode}`,
      })),
    );
  }

  return withTenant(ctx, async (tx) => {
    const branchId =
      input.branchId ??
      (
        await tx.branch.findFirst({
          where: { isActive: true, deletedAt: null },
          orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
          select: { id: true },
        })
      )?.id;

    const memberCode = await allocateMemberCode(tx, ctx.organizationId);

    const member = await tx.member.create({
      data: {
        organizationId: ctx.organizationId,
        branchId,
        memberCode,
        firstName: input.firstName.trim(),
        lastName: input.lastName?.trim() || null,
        phone: input.phone,
        altPhone: input.altPhone || null,
        email: input.email || null,
        dateOfBirth: input.dateOfBirth ? startOfDay(input.dateOfBirth) : null,
        gender: input.gender ?? null,
        addressLine1: input.addressLine1 || null,
        addressLine2: input.addressLine2 || null,
        city: input.city || null,
        state: input.state || null,
        postalCode: input.postalCode || null,
        emergencyContactName: input.emergencyContactName || null,
        emergencyContactPhone: input.emergencyContactPhone || null,
        emergencyContactRelation: input.emergencyContactRelation || null,
        joiningDate: input.joiningDate ? startOfDay(input.joiningDate) : today(),
        fitnessGoals: input.fitnessGoals ?? [],
        occupation: input.occupation || null,
        bloodGroup: input.bloodGroup || null,
        referredBy: input.referredBy || null,
        notes: input.notes || null,
        assignedTrainerOrgUserId: input.assignedTrainerOrgUserId || null,
        convertedFromLeadId: input.convertedFromLeadId || null,
        createdByUserId: ctx.userId,
        status: 'ACTIVE',
      },
      select: { id: true, memberCode: true, firstName: true, lastName: true },
    });

    await tx.memberTimelineEntry.create({
      data: {
        organizationId: ctx.organizationId,
        memberId: member.id,
        entryType: 'REGISTERED',
        title: 'Joined the gym',
        occurredAt: new Date(),
        actorUserId: ctx.userId,
      },
    });

    if (input.convertedFromLeadId) {
      await tx.lead.updateMany({
        where: { id: input.convertedFromLeadId },
        data: { status: 'CONVERTED', convertedAt: new Date() },
      });
    }

    await writeAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'member.created',
      entityType: 'Member',
      entityId: member.id,
      summary: `${member.firstName} ${member.lastName ?? ''} (${member.memberCode})`.trim(),
      after: { memberCode: member.memberCode, phone: input.phone },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    return {
      id: member.id,
      memberCode: member.memberCode,
      duplicatesAcknowledged: duplicates.length,
    };
  });
}

// ------------------------------------------------------------- listing ---

export type MemberFilter =
  | 'all'
  | 'active'
  | 'expiring'
  | 'expired'
  | 'inactive'
  | 'unpaid';

export interface ListMembersOptions {
  page?: number;
  pageSize?: number;
  search?: string;
  filter?: MemberFilter;
  branchId?: string;
  trainerOrgUserId?: string;
  sortBy?: 'name' | 'joined' | 'expiry' | 'code';
  sortDir?: 'asc' | 'desc';
}

export interface MemberRow {
  id: string;
  memberCode: string;
  name: string;
  phone: string;
  email: string | null;
  photoFileKey: string | null;
  status: string;
  branchName: string | null;
  membershipExpiresAt: Date | null;
  lastVisitAt: Date | null;
  outstandingAmount: string;
  trainerName: string | null;
}

export async function listMembers(
  ctx: MemberContext,
  permissions: ResolvedPermissions,
  options: ListMembersOptions = {},
): Promise<{ rows: MemberRow[]; total: number }> {
  requirePermission(permissions, 'members.member.read');

  const page = Math.max(1, options.page ?? 1);
  const pageSize = Math.min(options.pageSize ?? 25, 100);
  const scope = scopeOf(permissions, 'members.member.read');
  const now = today();
  const inSevenDays = new Date(now.getTime() + 7 * 86_400_000);

  return withTenant(ctx, async (tx) => {
    // A trainer sees their own members. Not "sees all and we hide the rest
    // in the interface" — the query itself is narrowed.
    const scopeWhere =
      scope === 'OWN'
        ? await ownScopeFilter(tx, ctx.userId)
        : scope === 'BRANCH'
          ? { branchId: branchFilter(permissions, 'members.member.read') }
          : {};

    const filterWhere = {
      all: {},
      active: { status: 'ACTIVE' as const, membershipExpiresAt: { gte: now } },
      expiring: {
        status: 'ACTIVE' as const,
        membershipExpiresAt: { gte: now, lte: inSevenDays },
      },
      expired: { membershipExpiresAt: { lt: now } },
      inactive: { status: 'INACTIVE' as const },
      unpaid: { outstandingAmount: { gt: 0 } },
    }[options.filter ?? 'all'];

    const where = {
      deletedAt: null,
      ...scopeWhere,
      ...filterWhere,
      ...(options.branchId ? { branchId: options.branchId } : {}),
      ...(options.trainerOrgUserId
        ? { assignedTrainerOrgUserId: options.trainerOrgUserId }
        : {}),
      ...(options.search
        ? {
            OR: [
              { firstName: { contains: options.search, mode: 'insensitive' as const } },
              { lastName: { contains: options.search, mode: 'insensitive' as const } },
              { phone: { contains: options.search } },
              { email: { contains: options.search, mode: 'insensitive' as const } },
              { memberCode: { contains: options.search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const orderBy = {
      name: { firstName: options.sortDir ?? 'asc' },
      joined: { joiningDate: options.sortDir ?? 'desc' },
      expiry: { membershipExpiresAt: options.sortDir ?? 'asc' },
      code: { memberCode: options.sortDir ?? 'desc' },
    }[options.sortBy ?? 'joined'];

    const [rows, total] = await Promise.all([
      tx.member.findMany({
        where,
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          memberCode: true,
          firstName: true,
          lastName: true,
          phone: true,
          email: true,
          photoFileKey: true,
          status: true,
          membershipExpiresAt: true,
          lastVisitAt: true,
          outstandingAmount: true,
          branch: { select: { name: true } },
          assignedTrainer: { select: { user: { select: { fullName: true } } } },
        },
      }),
      tx.member.count({ where }),
    ]);

    return {
      total,
      rows: rows.map((row: any) => ({
        id: row.id,
        memberCode: row.memberCode,
        name: [row.firstName, row.lastName].filter(Boolean).join(' '),
        phone: row.phone,
        email: row.email,
        photoFileKey: row.photoFileKey,
        status: row.status,
        branchName: row.branch?.name ?? null,
        membershipExpiresAt: row.membershipExpiresAt,
        lastVisitAt: row.lastVisitAt,
        outstandingAmount: row.outstandingAmount.toString(),
        trainerName: row.assignedTrainer?.user.fullName ?? null,
      })),
    };
  });
}

/** Members assigned to this trainer — the OWN scope, resolved to ids. */
async function ownScopeFilter(tx: any, userId: string) {
  const orgUser = await tx.orgUser.findFirst({
    where: { userId },
    select: { id: true },
  });
  return { assignedTrainerOrgUserId: orgUser?.id ?? '00000000-0000-0000-0000-000000000000' };
}

// ------------------------------------------------------------- profile ---

export async function getMember(
  ctx: MemberContext,
  permissions: ResolvedPermissions,
  memberId: string,
) {
  requirePermission(permissions, 'members.member.read');
  const canSeeMedical = Boolean(scopeOf(permissions, 'members.medical.read'));

  return withTenant(ctx, async (tx) => {
    const member = await tx.member.findFirst({
      where: { id: memberId, deletedAt: null },
      select: {
        id: true,
        memberCode: true,
        firstName: true,
        lastName: true,
        phone: true,
        altPhone: true,
        email: true,
        photoFileKey: true,
        dateOfBirth: true,
        gender: true,
        addressLine1: true,
        addressLine2: true,
        city: true,
        state: true,
        postalCode: true,
        emergencyContactName: true,
        emergencyContactPhone: true,
        emergencyContactRelation: true,
        joiningDate: true,
        status: true,
        fitnessGoals: true,
        occupation: true,
        bloodGroup: true,
        notes: true,
        membershipExpiresAt: true,
        lastVisitAt: true,
        outstandingAmount: true,
        branch: { select: { id: true, name: true } },
        assignedTrainer: {
          select: { id: true, user: { select: { fullName: true } } },
        },
        subscriptions: {
          orderBy: { startDate: 'desc' },
          take: 10,
          select: {
            id: true,
            status: true,
            startDate: true,
            endDate: true,
            graceUntil: true,
            totalAmount: true,
            paidAmount: true,
            plan: { select: { name: true } },
          },
        },
        // Medical data is fetched only when the actor may see it. Not
        // fetched-then-hidden: not fetched.
        ...(canSeeMedical
          ? {
              medicalDeclaration: {
                select: {
                  hasDeclaredConditions: true,
                  conditions: true,
                  medications: true,
                  allergies: true,
                  injuries: true,
                  physicianName: true,
                  physicianPhone: true,
                  fitnessClearanceGiven: true,
                  additionalNotes: true,
                },
              },
            }
          : {}),
      },
    });

    if (!member) throw new AppError('NOT_FOUND', 'Member not found.');
    return { ...member, canSeeMedical };
  });
}

export async function updateMember(
  ctx: MemberContext,
  permissions: ResolvedPermissions,
  memberId: string,
  input: Partial<CreateMemberInput>,
  meta: { ipAddress?: string } = {},
): Promise<void> {
  requirePermission(permissions, 'members.member.update');

  await withTenant(ctx, async (tx) => {
    const before = await tx.member.findFirst({
      where: { id: memberId, deletedAt: null },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        phone: true,
        email: true,
        status: true,
        branchId: true,
      },
    });
    if (!before) throw new AppError('NOT_FOUND', 'Member not found.');
    if (input.branchId) assertBranchAllowed(permissions, input.branchId);

    const data: Record<string, unknown> = {};
    const assign = (key: string, value: unknown) => {
      if (value !== undefined) data[key] = value;
    };

    assign('firstName', input.firstName?.trim());
    assign('lastName', input.lastName?.trim() || null);
    assign('phone', input.phone);
    assign('altPhone', input.altPhone || null);
    assign('email', input.email || null);
    assign('gender', input.gender);
    assign('branchId', input.branchId);
    assign('addressLine1', input.addressLine1 || null);
    assign('city', input.city || null);
    assign('state', input.state || null);
    assign('postalCode', input.postalCode || null);
    assign('emergencyContactName', input.emergencyContactName || null);
    assign('emergencyContactPhone', input.emergencyContactPhone || null);
    assign('fitnessGoals', input.fitnessGoals);
    assign('occupation', input.occupation || null);
    assign('bloodGroup', input.bloodGroup || null);
    assign('notes', input.notes || null);
    assign('assignedTrainerOrgUserId', input.assignedTrainerOrgUserId || null);
    if (input.dateOfBirth !== undefined) {
      data.dateOfBirth = input.dateOfBirth ? startOfDay(input.dateOfBirth) : null;
    }

    await tx.member.update({ where: { id: memberId }, data });

    await writeAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'member.updated',
      entityType: 'Member',
      entityId: memberId,
      before,
      after: data,
      ipAddress: meta.ipAddress,
    });
  });
}

/**
 * Soft delete. A member's payment history is a financial record, so the row
 * stays and is marked instead — and their invoices stay reachable.
 */
export async function archiveMember(
  ctx: MemberContext,
  permissions: ResolvedPermissions,
  memberId: string,
  meta: { reason?: string; ipAddress?: string } = {},
): Promise<void> {
  requirePermission(permissions, 'members.member.delete');

  await withTenant(ctx, async (tx) => {
    const member = await tx.member.findFirst({
      where: { id: memberId, deletedAt: null },
      select: { id: true, memberCode: true, firstName: true },
    });
    if (!member) throw new AppError('NOT_FOUND', 'Member not found.');

    await tx.member.update({
      where: { id: memberId },
      data: { deletedAt: new Date(), status: 'CANCELLED' },
    });

    await tx.subscription.updateMany({
      where: { memberId, status: { in: ['ACTIVE', 'FROZEN', 'PENDING'] } },
      data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: meta.reason },
    });

    await writeAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'member.archived',
      entityType: 'Member',
      entityId: memberId,
      summary: meta.reason ?? `${member.firstName} (${member.memberCode}) archived`,
      ipAddress: meta.ipAddress,
    });
  });
}
