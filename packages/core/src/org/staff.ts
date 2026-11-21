import { withTenant } from '@gym/db';
import { AppError } from '../errors';
import { writeAudit } from '../audit/log';
import type { ResolvedPermissions } from '../rbac/engine';
import { requirePermission, scopeOf } from '../rbac/engine';

/**
 * Staff administration.
 *
 * Reads and writes run inside the tenant context, so the database enforces
 * the boundary as well as the application. Salary data is NOT returned here:
 * it lives on staff_profiles behind staff.salary.read and is fetched only by
 * the screens entitled to it.
 */

export interface StaffRow {
  orgUserId: string;
  userId: string;
  fullName: string;
  email: string;
  status: string;
  roleKey: string;
  roleName: string;
  branchNames: string[];
  designation: string | null;
  joinedAt: Date | null;
  lastLoginAt: Date | null;
}

export async function listStaff(
  ctx: { organizationId: string; userId: string },
  permissions: ResolvedPermissions,
  options: { page?: number; pageSize?: number; search?: string } = {},
): Promise<{ rows: StaffRow[]; total: number }> {
  requirePermission(permissions, 'org.user.read');

  const page = options.page ?? 1;
  const pageSize = Math.min(options.pageSize ?? 25, 100);

  return withTenant(ctx, async (tx) => {
    const where = {
      deletedAt: null,
      ...(options.search
        ? {
            user: {
              OR: [
                { fullName: { contains: options.search, mode: 'insensitive' as const } },
                { email: { contains: options.search, mode: 'insensitive' as const } },
              ],
            },
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      tx.orgUser.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          userId: true,
          status: true,
          createdAt: true,
          user: { select: { fullName: true, email: true, lastLoginAt: true } },
          role: { select: { key: true, name: true } },
          branches: { select: { branch: { select: { name: true } } } },
          staffProfile: { select: { designation: true, joiningDate: true } },
        },
      }),
      tx.orgUser.count({ where }),
    ]);

    return {
      total,
      rows: rows.map((row: any) => ({
        orgUserId: row.id,
        userId: row.userId,
        fullName: row.user.fullName,
        email: row.user.email,
        status: row.status,
        roleKey: row.role.key,
        roleName: row.role.name,
        branchNames: row.branches.map((b: any) => b.branch.name),
        designation: row.staffProfile?.designation ?? null,
        joinedAt: row.staffProfile?.joiningDate ?? row.createdAt,
        lastLoginAt: row.user.lastLoginAt,
      })),
    };
  });
}

/** Roles a gym may assign: the system roles plus any it has defined itself. */
export async function listAssignableRoles(ctx: {
  organizationId: string;
  userId: string;
}): Promise<Array<{ id: string; key: string; name: string; description: string | null }>> {
  return withTenant(ctx, async (tx) => {
    const roles = await tx.role.findMany({
      where: { isPlatform: false, deletedAt: null },
      orderBy: { rank: 'asc' },
      select: { id: true, key: true, name: true, description: true },
      take: 100,
    });
    // MEMBER is granted by member login, never assigned as staff.
    return roles.filter((role: any) => role.key !== 'MEMBER');
  });
}

export async function setStaffStatus(
  ctx: { organizationId: string; userId: string },
  permissions: ResolvedPermissions,
  input: { orgUserId: string; status: 'ACTIVE' | 'SUSPENDED'; ipAddress?: string },
): Promise<void> {
  requirePermission(permissions, 'org.user.update');

  await withTenant(ctx, async (tx) => {
    const target = await tx.orgUser.findFirst({
      where: { id: input.orgUserId, deletedAt: null },
      select: { id: true, userId: true, status: true, role: { select: { key: true } } },
    });
    if (!target) throw new AppError('NOT_FOUND', 'That staff member was not found.');

    if (target.userId === ctx.userId) {
      throw new AppError('CONFLICT', 'You cannot suspend your own account.');
    }

    // A gym must never be left without an owner who can get back into it.
    if (target.role.key === 'GYM_OWNER' && input.status === 'SUSPENDED') {
      const otherOwners = await tx.orgUser.count({
        where: {
          role: { key: 'GYM_OWNER' },
          status: 'ACTIVE',
          deletedAt: null,
          id: { not: target.id },
        },
      });
      if (otherOwners === 0) {
        throw new AppError('CONFLICT', 'This is the only owner. Add another before suspending.');
      }
    }

    await tx.orgUser.update({
      where: { id: target.id },
      data: { status: input.status },
    });

    if (input.status === 'SUSPENDED') {
      await tx.$executeRaw`
        UPDATE sessions SET "revokedAt" = now()
        WHERE "userId" = ${target.userId}::uuid
          AND "organizationId" = ${ctx.organizationId}::uuid
          AND "revokedAt" IS NULL`;
    }

    await writeAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: input.status === 'SUSPENDED' ? 'staff.suspended' : 'staff.reactivated',
      entityType: 'OrgUser',
      entityId: target.id,
      before: { status: target.status },
      after: { status: input.status },
      ipAddress: input.ipAddress,
    });
  });
}

export async function changeStaffRole(
  ctx: { organizationId: string; userId: string },
  permissions: ResolvedPermissions,
  input: { orgUserId: string; roleId: string; ipAddress?: string },
): Promise<void> {
  requirePermission(permissions, 'org.user.update');

  await withTenant(ctx, async (tx) => {
    const [target, role] = await Promise.all([
      tx.orgUser.findFirst({
        where: { id: input.orgUserId, deletedAt: null },
        select: { id: true, userId: true, role: { select: { id: true, key: true } } },
      }),
      tx.role.findFirst({
        where: { id: input.roleId, isPlatform: false, deletedAt: null },
        select: { id: true, key: true, name: true },
      }),
    ]);

    if (!target) throw new AppError('NOT_FOUND', 'That staff member was not found.');
    if (!role) throw new AppError('NOT_FOUND', 'That role does not exist.');
    if (role.key === 'MEMBER') {
      throw new AppError('VALIDATION_FAILED', 'The member role cannot be assigned to staff.');
    }

    // Demoting yourself out of ownership is how a gym loses its only admin.
    if (target.userId === ctx.userId && target.role.key === 'GYM_OWNER') {
      throw new AppError('CONFLICT', 'You cannot change your own owner role.');
    }

    await tx.orgUser.update({ where: { id: target.id }, data: { roleId: role.id } });

    await writeAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'staff.role.changed',
      entityType: 'OrgUser',
      entityId: target.id,
      summary: `Role changed to ${role.name}`,
      before: { role: target.role.key },
      after: { role: role.key },
      ipAddress: input.ipAddress,
    });
  });
}

// --------------------------------------------------------------- branches ---

export interface BranchRow {
  id: string;
  name: string;
  code: string | null;
  city: string | null;
  isPrimary: boolean;
  memberCount: number;
}

/**
 * The gym's branches.
 *
 * Confined to the ones the actor works at when their scope is branch-level:
 * a manager at one branch has no business listing the others, and offering
 * them as a transfer destination would be worse than useless.
 */
export async function listBranches(
  ctx: { organizationId: string; userId: string; branchIds?: string[] },
  permissions: ResolvedPermissions,
): Promise<BranchRow[]> {
  requirePermission(permissions, 'org.branch.read');
  const scope = scopeOf(permissions, 'org.branch.read');

  return withTenant(ctx, async (tx) => {
    const rows = await tx.branch.findMany({
      // Bounded: more than 100 branches for one gym is a data
      // problem, and a truncated list beats a request that times out.
      take: 100,
      where: {
        deletedAt: null,
        ...(scope === 'BRANCH' && (ctx.branchIds ?? []).length > 0
          ? { id: { in: ctx.branchIds! } }
          : {}),
      },
      orderBy: [{ isPrimary: 'desc' }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        code: true,
        city: true,
        isPrimary: true,
        _count: { select: { members: { where: { deletedAt: null } } } },
      },
    });

    return rows.map((row: any) => ({
      id: row.id,
      name: row.name,
      code: row.code,
      city: row.city,
      isPrimary: row.isPrimary,
      memberCount: row._count.members,
    }));
  });
}

/**
 * Adds a branch, within what the gym's plan allows.
 *
 * The limit is enforced here rather than in the interface, because the
 * interface is not where a SaaS plan is sold or bypassed. A gym that has
 * reached its limit is told which plan carries more rather than meeting a
 * flat refusal — the same reasoning as a feature outside the plan.
 */
export async function createBranch(
  ctx: { organizationId: string; userId: string },
  permissions: ResolvedPermissions,
  input: {
    name: string;
    code?: string;
    city?: string;
    addressLine1?: string;
    phone?: string;
    timezone?: string;
    openingTime?: string;
    closingTime?: string;
  },
  meta: { ipAddress?: string } = {},
): Promise<{ id: string }> {
  requirePermission(permissions, 'org.branch.create');

  return withTenant(ctx, async (tx) => {
    const subscription = await tx.tenantSubscription.findFirst({
      select: { platformPlan: { select: { name: true, maxBranches: true } } },
    });

    const existing = await tx.branch.count({ where: { deletedAt: null } });
    const limit = subscription?.platformPlan.maxBranches ?? null;

    if (limit !== null && existing >= limit) {
      throw new AppError(
        'PLAN_LIMIT_REACHED',
        `The ${subscription!.platformPlan.name} plan covers ${limit} ${
          limit === 1 ? 'branch' : 'branches'
        }. A higher plan is needed for another.`,
      );
    }

    if (input.code) {
      const clash = await tx.branch.findFirst({
        where: { code: input.code.trim().toUpperCase(), deletedAt: null },
        select: { id: true },
      });
      if (clash) {
        throw new AppError('CONFLICT', `Another branch already uses the code ${input.code.trim()}.`);
      }
    }

    const branch = await tx.branch.create({
      data: {
        organizationId: ctx.organizationId,
        name: input.name.trim(),
        code: input.code?.trim().toUpperCase() || null,
        city: input.city?.trim() || null,
        addressLine1: input.addressLine1?.trim() || null,
        phone: input.phone?.trim() || null,
        timezone: input.timezone?.trim() || 'Asia/Kolkata',
        openingTime: input.openingTime || null,
        closingTime: input.closingTime || null,
        // The first branch is the primary one; a later one never silently
        // takes that over, because the primary is the fallback everywhere.
        isPrimary: existing === 0,
      },
      select: { id: true },
    });

    await writeAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'org.branch.create',
      entityType: 'Branch',
      entityId: branch.id,
      summary: `Added the branch ${input.name.trim()}`,
      ipAddress: meta.ipAddress,
    });

    return branch;
  });
}

export async function updateBranch(
  ctx: { organizationId: string; userId: string },
  permissions: ResolvedPermissions,
  branchId: string,
  input: {
    name?: string;
    code?: string | null;
    city?: string | null;
    addressLine1?: string | null;
    phone?: string | null;
    timezone?: string;
    openingTime?: string | null;
    closingTime?: string | null;
    isActive?: boolean;
  },
  meta: { ipAddress?: string } = {},
): Promise<void> {
  requirePermission(permissions, 'org.branch.update');

  await withTenant(ctx, async (tx) => {
    const branch = await tx.branch.findFirst({
      where: { id: branchId, deletedAt: null },
      select: { id: true, name: true, isPrimary: true },
    });
    if (!branch) throw new AppError('NOT_FOUND', 'That branch was not found.');

    // Closing the only branch, or the primary one, would leave members and
    // staff pointing at somewhere that no longer takes them.
    if (input.isActive === false) {
      if (branch.isPrimary) {
        throw new AppError(
          'CONFLICT',
          'The main branch cannot be closed. Make another branch the main one first.',
        );
      }
      const members = await tx.member.count({ where: { branchId, deletedAt: null } });
      if (members > 0) {
        throw new AppError(
          'CONFLICT',
          `${members} ${members === 1 ? 'member trains' : 'members train'} at this branch. Move them first.`,
        );
      }
    }

    await tx.branch.update({
      where: { id: branchId },
      data: {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.code !== undefined ? { code: input.code?.trim().toUpperCase() || null } : {}),
        ...(input.city !== undefined ? { city: input.city?.trim() || null } : {}),
        ...(input.addressLine1 !== undefined
          ? { addressLine1: input.addressLine1?.trim() || null }
          : {}),
        ...(input.phone !== undefined ? { phone: input.phone?.trim() || null } : {}),
        ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
        ...(input.openingTime !== undefined ? { openingTime: input.openingTime } : {}),
        ...(input.closingTime !== undefined ? { closingTime: input.closingTime } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
    });

    await writeAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'org.branch.update',
      entityType: 'Branch',
      entityId: branchId,
      summary: `Edited the branch ${branch.name}`,
      ipAddress: meta.ipAddress,
    });
  });
}
