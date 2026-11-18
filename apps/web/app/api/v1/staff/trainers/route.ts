import { listTrainers } from '@gym/core';
import { route } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

/** Who can be given a member, by what their role can do — not by role name. */
export const GET = route({ permission: 'staff.profile.read' }, async ({ actor }) =>
  listTrainers(tenantOf(actor), actor.permissions),
);
