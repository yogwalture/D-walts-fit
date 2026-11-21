import { withTenant } from '@gym/db';
import { AppError } from '../errors';
import { writeAudit } from '../audit/log';
import { requirePermission, scopeOf, type ResolvedPermissions } from '../rbac/engine';
import { startOfDay, today } from '../shared/dates';
import { toPaise, toRupees } from '../shared/money';

/**
 * Staff and trainers.
 *
 * Two things the product has been promising and not delivering: the member
 * profile has said "Trainer: Not assigned" since Phase 2 with no way to
 * assign one, and the trainer role has carried OWN scope on members — so a
 * trainer signs in and sees an empty list, because nothing ever filled it.
 *
 * Salary and bank details are the sensitive part. They sit behind their own
 * permission, are never in a default select, and are fetched only when the
 * actor holds `staff.salary.read` — not fetched and then hidden, which would
 * put them in a log or a serialised response on the way past.
 */

export interface StaffContext {
  organizationId: string;
  userId: string;
  branchIds?: string[];
}

export interface StaffProfileView {
  orgUserId: string;
  userId: string;
  fullName: string;
  email: string;
  phone: string | null;
  roleKey: string | null;
  roleName: string | null;
  status: string;
  employeeCode: string | null;
  designation: string | null;
  department: string | null;
  joiningDate: Date | null;
  exitDate: Date | null;
  specialisations: string[];
  certifications: string[];
  bio: string | null;
  branchNames: string[];
  /** How many members this person is the trainer for. */
  memberCount: number;
  canSeeSalary: boolean;
  /** Present only when the actor may see it. */
  salary?: {
    amount: string | null;
    cycle: string | null;
    bankAccountMasked: string | null;
    bankIfsc: string | null;
    panMasked: string | null;
  };
}

export async function getStaffProfile(
  ctx: StaffContext,
  permissions: ResolvedPermissions,
  orgUserId: string,
): Promise<StaffProfileView> {
  requirePermission(permissions, 'staff.profile.read');
  const canSeeSalary = Boolean(scopeOf(permissions, 'staff.salary.read'));

  return withTenant(ctx, async (tx) => {
    const orgUser = await tx.orgUser.findFirst({
      where: { id: orgUserId, deletedAt: null },
      select: {
        id: true,
        userId: true,
        status: true,
        user: { select: { fullName: true, email: true, phone: true } },
        role: { select: { key: true, name: true } },
        branches: { select: { branch: { select: { name: true } } } },
        staffProfile: {
          select: {
            employeeCode: true,
            designation: true,
            department: true,
            joiningDate: true,
            exitDate: true,
            specialisations: true,
            certifications: true,
            bio: true,
            // Read only when the actor is entitled to it. Not fetched and
            // then stripped: not fetched.
            ...(canSeeSalary
              ? {
                  salaryAmount: true,
                  salaryCycle: true,
                  bankAccountMasked: true,
                  bankIfsc: true,
                  panMasked: true,
                }
              : {}),
          },
        },
      },
    });

    if (!orgUser) throw new AppError('NOT_FOUND', 'That team member was not found.');

    const memberCount = await tx.member.count({
      where: { assignedTrainerOrgUserId: orgUserId, deletedAt: null },
    });

     
    const profile = orgUser.staffProfile as any;

    return {
      orgUserId: orgUser.id,
      userId: orgUser.userId,
      fullName: orgUser.user.fullName,
      email: orgUser.user.email,
      phone: orgUser.user.phone,
      roleKey: orgUser.role?.key ?? null,
      roleName: orgUser.role?.name ?? null,
      status: orgUser.status,
      employeeCode: profile?.employeeCode ?? null,
      designation: profile?.designation ?? null,
      department: profile?.department ?? null,
      joiningDate: profile?.joiningDate ?? null,
      exitDate: profile?.exitDate ?? null,
      specialisations: profile?.specialisations ?? [],
      certifications: profile?.certifications ?? [],
      bio: profile?.bio ?? null,
      branchNames: orgUser.branches.map(
        (link: { branch: { name: string } }) => link.branch.name,
      ),
      memberCount,
      canSeeSalary,
      ...(canSeeSalary && profile
        ? {
            salary: {
              amount: profile.salaryAmount ? Number(profile.salaryAmount).toFixed(2) : null,
              cycle: profile.salaryCycle ?? null,
              bankAccountMasked: profile.bankAccountMasked ?? null,
              bankIfsc: profile.bankIfsc ?? null,
              panMasked: profile.panMasked ?? null,
            },
          }
        : {}),
    };
  });
}

export interface UpdateStaffProfileInput {
  employeeCode?: string | null;
  designation?: string | null;
  department?: string | null;
  joiningDate?: string | null;
  specialisations?: string[];
  certifications?: string[];
  bio?: string | null;
  /** Each of these requires `staff.salary.update` on its own. */
  salaryAmount?: string | null;
  salaryCycle?: string | null;
  bankAccountMasked?: string | null;
  bankIfsc?: string | null;
  panMasked?: string | null;
}

const SALARY_FIELDS = [
  'salaryAmount',
  'salaryCycle',
  'bankAccountMasked',
  'bankIfsc',
  'panMasked',
] as const;

export async function updateStaffProfile(
  ctx: StaffContext,
  permissions: ResolvedPermissions,
  orgUserId: string,
  input: UpdateStaffProfileInput,
  meta: { ipAddress?: string } = {},
): Promise<void> {
  requirePermission(permissions, 'staff.profile.update');

  const touchesSalary = SALARY_FIELDS.some((field) => input[field] !== undefined);
  if (touchesSalary) {
    // A separate permission, not a scope of the first: a manager who may
    // correct a designation must not thereby be able to set a salary.
    requirePermission(permissions, 'staff.salary.update');
  }

  await withTenant(ctx, async (tx) => {
    const orgUser = await tx.orgUser.findFirst({
      where: { id: orgUserId, deletedAt: null },
      select: { id: true, user: { select: { fullName: true } } },
    });
    if (!orgUser) throw new AppError('NOT_FOUND', 'That team member was not found.');

    /** Absent leaves the field alone; empty clears it. */
    const clearable = (value: string | null | undefined): string | null | undefined => {
      if (value === undefined) return undefined;
      const trimmed = typeof value === 'string' ? value.trim() : value;
      return trimmed ? trimmed : null;
    };

    const data: Record<string, unknown> = {};
    const assign = (key: string, value: unknown) => {
      if (value !== undefined) data[key] = value;
    };

    assign('employeeCode', clearable(input.employeeCode));
    assign('designation', clearable(input.designation));
    assign('department', clearable(input.department));
    assign('bio', clearable(input.bio));
    if (input.specialisations !== undefined) data.specialisations = input.specialisations;
    if (input.certifications !== undefined) data.certifications = input.certifications;
    if (input.joiningDate !== undefined) {
      data.joiningDate = input.joiningDate ? startOfDay(input.joiningDate) : null;
    }

    if (touchesSalary) {
      if (input.salaryAmount !== undefined) {
        data.salaryAmount = input.salaryAmount ? toRupees(toPaise(input.salaryAmount)) : null;
      }
      assign('salaryCycle', clearable(input.salaryCycle));
      assign('bankAccountMasked', clearable(input.bankAccountMasked));
      assign('bankIfsc', clearable(input.bankIfsc));
      assign('panMasked', clearable(input.panMasked));
    }

    if (input.employeeCode) {
      const clash = await tx.staffProfile.findFirst({
        where: { employeeCode: input.employeeCode.trim(), orgUserId: { not: orgUserId } },
        select: { id: true },
      });
      if (clash) {
        throw new AppError('CONFLICT', 'Another team member already has that employee code.', [
          { field: 'employeeCode', issue: 'Already in use' },
        ]);
      }
    }

    await tx.staffProfile.upsert({
      where: { orgUserId },
      create: { organizationId: ctx.organizationId, orgUserId, ...data },
      update: data,
    });

    await writeAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: touchesSalary ? 'staff.salary.updated' : 'staff.profile.updated',
      entityType: 'StaffProfile',
      entityId: orgUserId,
      summary: touchesSalary
        ? `Changed pay or bank details for ${orgUser.user.fullName}`
        : `Updated ${orgUser.user.fullName}'s profile`,
      // The figures themselves are deliberately not written into the audit
      // payload: that the change happened is the useful record, and the
      // amount would otherwise be readable by anyone who can read the log.
      after: touchesSalary ? { fieldsChanged: Object.keys(data) } : data,
      ipAddress: meta.ipAddress,
    });
  });
}

// ------------------------------------------------------------ trainers ---

export interface TrainerRow {
  orgUserId: string;
  fullName: string;
  designation: string | null;
  specialisations: string[];
  memberCount: number;
  status: string;
}

/**
 * Who can be assigned a member.
 *
 * Anyone whose role reads members at OWN scope — a trainer by default, but a
 * gym that has given its manager that scope too gets them both, without
 * anything here hardcoding a role name.
 */
export async function listTrainers(
  ctx: StaffContext,
  permissions: ResolvedPermissions,
  options: { includeInactive?: boolean } = {},
): Promise<TrainerRow[]> {
  requirePermission(permissions, 'staff.profile.read');

  return withTenant(ctx, async (tx) => {
    const orgUsers = await tx.orgUser.findMany({
      where: {
        deletedAt: null,
        ...(options.includeInactive ? {} : { status: 'ACTIVE' }),
        role: {
          permissions: {
            some: { permissionKey: 'members.member.read', scope: 'OWN' },
          },
        },
      },
      select: {
        id: true,
        status: true,
        user: { select: { fullName: true } },
        staffProfile: { select: { designation: true, specialisations: true } },
      },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });

    if (orgUsers.length === 0) return [];

    const counts = await tx.member.groupBy({
      by: ['assignedTrainerOrgUserId'],
      where: {
        deletedAt: null,
        assignedTrainerOrgUserId: { in: orgUsers.map((row: { id: string }) => row.id) },
      },
      _count: true,
    });

    const countById = new Map(
      counts.map((row: { assignedTrainerOrgUserId: string | null; _count: number }) => [
        row.assignedTrainerOrgUserId,
        row._count,
      ]),
    );

     
    return orgUsers.map((row: any) => ({
      orgUserId: row.id,
      fullName: row.user.fullName,
      designation: row.staffProfile?.designation ?? null,
      specialisations: row.staffProfile?.specialisations ?? [],
      memberCount: countById.get(row.id) ?? 0,
      status: row.status,
    }));
  });
}

/**
 * Puts a member under a trainer, or takes them off one.
 *
 * Both the assignment history and the member's denormalised pointer are
 * written in one transaction: the history is what a gym looks back at, and
 * the pointer is what makes a trainer's own member list one query rather
 * than a join on every page load.
 */
export async function assignTrainer(
  ctx: StaffContext,
  permissions: ResolvedPermissions,
  input: { memberId: string; orgUserId: string | null; notes?: string },
  meta: { ipAddress?: string } = {},
): Promise<void> {
  requirePermission(permissions, 'members.member.update');

  await withTenant(ctx, async (tx) => {
    const member = await tx.member.findFirst({
      where: { id: input.memberId, deletedAt: null },
      select: { id: true, firstName: true, lastName: true, branchId: true },
    });
    if (!member) throw new AppError('NOT_FOUND', 'Member not found.');

    const now = today();

    // Close whatever is open, whether this is a change or a removal.
    await tx.trainerAssignment.updateMany({
      where: { memberId: member.id, toDate: null },
      data: { toDate: now },
    });

    let trainerName: string | null = null;

    if (input.orgUserId) {
      const trainer = await tx.orgUser.findFirst({
        where: { id: input.orgUserId, deletedAt: null, status: 'ACTIVE' },
        select: {
          id: true,
          user: { select: { fullName: true } },
          branches: { select: { branchId: true } },
        },
      });
      if (!trainer) {
        throw new AppError('NOT_FOUND', 'That trainer was not found, or is not active.');
      }

      // A trainer limited to certain branches should not be handed a member
      // from a branch they do not work at.
      if (trainer.branches.length > 0 && member.branchId) {
        const worksHere = trainer.branches.some(
          (link: { branchId: string }) => link.branchId === member.branchId,
        );
        if (!worksHere) {
          throw new AppError(
            'VALIDATION_FAILED',
            'That trainer does not work at this member’s branch.',
            [{ field: 'orgUserId', issue: 'Not assigned to this branch' }],
          );
        }
      }

      trainerName = trainer.user.fullName;

      await tx.trainerAssignment.create({
        data: {
          organizationId: ctx.organizationId,
          orgUserId: trainer.id,
          memberId: member.id,
          fromDate: now,
          isPrimary: true,
          notes: input.notes?.trim().slice(0, 500) || null,
        },
      });
    }

    await tx.member.update({
      where: { id: member.id },
      data: { assignedTrainerOrgUserId: input.orgUserId },
    });

    const memberName = [member.firstName, member.lastName].filter(Boolean).join(' ');

    await tx.memberTimelineEntry.create({
      data: {
        organizationId: ctx.organizationId,
        memberId: member.id,
        entryType: 'NOTE',
        title: trainerName ? `Assigned to ${trainerName}` : 'Trainer removed',
        sourceType: 'TrainerAssignment',
        actorUserId: ctx.userId,
      },
    });

    await writeAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'member.trainer.assigned',
      entityType: 'Member',
      entityId: member.id,
      summary: trainerName
        ? `${memberName} assigned to ${trainerName}`
        : `${memberName}'s trainer removed`,
      ipAddress: meta.ipAddress,
    });
  });
}

/** A trainer's own members. */
export async function trainerRoster(
  ctx: StaffContext,
  permissions: ResolvedPermissions,
  orgUserId: string,
): Promise<{
  trainer: { orgUserId: string; fullName: string } | null;
  members: Array<{
    id: string;
    memberCode: string;
    name: string;
    phone: string;
    membershipExpiresAt: Date | null;
    lastVisitAt: Date | null;
    since: Date | null;
  }>;
}> {
  requirePermission(permissions, 'members.member.read');

  return withTenant(ctx, async (tx) => {
    const trainer = await tx.orgUser.findFirst({
      where: { id: orgUserId, deletedAt: null },
      select: { id: true, user: { select: { fullName: true } } },
    });

    const members = await tx.member.findMany({
      where: { assignedTrainerOrgUserId: orgUserId, deletedAt: null },
      orderBy: { firstName: 'asc' },
      take: 200,
      select: {
        id: true,
        memberCode: true,
        firstName: true,
        lastName: true,
        phone: true,
        membershipExpiresAt: true,
        lastVisitAt: true,
        trainerAssignments: {
          where: { orgUserId, toDate: null },
          orderBy: { fromDate: 'desc' },
          take: 1,
          select: { fromDate: true },
        },
      },
    });

    return {
      trainer: trainer ? { orgUserId: trainer.id, fullName: trainer.user.fullName } : null,
       
      members: members.map((row: any) => ({
        id: row.id,
        memberCode: row.memberCode,
        name: [row.firstName, row.lastName].filter(Boolean).join(' '),
        phone: row.phone,
        membershipExpiresAt: row.membershipExpiresAt,
        lastVisitAt: row.lastVisitAt,
        since: row.trainerAssignments[0]?.fromDate ?? null,
      })),
    };
  });
}
