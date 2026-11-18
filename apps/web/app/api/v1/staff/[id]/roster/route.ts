import { trainerRoster } from '@gym/core';
import { route } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

export const GET = route({ permission: 'members.member.read' }, async ({ actor, params }) =>
  trainerRoster(tenantOf(actor), actor.permissions, params.id!),
);
