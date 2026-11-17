import { withTenant } from '@gym/db';
import { AppError } from '../errors';
import { writeAudit } from '../audit/log';
import type { ResolvedPermissions } from '../rbac/engine';
import { requirePermission } from '../rbac/engine';

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
