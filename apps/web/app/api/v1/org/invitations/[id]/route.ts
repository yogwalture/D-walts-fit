import { NextResponse } from 'next/server';
import { revokeInvitation } from '@gym/core';
import { route } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

export const DELETE = route(
  { permission: 'org.user.invite' },
  async ({ actor, params, ipAddress }) => {
    await revokeInvitation(tenantOf(actor), actor.permissions, params.id!, { ipAddress });
    return NextResponse.json({ data: { revoked: true } }, { status: 200 });
  },
);
