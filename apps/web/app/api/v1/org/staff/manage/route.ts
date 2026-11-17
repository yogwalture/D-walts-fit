import { NextResponse } from 'next/server';
import { changeStaffRoleInput, setStaffStatusInput } from '@gym/contracts';
import { changeStaffRole, setStaffStatus } from '@gym/core';
import { route } from '@/lib/handler';

export const dynamic = 'force-dynamic';

/** Suspend or reactivate a staff account. Suspension cuts their sessions. */
export const POST = route(
  { permission: 'org.user.update', schema: setStaffStatusInput },
  async ({ input, actor, ipAddress }) => {
    await setStaffStatus(
      { organizationId: actor.organizationId!, userId: actor.userId },
      actor.permissions,
      { orgUserId: input.orgUserId, status: input.status, ipAddress },
    );
    return NextResponse.json({ data: { ok: true } }, { status: 200 });
  },
);

export const PUT = route(
  { permission: 'org.user.update', schema: changeStaffRoleInput },
  async ({ input, actor, ipAddress }) => {
    await changeStaffRole(
      { organizationId: actor.organizationId!, userId: actor.userId },
      actor.permissions,
      { orgUserId: input.orgUserId, roleId: input.roleId, ipAddress },
    );
    return NextResponse.json({ data: { ok: true } }, { status: 200 });
  },
);
