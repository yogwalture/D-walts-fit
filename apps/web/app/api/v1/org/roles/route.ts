import { NextResponse } from 'next/server';
import { listAssignableRoles } from '@gym/core';
import { route } from '@/lib/handler';

export const dynamic = 'force-dynamic';

export const GET = route({ permission: 'org.role.read' }, async ({ actor }) => {
  const roles = await listAssignableRoles({
    organizationId: actor.organizationId!,
    userId: actor.userId,
  });
  return NextResponse.json({ data: roles }, { status: 200 });
});
