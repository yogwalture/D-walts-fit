import { NextResponse } from 'next/server';
import { inviteStaffInput, pageQuery } from '@gym/contracts';
import { inviteStaff, listStaff } from '@gym/core';
import { getEmailProvider, staffInvitationEmail } from '@gym/integrations';
import { route, paged } from '@/lib/handler';

export const dynamic = 'force-dynamic';

export const GET = route(
  { permission: 'org.user.read', source: 'query', schema: pageQuery },
  async ({ input, actor }) => {
    const { rows, total } = await listStaff(
      { organizationId: actor.organizationId!, userId: actor.userId },
      actor.permissions,
      { page: input.page, pageSize: input.pageSize, search: input.search },
    );
    return NextResponse.json(paged(rows, total, input.page, input.pageSize), { status: 200 });
  },
);

/**
 * Invite a staff member.
 *
 * The administrator never sets the password. They issue an invitation; the
 * person sets their own when they accept. That one rule removes shared
 * credentials, passwords sent over WhatsApp, and a manager who knows the
 * accountant's login.
 */
export const POST = route(
  { permission: 'org.user.invite', schema: inviteStaffInput },
  async ({ input, actor, ipAddress, userAgent }) => {
    const result = await inviteStaff({
      organizationId: actor.organizationId!,
      email: input.email,
      fullName: input.fullName,
      roleId: input.roleId,
      branchIds: input.branchIds,
      invitedByUserId: actor.userId,
      ipAddress,
      userAgent,
    });

    await getEmailProvider().send(
      staffInvitationEmail({
        to: result.email,
        fullName: result.fullName,
        gymName: 'your gym',
        roleName: 'a team member',
        invitedBy: 'Your gym',
        token: result.token,
      }),
    );

    return NextResponse.json(
      {
        data: {
          email: result.email,
          expiresAt: result.expiresAt.toISOString(),
          message: `Invitation sent to ${result.email}.`,
        },
      },
      { status: 201 },
    );
  },
);
